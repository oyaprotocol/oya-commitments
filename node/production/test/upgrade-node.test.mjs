import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('release upgrades verify artifacts and preserve state across lifecycle failures', () => {
    const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./upgrade-node_test.py', import.meta.url))], {
        encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
});
