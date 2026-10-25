#!/usr/bin/env python3
"""Keychain-backed worker token lifecycle; no third-party Python dependencies."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


class OperationError(Exception):
    pass


def execute(command, **kwargs):
    # Capture errors too: a credential-manager failure must not echo its input.
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=kwargs.pop('timeout', 180), **kwargs)
    except (OSError, subprocess.TimeoutExpired):
        raise OperationError('Command unavailable or timed out; check Docker/Keychain access.') from None
    if result.returncode:
        raise OperationError('Command failed; check Docker/Keychain access and existing items.')
    return result.stdout


def credential_name(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value):
        raise argparse.ArgumentTypeError('Use a simple account/service name without spaces.')
    return value


def worker_token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', value):
        raise OperationError('Invalid worker credential.')
    return value


def store(account, service, stream):
    try:
        document = json.loads(stream.read(4097))
        if set(document) != {'workerToken'}:
            raise ValueError()
        token = worker_token(document['workerToken'])
    except (ValueError, TypeError, KeyError):
        raise OperationError('Provide worker-secrets JSON through standard input.') from None
    # security's interactive protocol accepts commands on stdin. No token in argv,
    # no shell, no verbose mode, no default application trust, no item overwrite.
    command = f'add-generic-password -a {account} -s {service} -T "" -w {token}\n'
    execute(['/usr/bin/security', '-i'], input=command)


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise OperationError('Use an owned, mode-0700 private directory, without symlinks.')


def remove_secret(path):
    if path.is_symlink():
        raise OperationError('Unexpected symlink at the runtime credential path.')
    if path.exists():
        if not path.is_file():
            raise OperationError('Unexpected runtime credential path.')
        path.unlink()


def operate(action, account, service, environment):
    env = dict(environment)
    required = ['OYA_LOCAL_DIR', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME']
    if any(not env.get(key) for key in required):
        raise OperationError('Source the local worker compose.env first.')
    directory = Path(env['OYA_LOCAL_DIR']).absolute()
    private_directory(directory)
    runtime = directory / '.keychain-runtime'
    runtime.mkdir(mode=0o700, exist_ok=True)
    private_directory(runtime)
    secret = runtime / 'worker.json'
    env['OYA_WORKER_SECRET_FILE'] = str(secret)
    overlay = str(Path(__file__).resolve().parent.parent / 'inbox/compose.keychain-worker.yaml')
    files = env['COMPOSE_FILE'].split(os.pathsep)
    if overlay not in files:
        files.append(overlay)
    env['COMPOSE_FILE'] = os.pathsep.join(files)
    # Lock is released by the OS even after a crash. Refuse symlink lock files.
    descriptor = os.open(runtime / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperationError('Another worker lifecycle operation is in progress.') from None
        def compose(*arguments):
            return execute(['docker', 'compose', *arguments], env=env, timeout=240)
        compose('config', '--quiet')
        # Check Docker before reading Keychain. Do not create plaintext if offline.
        container = compose('ps', '--all', '--quiet', 'node').strip()
        if action == 'start' and container:
            details = json.loads(execute(['docker', 'inspect', '--format',
                '{"running":{{json .State.Running}},"restart":{{json .HostConfig.RestartPolicy.Name}}}', container]))
            if details['running']:
                if details['restart'] != 'no':
                    raise OperationError('Stop the existing worker before switching to Keychain startup.')
                remove_secret(secret)
                print('Worker already running; Keychain was not accessed.')
                return
        compose('stop', 'node')
        compose('rm', '--force', 'node')
        remove_secret(secret)
        if action == 'stop':
            print('Worker stopped and removed; temporary credential removed. Kubo remains available.')
            return
        token = worker_token(execute(['/usr/bin/security', 'find-generic-password',
            '-a', account, '-s', service, '-w']).strip())
        try:
            with open(secret, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                json.dump({'workerToken': token}, output)
            compose('up', '-d', '--wait', '--wait-timeout', '120', 'node')
        except BaseException:
            # A failed startup must not leave an unverified worker processing jobs.
            try:
                compose('stop', 'node')
                compose('rm', '--force', 'node')
            except OperationError:
                print('Could not confirm worker shutdown; inspect Docker before retrying.', file=sys.stderr)
            raise
        finally:
            remove_secret(secret)
        print('Worker healthy; temporary host credential removed. Use this helper after stopping or rebooting.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['store', 'start', 'stop'])
    parser.add_argument('--account', required=True, type=credential_name)
    parser.add_argument('--service', required=True, type=credential_name)
    args = parser.parse_args()
    if sys.platform != 'darwin' or os.getuid() == 0:
        raise OperationError('Run this helper as a non-root macOS user.')
    os.umask(0o077)
    if args.action == 'store':
        store(args.account, args.service, sys.stdin)
        print('Worker token stored in Keychain; no plaintext file written.')
    else:
        operate(args.action, args.account, args.service, os.environ)


if __name__ == '__main__':
    try:
        main()
    except (OperationError, OSError, ValueError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, OperationError) else 'Operation interrupted or failed; check private state before retrying.', file=sys.stderr)
        sys.exit(1)
