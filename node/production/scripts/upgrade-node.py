#!/usr/bin/env python3
"""Upgrade one existing released inbox or worker, without replacing its state.

Python 3.9+ standard library, Docker Compose 2.30+, Linux/macOS. Run from a trusted
checkout or bundle. Preview downloads public verification data into a private,
automatically removed temporary directory; it never pulls or stops containers,
writes saved settings, or accesses Keychain. Apply retains public release assets
and private recovery records under the installation's .oya-upgrades directory.

Protocol: preview both hosts; quiesce EVERY worker; apply inbox with the explicit
--workers-stopped acknowledgement; verify existing job status and public HTTPS;
apply each worker with --inbox-ready RELEASE. These acknowledgements are operator
assertions, not remote discovery. The CLI checks local container health only.

Supported: one worker with Kubo, or one inbox with bundled PostgreSQL and optional
proxy, using saved literal Compose exports and read-only private file mounts.
Custom overrides are retained, but any changed service model beyond the selected
image and same-release public paths fails closed. External databases, direct
nodes, Compose hooks/builds/profiles, and remote Docker engines are unsupported.

Never restore a database or retry a job to recover an upgrade. A failed mutation
leaves a blocking active.json and retained journal. Reconcile transaction
checkpoints and verify affected services are stopped before an operator archives
that marker (retain the attempt directory) and deliberately retries.
"""
import argparse
import contextlib
import copy
import datetime
import fcntl
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid
from typing import Any, NoReturn

REPOSITORY = 'oyaprotocol/oya-commitments'
SOURCE = 'https://github.com/' + REPOSITORY
IMAGE_REPOSITORY = 'ghcr.io/oyaprotocol/oya-node'
TAG = r'node-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
DIGEST = r'sha256:[0-9a-f]{64}'
IMAGE = re.escape(IMAGE_REPOSITORY) + '@' + DIGEST
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
PUBLIC_FILES = {
    'node/production/' + name for name in (
        'compose.yaml', 'README.md', 'deploy-droplet.md', 'run-locally.md',
        'run-direct.md', 'host-inbox.md', 'inbox-api.md', 'deploy-with-agent.md',
        'release-image.md', 'testnet-ledger.md', 'upgrade-node.md', 'image.txt',
        'docker/compose.http.yaml', 'docker/Caddyfile', 'docker/compose.testing.yaml',
        'docker/config.example.json', 'docker/runtime.env.example',
        'inbox/compose.yaml', 'inbox/compose.postgres.yaml', 'inbox/compose.https.yaml',
        'inbox/compose.worker.yaml', 'inbox/compose.keychain-worker.yaml',
        'inbox/Caddyfile', 'inbox/inbox.example.json', 'inbox/worker.example.json',
        'scripts/deploy-droplet.sh', 'scripts/deploy-droplet-remote.sh',
        'scripts/keychain-worker.py', 'scripts/upgrade-node.py',
    )
} | {'agent-library/agents/hourly-message-test/agent.mjs'}
ROLE_FILES = {
    'worker': {'node/production/inbox/compose.worker.yaml',
               'node/production/inbox/compose.keychain-worker.yaml'},
    'inbox': {'node/production/inbox/compose.yaml',
              'node/production/inbox/compose.postgres.yaml',
              'node/production/inbox/compose.https.yaml'},
}


class UpgradeError(Exception):
    """Sanitized actionable operator error; never include child output."""


def reject(message) -> NoReturn:
    raise UpgradeError(message)


