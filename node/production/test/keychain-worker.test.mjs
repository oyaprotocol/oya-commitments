import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Keychain worker lifecycle keeps credentials out of arguments and cleans startup files', () => {
    const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./keychain-worker_test.py', import.meta.url))], {
        encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
});
