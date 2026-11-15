import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { parsePeers, loadPeers, publicationSigners, readBounded } from '../src/peers/config.mjs';
import { parseInboxConfig } from '../src/inbox/config.mjs';
import { signJob } from '../src/inbox/protocol.mjs';
import { createInboxServer } from '../src/inbox/http.mjs';

const sender = Wallet.createRandom();
const local = Wallet.createRandom();
const base = { target: 'test', allowedSigners: [local.address], execution: { mode: 'ipfs' } };

async function directory(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oya-registry-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

test('registry authorization is opt-in, bounded, immutable and independent of receiver/network', async t => {
    const dir = await directory(t);
    const file = join(dir, 'inbox.json');
    assert.equal(parseInboxConfig(base).peers, undefined);
    assert.equal(await loadPeers(parseInboxConfig(base), file), undefined);
    const input = { registryFile: 'registry.json' };
    for (const invalid of [null, [], {}, { registryFile: '' }, { registryFile: 'x'.repeat(4097) },
        ...['networkId', 'nodeAddress', 'maxMessages', 'retentionMs'].map(key => ({ ...input, [key]: 1 }))]) {
        assert.throws(() => parsePeers(invalid));
    }
    const config = parseInboxConfig({ ...base, peers: input });
    assert.deepEqual(config.allowedSigners, base.allowedSigners);
    const record = { nodeAddress: sender.address, url: 'https://peer.example/v1/jobs', target: 'other' };
    await writeFile(join(dir, 'registry.json'), JSON.stringify([record, record]));
    const peers = await loadPeers(config, file);
    assert.deepEqual(peers.members, [sender.address.toLowerCase()]);
    assert.ok(Object.isFrozen(peers) && Object.isFrozen(peers.members));
    assert.deepEqual(publicationSigners(base.allowedSigners, peers), [local.address.toLowerCase(), sender.address.toLowerCase()]);
    await writeFile(join(dir, 'registry.json'), '[]');
    assert.equal(peers.members.length, 1);
    assert.deepEqual((await loadPeers(config, file)).members, []);
    for (const invalid of [{}, [null], [{ ...record, url: '' }], [{ ...record, nodeAddress: 'invalid' }],
        [{ ...record, nodeAddress: '0x' + '0'.repeat(40) }], Array(1001).fill(record)]) {
        await writeFile(join(dir, 'registry.json'), JSON.stringify(invalid));
        await assert.rejects(loadPeers(config, file));
    }
    await writeFile(join(dir, 'registry.json'), ' '.repeat(1048577));
    await assert.rejects(loadPeers(config, file));
    await writeFile(join(dir, 'registry.json'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(loadPeers(config, file));
    await assert.rejects(readBounded(dir, 10));
    await assert.rejects(loadPeers({ peers: { registryFile: 'missing' } }, file));
});

async function serve(t, config) {
    const calls = [];
    const store = {
        enqueue: async job => { calls.push(job); return { requestId: job.requestId, status: 'queued' }; },
        status: async job => { calls.push(job); return { requestId: job.requestId, status: 'published' }; }
    };
    const server = createInboxServer({ config, workerToken: 'test', store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const request = (path, job) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job)
    });
    return { calls, request };
}

test('registry members use only ordinary jobs/status; opt-out and removed routes fail closed', async t => {
    const job = await signJob(sender, base.target, 'ordinary message');
    const disabled = await serve(t, parseInboxConfig(base));
    assert.equal((await disabled.request('/v1/jobs', job)).status, 403);
    assert.equal(disabled.calls.length, 0);
    const config = parseInboxConfig(base);
    config.allowedSigners = publicationSigners(config.allowedSigners, { members: [sender.address.toLowerCase()] });
    const enabled = await serve(t, config);
    assert.equal((await enabled.request('/v1/jobs', job)).status, 202);
    assert.equal((await enabled.request('/v1/status', job)).status, 200);
    for (const path of ['/v1/peers/receive', '/v1/peers/status']) assert.equal((await enabled.request(path, job)).status, 404);
    assert.deepEqual(enabled.calls, [job, job]);
    config.allowedSigners = base.allowedSigners;
    assert.equal((await enabled.request('/v1/jobs', job)).status, 403);
    assert.equal((await enabled.request('/v1/status', job)).status, 403);
    assert.equal(enabled.calls.length, 2);
});

test('ordinary admission rejects tampering, legacy wrappers, wrong target, expiry and malformed content before storage', async t => {
    const config = { ...parseInboxConfig(base), allowedSigners: [sender.address] };
    const { calls, request } = await serve(t, config);
    const job = await signJob(sender, base.target, 'original');
    const invalid = [
        { ...job, version: 2 }, { ...job, receiver: local.address }, { ...job, networkId: 'testnet' },
        { ...job, requestId: 'not-a-uuid' }, { ...job, expiresAt: job.expiresAt + 1 },
        { ...job, message: { ...job.message, text: 'tampered' } },
        { ...job, message: { ...job.message, signer: local.address } },
        { ...job, requestSignature: job.message.signature },
        await signJob(local, base.target, 'unregistered'), await signJob(sender, 'other', 'wrong target'),
        ...await Promise.all(['', '\0', '\ufefftext', 'unicode \u2603', 'x'.repeat(8193)].map(text => signJob(sender, base.target, text)))
    ];
    for (const value of invalid) {
        assert.equal((await request('/v1/jobs', value)).status, 403);
        assert.equal((await request('/v1/status', value)).status, 403);
    }
    for (const expiresAt of [Date.now() - 1, Date.now() + 8 * 86400_000]) {
        assert.equal((await request('/v1/jobs', await signJob(sender, base.target, 'expiry', { expiresAt }))).status, 400);
    }
    assert.equal(calls.length, 0);
});

test('status accepts an expired signed job at protocol ceiling after admission shrinks, not forgery or oversized content', async t => {
    const config = { ...parseInboxConfig(base), maxTextBytes: 1, allowedSigners: [sender.address] };
    const { calls, request } = await serve(t, config);
    const job = await signJob(sender, base.target, 'x'.repeat(8192), { expiresAt: Date.now() - 1 });
    assert.equal((await request('/v1/status', job)).status, 200);
    assert.equal((await request('/v1/jobs', job)).status, 403);
    assert.equal((await request('/v1/status', { ...job, message: { ...job.message, text: 'forged' } })).status, 403);
    assert.equal((await request('/v1/status', await signJob(sender, base.target, 'x'.repeat(8193)))).status, 403);
    assert.deepEqual(calls, [job]);
});