def require(condition, message):
    if not condition:
        reject(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def command(args, env, *, timeout=180, input=None, stdout=None):
    try:
        result = subprocess.run(args, env=env, input=input, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise UpgradeError('Command unavailable or timed out; inspect Docker and the private journal.') from None
    require(result.returncode == 0, 'Command failed; inspect Docker and the private journal. Raw output withheld.')
    return result.stdout or b''


def json_command(args, env):
    try:
        return json.loads(command(args, env))
    except (ValueError, TypeError):
        raise UpgradeError('Docker returned invalid inspection data.') from None


def private(path, directory=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'Use owned, private directories (0700) and files (0600), without symlinks.')


def regular(path, limit=MAX_FILE):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit,
            'Expected a bounded regular file, without symlinks.')
    return path.read_bytes()


def atomic(path, data):
    # A same-directory exclusive temporary file plus fsync makes the rename durable.
    fd, temporary = tempfile.mkstemp(prefix='.upgrade-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_tree(path):
    """Persist recovery/artifact files and directory entries before selectors."""
    for directory, subdirs, files in os.walk(path, topdown=False):
        for name in files:
            file = Path(directory) / name
            require(stat.S_ISREG(file.lstat().st_mode), 'Recovery tree contains an unexpected file type.')
            with file.open('rb') as stream:
                os.fsync(stream.fileno())
        for name in subdirs:
            require(not (Path(directory) / name).is_symlink(), 'Recovery tree contains an unexpected link.')
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def failure_details(error, stage):
    category = ('interrupted' if isinstance(error, KeyboardInterrupt) else
                'filesystem' if isinstance(error, OSError) else
                'command-or-validation' if isinstance(error, UpgradeError) else 'unexpected')
    return {'failed_stage': stage, 'error_category': category}


def write_json(path, value):
    atomic(path, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())


def literal_export(value, inherited_path=None):
    """Shell quote removal for one literal assignment; never evaluate shell code."""
    result, quote, index = [], None, 0
    while index < len(value):
        char = value[index]
        if quote == "'":
            if char == "'":
                quote = None
            else:
                result.append(char)
        elif char == '\\':
            index += 1
            require(index < len(value), 'Invalid trailing escape in compose.env.')
            escaped = value[index]
            if quote == '"' and escaped not in '\\"$`':
                result.append('\\')
            result.append(escaped)
        elif char == '$' and inherited_path is not None:
            match = re.match(r'\$(?:\{PATH\}|PATH(?![A-Za-z0-9_]))', value[index:])
            if match is None:
                reject('Only inherited $PATH/${PATH} expansion is supported in a PATH export.')
            result.append(inherited_path)
            index += len(match.group()) - 1
        elif char in '$`' or (quote is None and char in ';|&<>()~'):
            reject('Save literal expanded values in compose.env (printf %q); shell expansions are unsupported.')
        elif char == quote:
            quote = None
        elif quote is None and char in "'\"":
            quote = char
        elif quote is None and char.isspace():
            remainder = value[index:].lstrip()
            require(not remainder or remainder.startswith('#'), 'Each compose.env export must be one quoted or escaped literal.')
            break
        else:
            result.append(char)
        index += 1
    require(quote is None and '\x00' not in value, 'Invalid quoting in compose.env.')
    return ''.join(result)


def read_exports(path, inherited):
    """Accept printf %q-style literals, not executable shell or substitutions."""
    private(path)
    raw = regular(path)
    env, assignments = dict(inherited), {}
    for number, line in enumerate(raw.decode('utf-8').splitlines(keepends=True)):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?:\r?\n)?', line)
        if match is None:
            reject('compose.env must contain only literal KEY=value exports and comments.')
        key, value = match.groups()
        require(key not in assignments, 'Duplicate export in compose.env; reconcile it before upgrading.')
        env[key] = literal_export(value, inherited.get('PATH', '') if key == 'PATH' else None)
        assignments[key] = number
    for key in inherited:
        if key.startswith(('OYA_', 'COMPOSE_', 'DOCKER_')) and key not in assignments:
            require(key in {'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'},
                    'Save inherited OYA_/COMPOSE_ overrides in compose.env before upgrading.')
    return raw, env, assignments


def replace_exports(raw, assignments, replacements):
    lines = raw.decode('utf-8').splitlines(keepends=True)
    for key, value in replacements.items():
        require(key in assignments, 'Required selection must already be saved in compose.env: ' + key)
        lines[assignments[key]] = 'export ' + key + '=' + shlex.quote(value) + '\n'
    return ''.join(lines).encode()


def fetch(url, limit, headers=None):
    require(url.startswith('https://'), 'Release retrieval requires HTTPS.')
    request = urllib.request.Request(url, headers={'User-Agent': 'oya-release-upgrade', **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            require(response.geturl().startswith('https://'), 'Refusing non-HTTPS redirect.')
            data = response.read(limit + 1)
    except (OSError, ValueError):
        raise UpgradeError('Release retrieval failed; check network access to GitHub/GHCR.') from None
    require(len(data) <= limit, 'Release response exceeds the verification size limit.')
    return data


def checked_digest(data, digest):
    require(isinstance(digest, str) and re.fullmatch(DIGEST, digest) is not None
            and 'sha256:' + sha(data) == digest, 'Release checksum or registry digest mismatch.')


def safe_extract(archive, destination):
    # Bound gzip expansion as well as declared file sizes, including tar padding.
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
            expanded = stream.read(MAX_EXPANDED + 1)
        require(len(expanded) <= MAX_EXPANDED, 'Expanded archive exceeds the size limit.')
        with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as tar:
            seen, total = set(), 0
            members = []
            for member in tar:
                require(len(members) < 256, 'Archive contains too many members.')
                name = member.name
                while name.startswith('./'):
                    name = name[2:]
                if name in ('', '.') and member.isdir():
                    continue
                path = PurePosixPath(name)
                require(not path.is_absolute() and '..' not in path.parts and '\\' not in name,
                        'Unsafe archive path.')
                name = str(path)
                require(name not in seen, 'Duplicate archive path.')
                seen.add(name)
                require(member.isdir() or member.isfile(), 'Archive links and special files are forbidden.')
                require(not member.pax_headers, 'Extended archive metadata is unsupported.')
                require(not member.mode & 0o7000 and 0 <= member.size <= MAX_FILE,
                        'Unsafe archive mode or file size.')
                require((member.isdir() and any(p.startswith(name + '/') for p in PUBLIC_FILES))
                        or (member.isfile() and name in PUBLIC_FILES),
                        'Unknown release asset; review packaging before using this upgrader.')
                total += member.size
                require(total <= MAX_EXPANDED, 'Archive file sizes exceed the size limit.')
                members.append((member, name))
            for member, name in members:
                target = destination / name
                target.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
                if member.isdir():
                    target.mkdir(mode=0o755, exist_ok=True)
                else:
                    stream = tar.extractfile(member)
                    if stream is None:
                        reject('Archive regular file has no readable contents.')
                    with stream, target.open('xb') as output:
                        shutil.copyfileobj(stream, output)
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
            # Public bind-mounted assets must remain readable under umask 077.
            for directory, _, _ in os.walk(destination):
                Path(directory).chmod(0o755)
    except (tarfile.TarError, EOFError, OSError):
        raise UpgradeError('Cannot safely read the release archive.') from None


def release_assets(tag, destination):
    metadata = json.loads(fetch('https://api.github.com/repos/' + REPOSITORY + '/releases/tags/' + tag, MAX_FILE))
    require(metadata.get('tag_name') == tag and not metadata.get('draft') and not metadata.get('prerelease'),
            'Release tag mismatch, draft, or prerelease; choose a published stable release.')
    archive_name = 'oya-' + tag + '.tar.gz'
    wanted = {'image.txt', 'release.txt', archive_name}
    assets = {a['name']: a for a in metadata.get('assets', []) if a.get('name') in wanted}
    require(set(assets) == wanted, 'Release is missing required assets.')
    require(sum(a.get('name') in wanted for a in metadata['assets']) == 3, 'Duplicate release assets.')
    data = {}
    for name, asset in assets.items():
        url = SOURCE + '/releases/download/' + tag + '/' + name
        require(asset.get('browser_download_url') == url, 'Unexpected release asset URL.')
        data[name] = fetch(url, MAX_ARCHIVE if name == archive_name else 4096)
        checked_digest(data[name], asset.get('digest'))
        require(asset.get('size') == len(data[name]), 'Release asset size mismatch.')
    body = metadata.get('body', '')
    require(re.search(r'(?<![0-9a-f])' + sha(data[archive_name]) + r'(?![0-9a-f])', body) is not None,
            'Published release notes do not contain the verified archive SHA-256.')
    image = data['image.txt'].decode().strip()
    require(re.fullmatch(IMAGE, image) is not None, 'Release image must be the official immutable GHCR digest.')
    manifest = data['release.txt'].decode()
    match = re.fullmatch(r'Git tag: (' + TAG + r')\nGit commit: ([0-9a-f]{40})\nImage: (' + IMAGE + r')\n?', manifest)
    require(match is not None, 'Invalid release.txt manifest.')
    # Named line parsing avoids depending on capture groups in the tag grammar.
    fields = dict(line.split(': ', 1) for line in manifest.strip().splitlines())
    require(fields['Git tag'] == tag and fields['Image'] == image and manifest.strip() in body,
            'Release manifest identity does not match the selected tag, image, or published notes.')
    bundle = destination / 'bundle'
    bundle.mkdir(mode=0o755)
    safe_extract(data[archive_name], bundle)
    require(regular(bundle / 'node/production/image.txt').decode().strip() == image,
            'Archive image pin differs from release manifest.')
    for name, content in data.items():
        (destination / name).write_bytes(content)
    return {'tag': tag, 'commit': fields['Git commit'], 'image': image,
            'archive_sha256': sha(data[archive_name]), 'bundle': str(bundle)}


def registry_identity(release, platform):
    """Read manifests/config directly: no image pull, container, or credential store."""
    require(platform in {'linux/amd64', 'linux/arm64'}, 'Unsupported node platform.')
    repository = IMAGE_REPOSITORY.removeprefix('ghcr.io/')
    token_url = 'https://ghcr.io/token?' + urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + repository + ':pull'})
    token = json.loads(fetch(token_url, 65536)).get('token')
    require(isinstance(token, str), 'GHCR did not supply public read access.')
    headers = {'Authorization': 'Bearer ' + token,
               'Accept': ', '.join(['application/vnd.oci.image.index.v1+json',
                                    'application/vnd.oci.image.manifest.v1+json',
                                    'application/vnd.docker.distribution.manifest.list.v2+json',
                                    'application/vnd.docker.distribution.manifest.v2+json'])}
    base = 'https://ghcr.io/v2/' + repository
    def blob(kind, digest):
        require(re.fullmatch(DIGEST, digest) is not None, 'Invalid registry descriptor.')
        data = fetch(base + '/' + kind + '/' + digest, MAX_FILE, headers)
        checked_digest(data, digest)
        return json.loads(data)
    manifest = blob('manifests', release['image'].split('@')[1])
    if 'manifests' in manifest:
        matches = [m for m in manifest['manifests'] if
                   m.get('platform', {}).get('os', '') + '/' + m.get('platform', {}).get('architecture', '') == platform]
        require(len(matches) == 1, 'Release has no unique manifest for the selected platform.')
        manifest = blob('manifests', matches[0]['digest'])
    config_digest = manifest['config']['digest']
    config = blob('blobs', config_digest)
    require(config.get('os', '') + '/' + config.get('architecture', '') == platform, 'Image platform mismatch.')
    validate_labels(config.get('config', {}).get('Labels', {}), release)
    return config_digest


def validate_labels(labels, release):
    require(all(labels.get('org.opencontainers.image.' + key) == value for key, value in {
        'source': SOURCE, 'revision': release['commit'], 'version': release['tag'][5:],
    }.items()), 'Image source/revision/version labels do not match the selected release.')


def remap(value: Any, old: str, new: str) -> Any:
    if isinstance(value, str):
        return new + value[len(old):] if value == old or value.startswith(old + '/') else value
    if isinstance(value, list):
        return [remap(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: remap(v, old, new) for k, v in value.items()}
    return value


def compose(env, *arguments, **kwargs):
    return command(['docker', 'compose', *arguments], env, **kwargs)


def render(env):
    return json.loads(compose(env, 'config', '--no-env-resolution', '--format', 'json'))


def load_installation(args):
    env_path = Path(args.env_file).absolute()
    private(env_path.parent, directory=True)
    raw, env, assignments = read_exports(env_path, os.environ)
    directory_key = 'OYA_LOCAL_DIR' if args.role == 'worker' else 'OYA_INBOX_DIR'
    required = {directory_key, 'OYA_BUNDLE_DIR', 'OYA_NODE_IMAGE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE'}
    require(required <= assignments.keys(), 'Save bundle, immutable image, private directory, project and Compose files in compose.env.')
    directory = Path(env[directory_key])
    require(directory.is_absolute() and directory == env_path.parent,
            'compose.env must live in the selected absolute private installation directory.')
    old_bundle = Path(env['OYA_BUNDLE_DIR'])
    require(old_bundle.is_absolute() and old_bundle.is_dir() and not old_bundle.is_symlink(), 'Invalid old bundle directory.')
    require(re.fullmatch(IMAGE, env['OYA_NODE_IMAGE']) is not None, 'Existing image must be a released immutable Oya digest.')
    require(regular(old_bundle / 'node/production/image.txt').decode().strip() == env['OYA_NODE_IMAGE'],
            'Saved old image and old bundle image.txt disagree.')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]*', env['COMPOSE_PROJECT_NAME']) is not None, 'Invalid Compose project name.')
    require(env.get('COMPOSE_PATH_SEPARATOR', ':') == ':' and not env.get('COMPOSE_PROFILES'),
            'Compose profiles and custom path separators are unsupported.')
    require(not env.get('COMPOSE_ENV_FILES'), 'Compose environment-file indirection is unsupported; save literal exports in compose.env.')
    files = env['COMPOSE_FILE'].split(':')
    require(files and len(files) == len(set(files)), 'Duplicate or empty Compose file selection.')
    for file in files:
        path = Path(file)
        require(path.is_absolute(), 'Save absolute Compose file paths before upgrading.')
        regular(path)
        if path.is_relative_to(old_bundle):
            require(path.relative_to(old_bundle).as_posix() in ROLE_FILES[args.role], 'Unsupported role/Compose asset in old bundle.')
        # Custom expansion variables must be saved too, not silently inherited.
        variables = re.findall(r'(?<!\$)\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)', path.read_text())
        require(not any(key in env and key not in assignments for key in variables),
                'Save every inherited Compose interpolation override in compose.env.')
    expected = 'node/production/inbox/' + ('compose.worker.yaml' if args.role == 'worker' else 'compose.yaml')
    require(str(old_bundle / expected) in files, 'Select the released base Compose file for this role.')
    require(env.get('COMPOSE_DISABLE_ENV_FILE') in {'1', 'true'} or not any(
                (directory / '.env').exists() for directory in {Path.cwd(), Path(files[0]).parent}),
            'Implicit Compose .env files are unsupported; save their selection as literal compose.env exports first.')
    # Pin the currently selected context for every child, including helper inspect.
    context = command(['docker', 'context', 'show'], env).decode().strip()
    require(bool(context), 'Cannot determine Docker context.')
    details = json_command(['docker', 'context', 'inspect', context], env)
    host = details[0]['Endpoints']['docker']['Host']
    require(not env.get('DOCKER_HOST') or env['DOCKER_HOST'] == host,
            'DOCKER_HOST conflicts with the selected context; save one unambiguous Docker context.')
    require(host.startswith('unix://') and not env.get('DOCKER_TLS_VERIFY'),
            'Run this CLI on the installation host with a local Unix-socket Docker context.')
    env['DOCKER_CONTEXT'] = context
    env.pop('DOCKER_HOST', None)
    daemon = json_command(['docker', 'info', '--format', '{{json .}}'], env)
    require(daemon.get('OSType') == 'linux', 'Use a Linux Docker daemon for the released node image.')
    return {'path': env_path, 'raw': raw, 'env': env, 'assignments': assignments,
            'directory': directory, 'old_bundle': old_bundle, 'files': files,
            'service': 'node' if args.role == 'worker' else 'inbox', 'context': context,
            'docker_desktop': 'docker desktop' in daemon.get('OperatingSystem', '').lower()}


def inventory(env):
    ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + env['COMPOSE_PROJECT_NAME']], env).decode().split()
    result = {}
    if ids:
        for container in json_command(['docker', 'inspect', *ids], env):
            labels = container['Config'].get('Labels') or {}
            service = labels.get('com.docker.compose.service')
            require(service and service not in result and labels.get('com.docker.compose.oneoff', '').lower() == 'false',
                    'Scaled, one-off, or unknown project containers require manual reconciliation.')
            result[service] = container
    return result


