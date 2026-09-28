import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet } from 'ethers';
import { loadSecrets } from '../src/secrets.mjs';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-secrets-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return join(directory, 'node.env');
}

test('secret file preserves literal values and leaves the process environment unchanged', async (t) => {
    const path = await fixture(t);
    const key = Wallet.createRandom().privateKey;
    const authorization = 'Bearer $TOKEN="literal"#part=more';
    const names = ['OYA_NODE_PRIVATE_KEY', 'OYA_RPC_AUTHORIZATION', 'OYA_IPFS_AUTHORIZATION'];
    const before = names.map(name => process.env[name]);
    await writeFile(path, `# Runtime secrets\r\n\r\nOYA_NODE_PRIVATE_KEY=${key}\r\n`
        + `OYA_RPC_AUTHORIZATION=${authorization}\r\nOYA_IPFS_AUTHORIZATION=`, { mode: 0o600 });
    const secrets = await loadSecrets(path);
    assert.equal(secrets.OYA_NODE_PRIVATE_KEY, key);
    assert.equal(secrets.OYA_RPC_AUTHORIZATION, authorization);
    assert.equal(secrets.OYA_IPFS_AUTHORIZATION, '');
    assert.deepEqual(Object.keys(secrets), names);
    assert.ok(Object.isFrozen(secrets));
    for (const [index, name] of names.entries()) assert.ok(process.env[name] === before[index], 'must not change process.env');
    await writeFile(path, `OYA_NODE_PRIVATE_KEY=${key}\n`);
    assert.deepEqual(Object.keys(await loadSecrets(path)), ['OYA_NODE_PRIVATE_KEY'], 'omitted values must not be inherited');
});

test('missing, unreadable, malformed, duplicate, and unknown secrets fail without disclosing input', async (t) => {
    const path = await fixture(t);
    const message = 'Cannot load node secrets. Check file access and literal KEY=value entries.';
    await assert.rejects(loadSecrets(path), { message });
    await assert.rejects(loadSecrets(join(path, '..')), { message });
    const valid = `OYA_NODE_PRIVATE_KEY=${Wallet.createRandom().privateKey}\n`;
    for (const content of ['', '# No key\n', 'OYA_NODE_PRIVATE_KEY=\n',
        valid + 'OYA_NODE_PRIVATE_KEY=private-marker\n', valid + 'UNKNOWN=private-marker\n',
        valid + 'export OYA_RPC_AUTHORIZATION=private-marker\n', valid + 'private-marker\n',
        valid + 'OYA_RPC_AUTHORIZATION=private-marker\0\n']) {
        await writeFile(path, content, { mode: 0o600 });
        await assert.rejects(loadSecrets(path), { message });
    }
});
