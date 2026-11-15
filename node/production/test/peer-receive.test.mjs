import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { signPeer, validatePeer, peerText, receiptFor, MAX_AGE } from '../src/peers/protocol.mjs';
import { parsePeers, loadPeers, readBounded } from '../src/peers/config.mjs';
import { sendPeer, requestPeer } from '../src/peers/client.mjs';
import { saveEnvelope } from '../src/peers/cli.mjs';
import { PeerStore } from '../src/peers/store.mjs';
import { parseInboxConfig } from '../src/inbox/config.mjs';
import { createInboxServer } from '../src/inbox/http.mjs';

const sender = Wallet.createRandom();
const receiver = Wallet.createRandom();
const config = { networkId: 'testnet', nodeAddress: receiver.address.toLowerCase(), target: 'peer-test',
    maxTextBytes: 8192, members: [sender.address.toLowerCase()], maxMessages: 2, retentionMs: MAX_AGE };
const envelope = (overrides = {}, wallet = sender) => signPeer(wallet, { networkId: config.networkId,
    receiver: config.nodeAddress, target: config.target, text: 'exact\ntext ☀', ...overrides });
async function directory(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oya-peer-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
async function serve(t, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('peer signatures bind every field and reject publication/domain substitutions', async () => {
    const original = await envelope();
    const checked = validatePeer(original, config);
    assert.notEqual(checked, original);
    assert.ok(Object.isFrozen(checked));
    assert.deepEqual(checked, original);
    for (const [key, value] of Object.entries({ version: 2, operation: 'publish', networkId: 'other',
        receiver: sender.address.toLowerCase(), target: 'other', requestId: '00000000-0000-4000-8000-000000000000',
        expiresAt: original.expiresAt - 1, text: 'changed', sender: receiver.address.toLowerCase(), signature: '0x' })) {
        assert.throws(() => validatePeer({ ...original, [key]: value }, config), { code: 'invalid_peer_envelope' }, key);
    }
    for (const change of [{ networkId: 'other' }, { receiver: Wallet.createRandom().address }, { target: 'other' }]) {
        const signed = await envelope(change);
        assert.throws(() => validatePeer(signed, config), { status: 403 });
    }
    const otherDomain = { ...original, signature: await sender.signMessage(peerText(original).replace('informational peer receive', 'inbox job')) };
    assert.throws(() => validatePeer(otherDomain, config), { status: 403 });
    assert.throws(() => validatePeer({ ...original, extra: true }, config), { status: 403 });
    assert.throws(() => validatePeer({ ...original, sender: sender.address }, config), { status: 403 });
});

test('membership, revocation and self rejection cannot be bypassed by publication grants', async () => {
    const original = await envelope();
    assert.throws(() => validatePeer(original, { ...config, members: [], allowedSigners: [sender.address] }), { status: 403 });
    assert.throws(() => validatePeer(original, { ...config, members: [] }, { checkExpiry: false }), { status: 403 });
    const self = await envelope({}, receiver);
    assert.throws(() => validatePeer(self, { ...config, members: [self.sender] }), { status: 403 });
    const unknown = await envelope({}, Wallet.createRandom());
    assert.throws(() => validatePeer(unknown, config), { status: 403 });
});

test('expiry, Unicode and exact text byte limits fail closed; status permits expiry', async () => {
    const now = Date.now();
    const expired = await envelope({ expiresAt: now });
    assert.throws(() => validatePeer(expired, config, { now }), { code: 'invalid_peer_expiry' });
    assert.equal(validatePeer(expired, config, { now, checkExpiry: false }).expiresAt, now);
    const future = await envelope({ expiresAt: now + MAX_AGE + 1 });
    assert.throws(() => validatePeer(future, config, { now }), { status: 400 });
    for (const text of ['x'.repeat(8193), '\0', '\ud800']) {
        const value = await envelope({ text });
        assert.throws(() => validatePeer(value, config), { status: 403 });
    }
    assert.equal(validatePeer(await envelope({ text: 'é'.repeat(4096) }), config).text.length, 4096);
    for (const expiresAt of [-1, 1.2, Number.MAX_SAFE_INTEGER]) {
        const value = await envelope({ expiresAt });
        assert.throws(() => validatePeer(value, config, { checkExpiry: false }), { status: 403 });
    }
});

test('status recovers retained receipts after admission shrinks while preserving authentication and protocol bounds', async () => {
    const value = await envelope({ text: 'é'.repeat(4096), expiresAt: Date.now() - 1 });
    const receipt = receiptFor(value, value.expiresAt - 1000, Date.now() + MAX_AGE);
    const store = new PeerStore({}, { ...config, maxTextBytes: 1 });
    let queries = 0;
    store.locked = async action => action({ query: async (_sql, params) => {
        queries++;
        assert.deepEqual(params.slice(0, 2), [config.target, value.requestId]);
        return { rows: [{ digest: receipt.digest, receipt }] };
    } });
    assert.deepEqual(await store.status(value), receipt);
    await assert.rejects(store.receive(await envelope({ text: 'é' })), { code: 'invalid_peer_envelope' });
    const rejected = [
        { ...value, text: 'forged' },
        { ...value, signature: await sender.signMessage(peerText(value).replace('informational peer receive', 'inbox job')) },
        await envelope({ networkId: 'other' }), await envelope({ receiver: Wallet.createRandom().address }),
        await envelope({ target: 'other' }), await envelope({}, Wallet.createRandom()),
        await envelope({ text: 'é'.repeat(4096) + 'x' }), await envelope({ text: '\0' }),
        await envelope({ text: '\ud800' })
    ];
    for (const invalid of rejected) await assert.rejects(store.status(invalid), { code: 'invalid_peer_envelope' });
    store.config = { ...store.config, members: [] };
    await assert.rejects(store.status(value), { code: 'invalid_peer_envelope' });
    assert.equal(queries, 1, 'invalid status must fail before database access');
    store.config = { ...store.config, members: config.members };
    await assert.rejects(store.status(await envelope({ requestId: value.requestId, text: 'different' })), { code: 'peer_not_found' });
    store.locked = async action => action({ query: async () => ({ rows: [] }) });
    await assert.rejects(store.status(value), { code: 'peer_not_found' });
});

test('configuration stays optional, bounds registry resources and snapshots installed membership', async t => {
    const dir = await directory(t);
    const base = { target: 'peer-test', allowedSigners: [sender.address], execution: { mode: 'ipfs' } };
    const input = { networkId: 'testnet', nodeAddress: receiver.address, registryFile: 'registry.json' };
    assert.equal(parseInboxConfig(base).peers, undefined);
    assert.equal(await loadPeers(parseInboxConfig(base), join(dir, 'inbox.json')), undefined);
    for (const change of [null, [], { ...input, extra: true }, { ...input, maxMessages: 100001 },
        { ...input, retentionMs: 0 }, { ...input, networkId: '' }, { ...input, registryFile: '' }]) assert.throws(() => parsePeers(change));
    assert.throws(() => parseInboxConfig({ ...base, execution: { mode: 'ledger', nodeAddress: sender.address }, peers: input }), /must match/);
    assert.equal(parseInboxConfig({ ...base, execution: { mode: 'ledger', nodeAddress: receiver.address }, peers: input }).peers.nodeAddress, config.nodeAddress);
    const parsed = parseInboxConfig({ ...base, peers: input });
    assert.deepEqual(parsed.allowedSigners, base.allowedSigners);
    const registry = [{ nodeAddress: sender.address, url: 'https://peer.example/v1/jobs', target: 'sender' }];
    await writeFile(join(dir, 'registry.json'), JSON.stringify(registry));
    const loaded = await loadPeers(parsed, join(dir, 'inbox.json'));
    assert.deepEqual(loaded.members, [sender.address.toLowerCase()]);
    assert.ok(Object.isFrozen(loaded.members));
    await writeFile(join(dir, 'registry.json'), '[]');
    assert.equal(loaded.members.length, 1);
    assert.equal((await loadPeers(parsed, join(dir, 'inbox.json'))).members.length, 0);
    for (const invalid of [{}, [null], [{ ...registry[0], url: '' }], Array(1001).fill(registry[0])]) {
        await writeFile(join(dir, 'registry.json'), JSON.stringify(invalid));
        await assert.rejects(loadPeers(parsed, join(dir, 'inbox.json')));
    }
    await writeFile(join(dir, 'registry.json'), ' '.repeat(1048577));
    await assert.rejects(loadPeers(parsed, join(dir, 'inbox.json')));
    await assert.rejects(readBounded(dir, 100));
});

test('saved envelope is exclusive, private and unchanged on retry; reads are bounded', async t => {
    const dir = await directory(t);
    const file = join(dir, 'envelope.json');
    const value = await envelope();
    await saveEnvelope(file, value);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const before = await readFile(file, 'utf8');
    await assert.rejects(saveEnvelope(file, await envelope()), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), before);
    await assert.rejects(readBounded(file, 10));
    assert.equal(await readBounded(file, 65536), before);
    const textFile = join(dir, 'text');
    await writeFile(textFile, '\ufeffexact text\n');
    assert.equal(await readBounded(textFile, 8192), '\ufeffexact text\n');
    await writeFile(textFile, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readBounded(textFile, 8192));
});

test('HTTP peer routes are opt-in and do not invoke publication or worker methods', async t => {
    const value = await envelope();
    let calls = 0;
    const store = { enqueue: () => assert.fail('publication called') };
    const disabled = await serve(t, createInboxServer({ config, workerToken: 'test', store }));
    assert.equal((await requestPeer(new URL('/v1/peers/receive', disabled), JSON.stringify(value))).status, 404);
    const peerStore = { receive: async body => { calls++; validatePeer(body, config); return receiptFor(body, Date.now(), body.expiresAt); },
        status: async body => { validatePeer(body, config, { checkExpiry: false }); return receiptFor(body, Date.now(), body.expiresAt); } };
    const url = await serve(t, createInboxServer({ config, workerToken: 'test', store, peerStore }));
    assert.equal((await sendPeer(url, JSON.stringify(value), 'submit')).scope, 'inbox');
    assert.equal((await sendPeer(url, JSON.stringify(value), 'status')).status, 'received');
    assert.equal(calls, 1);
    assert.equal((await requestPeer(new URL('/v1/jobs', url), JSON.stringify(value))).status, 403);
    const tampered = { ...value, text: 'forged' };
    assert.equal((await requestPeer(new URL('/v1/peers/receive', url), JSON.stringify(tampered))).status, 403);
    assert.equal((await requestPeer(new URL('/v1/worker/claim', url), '{}')).status, 401);
    const response = await fetch(url + '/v1/peers/receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65537) });
    assert.equal(response.status, 413);
});

test('sender uses exact bytes, validates receipts and refuses credentialed or ambiguous destinations', async () => {
    const value = await envelope();
    const bytes = JSON.stringify(value, null, 2) + '\n';
    let calls = 0;
    const receipt = receiptFor(value, Date.now(), value.expiresAt);
    const transport = async (url, body) => { calls++; assert.equal(url.href, 'https://peer.example/v1/peers/receive'); assert.equal(body, bytes); return { status: 202, body: receipt }; };
    assert.deepEqual(await sendPeer('https://peer.example', bytes, 'submit', transport), receipt);
    assert.equal(calls, 1);
    for (const origin of ['http://peer.example', 'https://user:password@peer.example', 'https://peer.example/path', 'https://peer.example?key=x', 'https://peer.example/#x']) {
        await assert.rejects(sendPeer(origin, bytes, 'submit', () => assert.fail('network called')));
    }
    for (const change of [{ digest: 'bad' }, { receiver: value.sender }, { networkId: 'other' }, { status: 'published' },
        { extra: true }, { retainedUntil: 1 }, { acceptedAt: value.expiresAt }]) {
        await assert.rejects(sendPeer('https://peer.example', bytes, 'submit', async () => ({ status: 202, body: { ...receipt, ...change } })));
    }
    await assert.rejects(sendPeer('https://peer.example', bytes, 'submit', async () => ({ status: 302, body: receipt })));
});

test('transport rejects redirects, oversized responses, malformed JSON and slow bodies without leaking headers', async t => {
    const value = await envelope();
    for (const mode of ['redirect', 'oversized', 'malformed', 'slow']) {
        let requests = 0;
        const url = await serve(t, createServer((req, res) => {
            requests++;
            assert.equal(req.headers.authorization, undefined);
            assert.equal(req.headers.cookie, undefined);
            req.resume();
            res.writeHead(mode === 'redirect' ? 302 : 202, { 'content-type': 'application/json', location: '/elsewhere' });
            if (mode === 'slow') { res.write('{'); return; }
            res.end(mode === 'oversized' ? 'x'.repeat(17000) : mode === 'malformed' ? '{' : '{}');
        }));
        await assert.rejects(sendPeer(url, JSON.stringify(value), 'submit', (target, bytes) => requestPeer(target, bytes, { timeoutMs: 40 })));
        assert.equal(requests, 1);
    }
});

test('ambiguous commit and rollback failures propagate rather than report acceptance', async () => {
    const events = [];
    const client = { query: async sql => { events.push(sql); if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error(sql); },
        release: broken => events.push(broken) };
    const store = new PeerStore({ connect: async () => client }, config);
    await assert.rejects(store.transaction(async () => ({ status: 'received' })), /COMMIT/);
    assert.deepEqual(events, ['BEGIN', 'SET LOCAL synchronous_commit = on', 'COMMIT', 'ROLLBACK', true]);
});