def keychain_selection(installation, args, live):
    env = installation['env']
    if args.role != 'worker':
        require(not args.keychain_account and not args.keychain_service, 'Keychain is only supported for workers.')
        return False
    runtime = installation['directory'] / '.keychain-runtime/worker.json'
    node = live.get('node', {})
    mounts = [m for m in node.get('Mounts', []) if m.get('Destination') == '/run/secrets/worker.json']
    missing_mount = bool(mounts and not Path(host_bind_source(mounts[0]['Source'], installation)).is_file())
    overlay = str(installation['old_bundle'] / 'node/production/inbox/compose.keychain-worker.yaml')
    detected = (overlay in installation['files'] or missing_mount
                or node.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') == 'no'
                or runtime.parent.exists())
    enabled = bool(args.keychain_account or args.keychain_service)
    require(not detected or enabled, 'Keychain-managed or missing worker mount detected: provide --keychain-account and --keychain-service.')
    if not enabled:
        return False
    require(args.keychain_account and args.keychain_service, 'Provide both Keychain account and service references.')
    require(sys.platform == 'darwin' and os.getuid() != 0, 'Keychain lifecycle requires a non-root macOS user.')
    require(not mounts or host_bind_source(mounts[0]['Source'], installation) == str(runtime),
            'Unsupported Keychain mount; retain the existing helper runtime layout.')
    require(not node or node.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') == 'no',
            'Switching credential modes is a separate operation; existing Keychain worker must have restart=no.')
    env['OYA_WORKER_SECRET_FILE'] = str(runtime)
    if overlay not in installation['files']:
        env['COMPOSE_FILE'] += ':' + overlay
    return True


