import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts/keychain-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
TOKEN = 'fixture_' + 'a' * 40


class KeychainWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.secret = self.directory / '.keychain-runtime/worker.json'
        self.env = {'OYA_LOCAL_DIR': str(self.directory), 'COMPOSE_FILE': '/example/worker.yaml',
                    'COMPOSE_PROJECT_NAME': 'fixture'}
        self.calls = []

    def execute(self, command, **options):
        self.calls.append((command, options))
        self.assertNotIn(TOKEN, ' '.join(command))
        self.assertNotIn(TOKEN, json.dumps(options.get('env', {})))
        if command[0] == '/usr/bin/security':
            return TOKEN
        if command[:3] == ['docker', 'compose', 'up']:
            self.assertEqual(self.secret.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(self.secret.read_text()), {'workerToken': TOKEN})
            self.assertEqual(options['env']['OYA_WORKER_SECRET_FILE'], str(self.secret))
            self.assertTrue(options['env']['COMPOSE_FILE'].endswith('compose.keychain-worker.yaml'))
        return ''

    def test_store_uses_stdin_without_default_trust_or_overwrite(self):
        with patch.object(worker, 'execute', self.execute):
            worker.store('operator', 'worker-token', io.StringIO(json.dumps({'workerToken': TOKEN})))
        command, options = self.calls[0]
        self.assertEqual(command, ['/usr/bin/security', '-i'])
        self.assertIn('-T ""', options['input'])
        self.assertNotIn('-U', options['input'])
        self.assertIn(TOKEN, options['input'])

    def test_start_materializes_only_for_startup_and_reclaims_stale_file(self):
        self.secret.parent.mkdir(mode=0o700)
        self.secret.write_text('stale credential from an interrupted startup')
        with patch.object(worker, 'execute', self.execute):
            worker.operate('start', 'operator', 'worker-token', self.env)
        self.assertFalse(self.secret.exists())
        self.assertTrue(any(command[:3] == ['docker', 'compose', 'rm'] for command, _ in self.calls))

    def test_failed_start_cleans_credential_and_stops_worker(self):
        def failing(command, **options):
            result = self.execute(command, **options)
            if command[:3] == ['docker', 'compose', 'up']:
                raise worker.OperationError('fixture startup failure')
            return result
        with patch.object(worker, 'execute', failing), self.assertRaises(worker.OperationError):
            worker.operate('start', 'operator', 'worker-token', self.env)
        self.assertFalse(self.secret.exists())
        self.assertEqual(self.calls[-1][0], ['docker', 'compose', 'rm', '--force', 'node'])

    def test_denied_keychain_access_leaves_no_plaintext(self):
        def denied(command, **options):
            if command[0] == '/usr/bin/security':
                raise worker.OperationError('fixture denied')
            return self.execute(command, **options)
        with patch.object(worker, 'execute', denied), self.assertRaises(worker.OperationError):
            worker.operate('start', 'operator', 'worker-token', self.env)
        self.assertFalse(self.secret.exists())

    def test_docker_unavailable_does_not_read_keychain(self):
        with patch.object(worker, 'execute', side_effect=worker.OperationError('offline')) as execute:
            with self.assertRaises(worker.OperationError):
                worker.operate('start', 'operator', 'worker-token', self.env)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[0][0], 'docker')
        self.assertFalse(self.secret.exists())

    def test_stop_never_reads_keychain_and_removes_stale_credential(self):
        self.secret.parent.mkdir(mode=0o700)
        self.secret.write_text('stale')
        with patch.object(worker, 'execute', self.execute):
            worker.operate('stop', 'operator', 'worker-token', self.env)
        self.assertFalse(self.secret.exists())
        self.assertTrue(all(command[0] == 'docker' for command, _ in self.calls))

    def test_running_worker_does_not_read_keychain_or_restart(self):
        def running(command, **options):
            if command[:3] == ['docker', 'compose', 'ps']:
                return 'fixture-container'
            if command[:2] == ['docker', 'inspect']:
                return '{"running":true,"restart":"no"}'
            return self.execute(command, **options)
        with patch.object(worker, 'execute', running):
            worker.operate('start', 'operator', 'worker-token', self.env)
        self.assertEqual(len(self.calls), 1)  # Only configuration validation.
        self.assertFalse(self.secret.exists())

    def test_concurrent_operation_fails_without_reading_credentials(self):
        self.secret.parent.mkdir(mode=0o700)
        with open(self.secret.parent / 'lock', 'w') as lock:
            worker.fcntl.flock(lock, worker.fcntl.LOCK_EX | worker.fcntl.LOCK_NB)
            with patch.object(worker, 'execute') as execute, self.assertRaises(worker.OperationError):
                worker.operate('start', 'operator', 'worker-token', self.env)
            execute.assert_not_called()

    def test_permissions_and_symlinks_fail_closed(self):
        self.directory.chmod(0o755)
        with self.assertRaises(worker.OperationError):
            worker.operate('start', 'operator', 'worker-token', self.env)
        self.directory.chmod(0o700)
        self.secret.parent.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(worker.OperationError):
            worker.operate('start', 'operator', 'worker-token', self.env)

    def test_secret_in_failed_subprocess_output_is_not_reported(self):
        result = type('Result', (), {'returncode': 1, 'stdout': TOKEN, 'stderr': TOKEN})()
        with patch.object(worker.subprocess, 'run', return_value=result):
            with self.assertRaises(worker.OperationError) as caught:
                worker.execute(['/usr/bin/security', '-i'], input=TOKEN)
        self.assertNotIn(TOKEN, str(caught.exception))


if __name__ == '__main__':
    unittest.main()
