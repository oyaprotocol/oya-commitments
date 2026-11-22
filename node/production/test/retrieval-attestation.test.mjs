import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { attestRetrieval, verifyRetrievalAttestation } from '../src/retrieval-attestation.mjs';
import { runRetrievalCli } from '../src/attest-retrieval.mjs';

// Fixed interoperability vector: raw CIDv1 and SHA-256(compact metadata || NUL || binary content).
const content = Buffer.from([0, 255, 195, 40, 10]);
const cid = 'bafkreiejyveosrnllte7njjwicxifdncwju6fczs53sk7bw3xbru22sdjq';
const receiptCid = 'bafkreihcdcfh7izflkyv6z7ygtys454l5luuwcadp6dizjikjuixj44jmu';
const digest = '5f3baeae315b085c78e6da494b44ab43694e09d61824650a8fc9ad6b732d25e2';
const wallet = new Wallet('0x' + '1'.padStart(64, '0'));
const other = new Wallet('0x' + '2'.padStart(64, '0'));
const nodeAddress = wallet.address.toLowerCase();
const completedAt = '2025-01-02T03:04:05.006Z';
const receipt = { kind: 'oya.retrieval-attestation', version: 1, cid, nodeAddress, completedAt, byteLength: 5,
    signature: '0x5038f90ae97c41142fb86f3a878c634d211a1ec372b57ffae547ebcf8a160fcb09890ebcfe114f4d6bb8f37c59484d9bc2317c266b1e46097f1c0b8de720c4ff1c' };
const encode = value => Buffer.from(JSON.stringify(value));
const settings = { ipfsUrl: 'http://127.0.0.1/api/v0', ipfsAuthorization: 'Bearer fixture', nodeAddress };
const cat = key => `/api/v0/cat?arg=${key}`;
const put = '/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&pin=true';
function fixture(overrides = {}) {
    const events = [];
    const fetchImpl = async (url, init) => {
        const path = url.slice('http://127.0.0.1'.length);
        events.push(path);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.authorization, settings.ipfsAuthorization);
        if (overrides[path]) return overrides[path]();
        if (path === put) {
            assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), encode(receipt));
            return Response.json({ Key: receiptCid });
        }
        assert.equal(init.body, undefined);
        if (path === cat(cid)) return new Response(content);
        if (path === cat(receiptCid)) return new Response(encode(receipt));
        assert.fail(`unexpected route ${path}`);
    };
    const signer = { address: wallet.address, signMessage(bytes) {
        events.push('sign');
        assert.deepEqual(bytes, Buffer.from(digest, 'hex'));
        return wallet.signMessage(bytes);
    } };
    const now = () => { events.push('clock'); return Date.parse(completedAt); };
    const create = (opts = {}, key = cid, config = settings) => attestRetrieval(key, config, { signer, fetchImpl, now, ...opts });
    return { create, events, fetchImpl, now };
}

test('creates the binary signing vector, pins exactly the receipt and confirms its CID', async () => {
    const f = fixture();
    assert.deepEqual(await f.create(), { receiptCid, receipt });
    assert.deepEqual(f.events, [cat(cid), 'clock', 'sign', put, cat(receiptCid)]);
});

test('offline verification binds canonical receipt, signature, bytes and external expectations', async () => {
    const verify = (bytes, source = content, expected = { cid, nodeAddress }) => verifyRetrievalAttestation(bytes, source, expected);
    assert.deepEqual(verify(encode(receipt)), receipt);
    const forged = await other.signMessage(Buffer.from(digest, 'hex'));
    for (const change of [{ completedAt: '2025-01-02T03:04:05.007Z' }, { signature: forged }, { byteLength: 4 },
        { cid: receiptCid }, { nodeAddress: other.address.toLowerCase() }, { version: 2 }, { extra: true }]) {
        assert.throws(() => verify(encode({ ...receipt, ...change })), undefined, Object.keys(change)[0]);
    }
    for (const text of [JSON.stringify(receipt) + '\n', JSON.stringify(receipt).replace('"version":1', '"version":2,"version":1')]) {
        assert.throws(() => verify(Buffer.from(text)));
    }
    assert.throws(() => verify(encode(receipt), Buffer.alloc(content.length)));
    assert.throws(() => verify(encode(receipt), content, { cid, nodeAddress: other.address }));
    assert.throws(() => verify(encode(receipt), content, { cid: receiptCid, nodeAddress }));
});