def validate_model(model, installation, role, keychain):
    selected = installation['service']
    env = installation['env']
    services = model.get('services', {})
    require(model.get('name') == env['COMPOSE_PROJECT_NAME'], 'Rendered Compose project differs from saved selection.')
    allowed = {'node', 'ipfs'} if role == 'worker' else {'inbox', 'postgres', 'proxy'}
    required = {'node', 'ipfs'} if role == 'worker' else {'inbox', 'postgres'}
    require(required <= services.keys() <= allowed, 'Unsupported topology: require worker+Kubo or inbox+bundled PostgreSQL, optionally proxy.')
    require(not model.get('secrets') and not model.get('configs'), 'Compose secrets/config objects are unsupported; use existing read-only file mounts.')
    for name, service in services.items():
        require(not any(service.get(k) for k in ('build', 'develop', 'post_start', 'pre_stop', 'profiles', 'volumes_from', 'env_file')),
                'Builds, hooks, profiles and indirect mounts are unsupported.')
        require(service.get('scale', 1) == 1 and service.get('deploy', {}).get('replicas', 1) == 1, 'Scaled services are unsupported.')
        require(not service.get('network_mode') and not service.get('privileged'), 'Unsupported service isolation.')
        for mount in service.get('volumes', []):
            require(mount.get('type') in {'bind', 'volume'} and mount.get('source'), 'Anonymous or unsupported storage is forbidden.')
            if mount['type'] == 'bind':
                require(mount.get('read_only') is True and Path(mount['source']).is_absolute(), 'Only absolute read-only bind mounts are supported.')
                if keychain and name == 'node' and mount['target'] == '/run/secrets/worker.json':
                    require(mount['source'] == str(installation['directory'] / '.keychain-runtime/worker.json'), 'Keychain mount mismatch.')
                else:
                    regular(Path(mount['source']))
            else:
                require(mount['source'] in model.get('volumes', {}), 'Undefined persistent volume.')
    node = services[selected]
    expected_entrypoint = ['node', '/app/src/inbox/' + ('worker.mjs' if role == 'worker' else 'main.mjs')]
    require(node.get('entrypoint') == expected_entrypoint, 'Role entrypoint mismatch; direct nodes cannot use this upgrader.')
    expected_command = ['/config/node.json', '/run/secrets/node.env', '/config/worker.json', '/run/secrets/worker.json'] if role == 'worker' else ['/config/inbox.json', '/run/secrets/inbox.json']
    require(node.get('command') == expected_command,
            'Role command must use the supported configuration/secrets paths; custom application arguments require a separate procedure.')
    require(node.get('image') == env['OYA_NODE_IMAGE'], 'Selected service image differs from saved digest.')
    require(node.get('healthcheck', {}).get('test') and not node['healthcheck'].get('disable'), 'Selected service needs a health check.')
    require(not keychain or node.get('restart') == 'no', 'Keychain worker must retain restart=no.')
    config_path = installation['directory'] / ('node.json' if role == 'worker' else 'inbox.json')
    settings = json.loads(regular(config_path))
    mode = settings.get('mode') if role == 'worker' else settings.get('execution', {}).get('mode')
    require(mode in {'ipfs', 'ledger'}, 'Set the existing execution mode explicitly before upgrading; defaults must not change identity.')
    if mode == 'ledger':
        identity = settings if role == 'worker' else settings['execution']
        fields = {'chainId', 'ledgerContract', 'rpcUrl'} if role == 'worker' else {'chainId', 'ledgerContract', 'nodeAddress'}
        require(all(identity.get(field) for field in fields),
                'Save the existing Ledger chain, contract and RPC/node identity explicitly before upgrading.')
    if role == 'inbox':
        postgres = services['postgres']
        database = postgres.get('environment', {})
        require(database.get('POSTGRES_USER') == 'oya' and database.get('POSTGRES_DB') == 'oya',
                'Automatic backup supports only the bundled oya PostgreSQL database/user.')
        secrets = json.loads(regular(installation['directory'] / 'inbox-secrets.json'))
        url = urllib.parse.urlsplit(secrets.get('databaseUrl', ''))
        require(url.scheme in {'postgres', 'postgresql'} and url.hostname == 'postgres'
                and url.username == 'oya' and url.path == '/oya' and url.port in {None, 5432}
                and not url.query and not url.fragment,
                'Inbox must use the bundled postgres/oya database; external database backup requires a separate procedure.')
    expected_mounts = {'/config/node.json': 'node.json', '/run/secrets/node.env': 'node.env',
                       '/config/worker.json': 'worker.json'} if role == 'worker' else {
                           '/config/inbox.json': 'inbox.json', '/run/secrets/inbox.json': 'inbox-secrets.json'}
    by_target = {m['target']: m for m in node.get('volumes', [])}
    for target, filename in expected_mounts.items():
        require(by_target.get(target, {}).get('source') == str(installation['directory'] / filename), 'Unexpected private configuration mount.')
    if role == 'worker':
        require('/run/secrets/worker.json' in by_target, 'Worker credential mount is missing.')
    return mode