for (const [name, response, reason] of [
    ['substituted bytes', () => new Response(Buffer.alloc(5)), /CID\/content mismatch/],
    ['HTTP error with matching body', () => new Response(content, { status: 503 }), /http_failure/],
    ['oversized announced length', () => new Response(content, { headers: { 'content-length': '6' } }), /body_limit/],
    ['oversized streamed bytes', () => new Response(Buffer.alloc(6)), /body_limit/],
    ['interrupted stream', () => new Response(new ReadableStream({ start(c) { c.enqueue(content); },
        pull(c) { c.error(new Error('disconnected')); } })), /transport_failure/],
]) {
    test(`${name}: no timestamp, signing, retries or publication`, async () => {
        const f = fixture({ [cat(cid)]: response });
        await assert.rejects(f.create({}, cid, { ...settings, maxBytes: 5 }), reason);
        assert.deepEqual(f.events, [cat(cid)]);
    });
}

test('unauthorized signer and non-raw CID fail before any read; lying signer cannot publish', async () => {
    const f = fixture();
    await assert.rejects(f.create({ signer: other }), /Unauthorized/);
    await assert.rejects(f.create({}, 'bafybeiejyveosrnllte7njjwicxifdncwju6fczs53sk7bw3xbru22sdjq'), /raw CID/);
    assert.deepEqual(f.events, []);
    await assert.rejects(f.create({ signer: { address: wallet.address, signMessage: bytes => other.signMessage(bytes) } }), /Unauthorized signature/);
    assert.deepEqual(f.events, [cat(cid), 'clock']);
});

test('wrong block/put CID and corrupted readback never report successful publication', async () => {
    for (const [route, reply] of [[put, () => Response.json({ Key: cid })], [cat(receiptCid), () => new Response(content)]]) {
        const f = fixture({ [route]: reply });
        await assert.rejects(f.create(), /CID\/content mismatch/);
        assert.deepEqual(f.events, [cat(cid), 'clock', 'sign', put, ...(route === put ? [] : [cat(receiptCid)])]);
    }
});

async function configFile(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oya-retrieval-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify(settings));
    return file;
}

test('CLI create uses the configured identity; verify reads both blocks without accessing keys or writing', async t => {
    const file = await configFile(t);
    const f = fixture();
    const run = (args, env) => runRetrievalCli([...args, file], { env, fetchImpl: f.fetchImpl, now: f.now });
    await assert.rejects(run(['create', cid], {}), /Invalid node signing key/);
    await assert.rejects(run(['create', cid], { OYA_NODE_PRIVATE_KEY: other.privateKey }), /Unauthorized/);
    assert.deepEqual(f.events, []);
    assert.deepEqual(await run(['create', cid], { OYA_NODE_PRIVATE_KEY: wallet.privateKey }), { receiptCid, receipt });
    assert.deepEqual(f.events.splice(0), [cat(cid), 'clock', put, cat(receiptCid)]);
    const noKeys = new Proxy({}, { get() { assert.fail('verify accessed environment'); } });
    assert.deepEqual(await run(['verify', receiptCid, cid], noKeys), { receiptCid, receipt });
    assert.deepEqual(f.events, [cat(receiptCid), cat(cid)]);
});

test('CLI process reports usage and operational failure on stderr, never printing private input', async t => {
    const cli = fileURLToPath(new URL('../src/attest-retrieval.mjs', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [cli, ...args], { env: { OYA_NODE_PRIVATE_KEY: 'private-invalid-test-key' } });
    const file = await configFile(t);
    for (const [args, pattern] of [[['verify'], /^Usage:/], [['create', cid, file], /^Retrieval attestation failed\./]]) {
        await assert.rejects(run(args), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.match(error.stderr, pattern);
            for (const secret of ['private-invalid-test-key', file, settings.ipfsAuthorization]) assert.ok(!error.stderr.includes(secret));
            return true;
        });
    }
});