def host_bind_source(source, installation):
    # Docker Desktop reports Linux VM paths; Engine reports literal host paths.
    # Normalize only the documented Desktop prefix, never arbitrary suffixes.
    if installation.get('docker_desktop') and source.startswith('/host_mnt/'):
        return source[len('/host_mnt'):]
    return source


def validate_ports(service, container):
    expected, actual = {}, {}
    for port in service.get('ports', []):
        key = (str(port['target']) + '/' + port.get('protocol', 'tcp'), str(port.get('published', '')))
        expected.setdefault(key, set()).add(port.get('host_ip', ''))
    for target, bindings in container.get('HostConfig', {}).get('PortBindings', {}).items():
        for binding in bindings or []:
            actual.setdefault((target, binding.get('HostPort', '')), set()).add(binding.get('HostIp', ''))
    require(actual.keys() == expected.keys(), 'Live port bindings differ from Compose.')
    for key, hosts in expected.items():
        # An unspecified host may be represented by one wildcard or both IP
        # families. Explicit loopback/address selections must remain exact.
        require((bool(actual[key]) and actual[key] <= {'', '0.0.0.0', '::'}) if hosts == {''}
                else actual[key] == hosts, 'Live port bindings differ from Compose.')


def verify_dependency_assets(old_model, new_model, selected):
    for name, service in old_model['services'].items():
        if name == selected:
            continue
        newer = {mount['target']: mount for mount in new_model['services'][name].get('volumes', [])}
        for mount in service.get('volumes', []):
            if mount['type'] == 'bind':
                require(regular(Path(mount['source'])) == regular(Path(newer[mount['target']]['source'])),
                        'Dependency public bind asset changed; upgrade that dependency separately before proceeding.')


def validate_live(model, live, installation, keychain, *, healthy=False):
    env, selected = installation['env'], installation['service']
    require(live.keys() <= model['services'].keys(), 'Live project has unknown/orphan services.')
    for name, service in model['services'].items():
        if name not in live:
            require(name == selected and keychain and not healthy, 'Expected existing service container is missing.')
            continue
        container = live[name]
        config = container['Config']
        require(config.get('Image') == service['image'], 'Live image differs from saved Compose selection.')
        for field, key in [('Entrypoint', 'entrypoint'), ('Cmd', 'command'), ('User', 'user')]:
            # Compose null inherits the image default; it is not an empty override.
            if service.get(key) is not None:
                require(config.get(field) == service[key], 'Live command/user differs from rendered Compose.')
        expected = set()
        for mount in service.get('volumes', []):
            source = mount['source'] if mount['type'] == 'bind' else model['volumes'][mount['source']]['name']
            if name != selected and mount['type'] == 'bind':
                actual_mounts = [m for m in container.get('Mounts', []) if m['Destination'] == mount['target']]
                if len(actual_mounts) == 1 and actual_mounts[0]['Type'] == 'bind':
                    retained = host_bind_source(actual_mounts[0]['Source'], installation)
                    if retained != source:
                        # A previous app-only upgrade intentionally retained proxy
                        # mounts. Accept only identical, known public bundle assets.
                        path = Path(source)
                        require(path.is_relative_to(installation['old_bundle']), 'Live private mount source changed.')
                        relative = path.relative_to(installation['old_bundle']).as_posix()
                        require(relative in PUBLIC_FILES and retained.endswith('/' + relative)
                                and regular(Path(retained)) == regular(path),
                                'Retained dependency public bind asset differs; reconcile it separately.')
                        installation.setdefault('retained_public_binds', {})[retained] = sha(regular(Path(retained)))
                        source = retained
            expected.add((mount['type'], source, mount['target'], not mount.get('read_only', False)))
        actual = {(m['Type'], m.get('Name') if m['Type'] == 'volume' else host_bind_source(m['Source'], installation), m['Destination'], m['RW'])
                  for m in container.get('Mounts', [])}
        require(actual == expected, 'Live mounts differ from rendered storage; reconcile before upgrading.')
        require(container.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') == service.get('restart', 'no'),
                'Live restart policy differs from Compose.')
        expected_networks = {model.get('networks', {}).get(key, {}).get('name', env['COMPOSE_PROJECT_NAME'] + '_' + key)
                             for key in service.get('networks', {})}
        require(set(container.get('NetworkSettings', {}).get('Networks', {})) == expected_networks,
                'Live network topology differs from Compose.')
        validate_ports(service, container)
        if name != selected or healthy:
            state = container.get('State', {})
            require(state.get('Running') and (not service.get('healthcheck') or state.get('Health', {}).get('Status') == 'healthy'),
                    'Required container is not running and healthy; repair it before continuing.')
    for value in model.get('volumes', {}).values():
        volumes = json_command(['docker', 'volume', 'inspect', value['name']], env)
        require(len(volumes) == 1 and volumes[0].get('Name') == value['name'], 'Persistent volume is missing.')
        require(volumes[0].get('Driver') == value.get('driver', 'local')
                and (volumes[0].get('Options') or {}) == value.get('driver_opts', {}), 'Live volume driver/options differ from Compose.')


def configuration_files(installation, model, keychain):
    files = {installation['path'], *map(Path, installation['files'])}
    files.update(map(Path, installation.get('retained_public_binds', {})))
    files.add(installation['old_bundle'] / 'node/production/image.txt')
    for name, service in model['services'].items():
        for mount in service.get('volumes', []):
            if mount['type'] == 'bind':
                path = Path(mount['source'])
                if keychain and name == 'node' and mount['target'] == '/run/secrets/worker.json':
                    continue
                files.add(path)
    return {str(path): sha(regular(path)) for path in sorted(files)}


def ensure_unchanged(fingerprints):
    require(all(sha(regular(Path(path))) == digest for path, digest in fingerprints.items()),
            'Configuration changed during upgrade; stopped safely. Reconcile the retained journal.')


class Journal:
    def __init__(self, directory, role, release):
        self.root = directory / '.oya-upgrades'
        self.root.mkdir(mode=0o700, exist_ok=True)
        private(self.root, directory=True)
        # Persist the root's link before any service stop or selector replacement.
        parent_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        fd = os.open(self.root / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.lock = os.fdopen(fd, 'w')
        private(self.root / 'lock')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise UpgradeError('Another upgrade/quiesce operation is running.') from None
        self.marker = self.root / 'active.json'
        if self.marker.exists() or self.marker.is_symlink():
            self.lock.close()
            raise UpgradeError('Unresolved .oya-upgrades/active.json: reconcile checkpoints and stopped services before manually archiving the marker; retain the attempt directory.')
        self.path = self.root / uuid.uuid4().hex
        self.path.mkdir(mode=0o700)
        self.data = {'schema': 1, 'role': role, 'release': release, 'created_at': now(), 'stage': 'preflight',
                     'recovery': 'No automatic rollback. Retain database checkpoints; reconcile transactions before any restore or restart.'}
        write_json(self.marker, {'attempt': self.path.name})
        self.save('preflight')

    def save(self, stage, **values):
        self.data.update(values, stage=stage, updated_at=now())
        write_json(self.path / 'journal.json', self.data)

    def complete(self, stage):
        self.save(stage)
        self.marker.unlink()

    def close(self):
        self.lock.close()


def helper_action(installation, args, bundle, env, action, require_clean=True):
    # Reuse the reviewed helper's Keychain I/O and cleanup. Scope its Compose up
    # to node only, and fix inspect context inheritance at this boundary.
    helper_path = bundle / 'node/production/scripts/keychain-worker.py'
    regular(helper_path)
    spec = importlib.util.spec_from_file_location('oya_keychain_upgrade', helper_path)
    if spec is None or spec.loader is None:
        reject('Cannot load the verified Keychain helper.')
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    def execute(arguments, **kwargs):
        selected_env = kwargs.pop('env', env)
        if arguments[:3] == ['docker', 'compose', 'up']:
            require(arguments[-1] == 'node', 'Keychain helper tried to start an unexpected service.')
            arguments = arguments[:3] + ['--no-deps', '--no-build', '--pull', 'never', '--force-recreate'] + arguments[3:]
        payload = kwargs.pop('input', None)
        result = command(arguments, selected_env, input=payload.encode() if isinstance(payload, str) else payload,
                         timeout=kwargs.pop('timeout', 240)).decode()
        if arguments[:3] == ['docker', 'compose', 'stop']:
            verify_stopped(selected_env, installation['service'], require_clean)
        return result
    setattr(module, 'execute', execute)
    try:
        # Helper prints lifecycle messages only; never print credential output.
        module.operate(action, args.keychain_account, args.keychain_service, env)
    except module.OperationError:
        raise UpgradeError('Keychain lifecycle failed; inspect the retained private journal and approve existing Keychain access if required.') from None


def verify_stopped(env, service, require_clean):
    stopped = inventory(env).get(service)
    require(not stopped or (not stopped['State'].get('Running') and not stopped['State'].get('Restarting')),
            'Shutdown is unconfirmed; STOP affected workers manually before any recovery.')
    if stopped and require_clean:
        require(stopped['State'].get('ExitCode') == 0 and not stopped['State'].get('OOMKilled'),
                'Shutdown was forced or failed; retain checkpoints and reconcile before restarting.')
    return stopped


def stop_selected(installation, args, keychain, env, bundle, require_clean=True):
    if keychain:
        helper_action(installation, args, bundle, env, 'stop', require_clean)
    else:
        compose(env, 'stop', installation['service'], timeout=300)
    return verify_stopped(env, installation['service'], require_clean)


def backup_database(journal, env):
    journal.save('backing-up-database')
    backup = journal.path / 'inbox.dump'
    with backup.open('xb') as output:
        compose(env, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'oya', '-d', 'oya', '-Fc', stdout=output, timeout=900)
        output.flush()
        os.fsync(output.fileno())
    require(backup.stat().st_size > 5, 'Database dump is empty; inbox remains stopped.')
    # Do not load a potentially large, broadcastable checkpoint backup into memory.
    with backup.open('rb') as stream:
        try:
            result = subprocess.run(['docker', 'compose', 'exec', '-T', 'postgres', 'pg_restore', '--list'],
                                    env=env, stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            raise UpgradeError('Backup verification failed; inbox remains stopped.') from None
    require(result.returncode == 0, 'pg_restore could not read the backup; inbox remains stopped.')
    digest = hashlib.sha256()
    with backup.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    journal.save('database-backed-up', backup={'file': backup.name, 'sha256': digest.hexdigest(),
                                             'verified': 'pg_restore --list', 'completed_at': now()})


def apply_upgrade(installation, args, release, old_model, new_model, new_env, keychain, fingerprints, config_digest, journal):
    old_env, service = installation['env'], installation['service']
    mutation = False
    active_env, active_bundle = old_env, installation['old_bundle']
    try:
        dependency_ids = {name: container['Id'] for name, container in inventory(old_env).items() if name != service}
        journal.save('backing-up-configuration')
        backups = journal.path / 'configuration'
        backups.mkdir(mode=0o700)
        records = []
        for index, (path, digest) in enumerate(fingerprints.items()):
            target = backups / str(index)
            target.write_bytes(regular(Path(path)))
            target.chmod(0o600)
            require(sha(regular(target)) == digest, 'Configuration backup changed while copying; no service was stopped.')
            records.append({'source': path, 'backup': str(target.relative_to(journal.path)), 'sha256': digest})
        sync_tree(backups)
        # Persist both trees before committing selectors that depend on them.
        sync_tree(Path(release['bundle']).parent)
        journal.save('configuration-backed-up', files=records,
                     old_selection={key: old_env[key] for key in ('OYA_BUNDLE_DIR', 'OYA_NODE_IMAGE', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'DOCKER_CONTEXT')},
                     environment_exports=sorted(installation['assignments']),
                     new_selection={key: new_env[key] for key in ('OYA_BUNDLE_DIR', 'OYA_NODE_IMAGE', 'COMPOSE_FILE')},
                     keychain={'managed': keychain, 'account_reference': args.keychain_account,
                               'service_reference': args.keychain_service},
                     dependency_container_ids=dependency_ids,
                     coordination={'workers_stopped': args.workers_stopped, 'inbox_ready_acknowledgement': args.inbox_ready})
        # Pull only the verified immutable Oya image, never dependencies.
        journal.save('pulling-image')
        command(['docker', 'pull', '--platform', new_model['services'][service]['platform'], release['image']], new_env, timeout=900)
        journal.save('verifying-image')
        image = json_command(['docker', 'image', 'inspect', release['image']], new_env)[0]
        image_id = image.get('Id')
        # Classic Engine IDs are config digests; containerd's image store uses
        # the pulled manifest/index digest. Both must identify verified content.
        require(image_id in {config_digest, release['image'].split('@')[1]}
                and release['image'] in image.get('RepoDigests', []),
                'Pulled image identity differs from verified registry configuration.')
        require(image.get('Os', '') + '/' + image.get('Architecture', '') == new_model['services'][service]['platform'],
                'Pulled image platform differs from the verified selection.')
        validate_labels(image.get('Config', {}).get('Labels', {}), release)
        journal.save('image-verified', image_id=image_id, image_config_digest=config_digest,
                     source_commit=release['commit'])
        ensure_unchanged(fingerprints)
        before = inventory(old_env)
        validate_live(old_model, before, installation, keychain)
        require({name: c['Id'] for name, c in before.items() if name != service} == dependency_ids,
                'Dependency containers changed during upgrade; stop and reconcile concurrent operations.')
        journal.save('stopping')
        mutation = True
        stop_selected(installation, args, keychain, old_env, installation['old_bundle'])
        journal.save('stopped')
        if args.role == 'inbox':
            backup_database(journal, old_env)
        ensure_unchanged(fingerprints)
        replacements = {key: new_env[key] for key in ('OYA_BUNDLE_DIR', 'OYA_NODE_IMAGE', 'COMPOSE_FILE')}
        # Saved COMPOSE_FILE preserves only the old saved file list. The helper's
        # ephemeral Keychain overlay stays selected in memory, not persisted.
        replacements['COMPOSE_FILE'] = ':'.join(remap(p, str(installation['old_bundle']), release['bundle']) for p in installation['files'])
        updated = replace_exports(installation['raw'], installation['assignments'], replacements)
        journal.save('saving-environment')
        atomic(installation['path'], updated)
        fingerprints[str(installation['path'])] = sha(updated)
        active_env, active_bundle = new_env, Path(release['bundle'])
        journal.save('starting')
        if keychain:
            helper_action(installation, args, active_bundle, new_env, 'start')
        else:
            compose(new_env, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate',
                    '--wait', '--wait-timeout', '120', service, timeout=240)
        ensure_unchanged(fingerprints)
        journal.save('verifying-runtime')
        selected_installation = dict(installation, env=new_env)
        live = inventory(new_env)
        running_model = copy.deepcopy(old_model)
        running_model['services'][service] = new_model['services'][service]
        validate_live(running_model, live, selected_installation, keychain, healthy=True)
        require({name: c['Id'] for name, c in live.items() if name != service} == dependency_ids,
                'Dependency container identity changed; selected service stopped for investigation.')
        require(live[service].get('Image') == image_id, 'Running container image ID differs from verified image.')
        journal.complete('complete')
    except BaseException as error:
        failure = failure_details(error, journal.data['stage'])
        stopped = None
        if mutation:
            try:
                stop_selected(installation, args, keychain, active_env, active_bundle, require_clean=False)
                stopped = True
            except BaseException:
                stopped = False
                print('URGENT: shutdown unconfirmed. Stop affected workers manually; retain all database checkpoints.', file=sys.stderr)
        journal.save('failed', mutation_started=mutation, shutdown_confirmed=stopped, **failure)
        raise
    # Reporting failures after a committed success must not stop a verified node.
    print('Upgrade complete: ' + args.role + ' ' + args.release + '. Local health verified; verify existing job status and public delivery separately.')
    print('Recovery records retained: ' + str(journal.path))


def run(args):
    installation = load_installation(args)
    journal = None
    if args.action != 'preview':
        journal = Journal(installation['directory'], args.role, args.release)
    try:
        live = inventory(installation['env'])
        keychain = keychain_selection(installation, args, live)
        old_model = render(installation['env'])
        mode = validate_model(old_model, installation, args.role, keychain)
        validate_live(old_model, live, installation, keychain)
        fingerprints = configuration_files(installation, old_model, keychain)
        if args.action == 'quiesce':
            assert journal is not None
            require(args.role == 'worker', 'quiesce applies only to workers; inbox stopping belongs to apply after ALL workers stop.')
            journal.save('stopping', environment_file=str(installation['path']),
                         compose_project=installation['env']['COMPOSE_PROJECT_NAME'],
                         docker_context=installation['context'], configuration_fingerprints=fingerprints,
                         keychain={'managed': keychain, 'account_reference': args.keychain_account,
                                   'service_reference': args.keychain_service})
            try:
                stop_selected(installation, args, keychain, installation['env'], installation['old_bundle'])
                journal.complete('quiesced')
            except BaseException as error:
                journal.save('failed', shutdown_confirmed=False, **failure_details(error, journal.data['stage']))
                raise
            print('Selected local worker stopped. Repeat on every worker host; this does not establish remote worker shutdown.')
            print('Recovery records retained: ' + str(journal.path))
            return
        if args.action == 'apply':
            if args.role == 'inbox':
                require(args.workers_stopped, 'Stop ALL workers first, then pass --workers-stopped as an explicit operator acknowledgement.')
            else:
                require(args.inbox_ready == args.release, 'Verify the counterpart inbox and existing job state at the SAME release; acknowledge with --inbox-ready ' + args.release)
        # For apply, assets are retained even if a later step fails. Preview uses
        # private temporary verification files and cleans them on every exit.
        with contextlib.ExitStack() as stack:
            if journal:
                staging = journal.path / 'release'
                staging.mkdir(mode=0o700)
            else:
                staging = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='oya-upgrade-preview-')))
            release = release_assets(args.release, staging)
            new_env = dict(installation['env'])
            new_env['OYA_BUNDLE_DIR'] = release['bundle']
            new_env['OYA_NODE_IMAGE'] = release['image']
            new_env['COMPOSE_FILE'] = ':'.join(remap(p, str(installation['old_bundle']), release['bundle']) for p in installation['env']['COMPOSE_FILE'].split(':'))
            new_model = render(new_env)
            expected_model = remap(old_model, str(installation['old_bundle']), release['bundle'])
            expected_model['services'][installation['service']]['image'] = release['image']
            require(new_model == expected_model, 'New Compose model changes storage, dependencies or service settings; review and migrate separately.')
            verify_dependency_assets(old_model, new_model, installation['service'])
            selected = new_model['services'][installation['service']]
            platform = selected.get('platform')
            if not platform:
                daemon = json_command(['docker', 'info', '--format', '{{json .}}'], installation['env'])
                require(daemon.get('OSType') == 'linux' and daemon.get('Architecture') in {'x86_64', 'amd64'},
                        'Save an explicit node platform Compose override for non-amd64 Docker hosts.')
                platform = 'linux/amd64'
            config_digest = registry_identity(release, platform)
            print('Verified plan: ' + args.role + ' -> ' + args.release + '; preserve ' + mode + ' identity, project, files and volumes; replace only ' + installation['service'] + '.')
            if args.action == 'preview':
                print('Preview only. No pull, stop, saved-environment change or Keychain access. Public temporary verification files removed on exit.')
                print('Inbox apply requires all workers stopped and creates a PostgreSQL dump; worker apply requires --inbox-ready ' + args.release + '.')
                return
            # Platform used for pull must not alter the rendered Compose model.
            pull_model = copy.deepcopy(new_model)
            pull_model['services'][installation['service']]['platform'] = platform
            apply_upgrade(installation, args, release, old_model, pull_model, new_env, keychain, fingerprints, config_digest, journal)
    except BaseException as error:
        if journal and journal.data['stage'] not in {'failed', 'complete', 'quiesced'}:
            journal.save('failed-preflight', mutation_started=False, **failure_details(error, journal.data['stage']))
            # A failed read-only preflight needs no transaction recovery gate.
            journal.marker.unlink()
        raise
    finally:
        if journal:
            journal.close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['preview', 'apply', 'quiesce'])
    parser.add_argument('--role', required=True, choices=['worker', 'inbox'])
    parser.add_argument('--env-file', required=True, help='Existing private compose.env; never sourced as shell code')
    parser.add_argument('--release', help='Explicit published node-vMAJOR.MINOR.PATCH (never latest)')
    parser.add_argument('--workers-stopped', action='store_true', help='Operator confirms ALL local/remote workers are stopped')
    parser.add_argument('--inbox-ready', help='Operator confirms counterpart inbox is healthy at this exact release and existing job state was checked')
    parser.add_argument('--keychain-account', type=credential_reference)
    parser.add_argument('--keychain-service', type=credential_reference)
    args = parser.parse_args(argv)
    if args.action != 'quiesce' and (not args.release or re.fullmatch(TAG, args.release) is None):
        parser.error('preview/apply requires an explicit --release node-vMAJOR.MINOR.PATCH')
    if args.action == 'quiesce' and (args.role != 'worker' or args.release):
        parser.error('quiesce is worker-only and takes no release')
    if args.role == 'worker' and args.workers_stopped or args.role == 'inbox' and args.inbox_ready:
        parser.error('Use the coordination acknowledgement for the selected role')
    return args


def credential_reference(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value):
        raise argparse.ArgumentTypeError('Use a simple Keychain reference name, never a credential value.')
    return value


def main(argv=None):
    os.umask(0o077)
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        run(parse_args(argv))
        return 0
    except (UpgradeError, OSError, ValueError, KeyError, TypeError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, UpgradeError) else 'Upgrade interrupted or invalid state encountered; inspect retained private records before retrying.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
