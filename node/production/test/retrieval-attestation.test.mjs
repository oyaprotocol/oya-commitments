import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs, { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { attestRetrieval, ReceiptPublicationUncertain, verifyStoredRetrieval, verifyRetrievalAttestation } from '../src/retrieval-attestation.mjs';
import { runRetrievalCli } from '../src/attest-retrieval.mjs';

// Fixed interoperability vector: raw CIDv1 and SHA-256(compact metadata || NUL || binary content).
const content = Buffer.from([0, 255, 195, 40, 10]);
const cid = 'bafkreiejyveosrnllte7njjwicxifdncwju6fczs53sk7bw3xbru22sdjq';
const wallet = Wallet.createRandom();
const other = Wallet.createRandom();
const nodeAddress = wallet.address.toLowerCase();
const completedAt = '2025-01-02T03:04:05.006Z';
const encode = value => Buffer.from(JSON.stringify(value));
const fields = { kind: 'oya.retrieval-attestation', version: 1, cid, nodeAddress, completedAt, byteLength: 5 };
const digest = createHash('sha256').update(Buffer.concat([encode(fields), Buffer.from([0]), content])).digest('hex');
const receipt = { ...fields, signature: await wallet.signMessage(Buffer.from(digest, 'hex')) };
const cidBits = '00000001010101010001001000100000' + Array.from(createHash('sha256').update(encode(receipt)).digest(),
    byte => byte.toString(2).padStart(8, '0')).join('');
const receiptCid = 'b' + cidBits.match(/.{1,5}/g).map(s => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(s.padEnd(5, '0'), 2)]).join('');
const settings = { ipfsUrl: 'http://127.0.0.1/api/v0', ipfsAuthorization: 'Bearer fixture', nodeAddress };
const cat = key => `/api/v0/cat?arg=${key}`;
const put = '/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&pin=true&cid-base=base32';
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
            return Response.json({ Key: receiptCid, Size: encode(receipt).length });
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

test('fixed public vector: sign the 32 digest bytes and publish the independently derived raw CID', async () => {
    const nodeAddress = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
    const signature = '0x5038f90ae97c41142fb86f3a878c634d211a1ec372b57ffae547ebcf8a160fcb09890ebcfe114f4d6bb8f37c59484d9bc2317c266b1e46097f1c0b8de720c4ff1c';
    const receiptCid = 'bafkreihcdcfh7izflkyv6z7ygtys454l5luuwcadp6dizjikjuixj44jmu';
    const receipt = { ...fields, nodeAddress, signature };
    const f = fixture({ [put]: () => Response.json({ Key: receiptCid, Size: encode(receipt).length }),
        [cat(receiptCid)]: () => new Response(encode(receipt)) });
    const signer = { address: nodeAddress, signMessage(bytes) {
        assert.deepEqual(bytes, Buffer.from('5f3baeae315b085c78e6da494b44ab43694e09d61824650a8fc9ad6b732d25e2', 'hex'));
        return signature;
    } };
    assert.deepEqual(await f.create({ signer }, cid, { ...settings, nodeAddress }), { receiptCid, receipt });
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
    ['non-byte chunk', () => new Response(new ReadableStream({ start(c) { c.enqueue('abc'); c.close(); } })), /transport_failure/],
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

test('ambiguous publication returns only the locally derived recovery CID, with no retry', async () => {
    const lost = () => { throw new Error(settings.ipfsAuthorization); };
    for (const [route, reply] of [[put, lost], [put, () => new Response('not JSON')],
        [put, () => Response.json({ Key: cid, Size: encode(receipt).length })],
        ...[undefined, -1, String(encode(receipt).length), encode(receipt).length + 1].map(Size =>
            [put, () => Response.json({ Key: receiptCid, Size })]),
        [cat(receiptCid), lost], [cat(receiptCid), () => new Response(content)]]) {
        const f = fixture({ [route]: reply });
        await assert.rejects(f.create(), error => {
            assert.ok(error instanceof ReceiptPublicationUncertain);
            assert.equal(error.status, 'publication_uncertain');
            assert.equal(error.receiptCid, receiptCid);
            assert.ok(!String(error).includes(settings.ipfsAuthorization));
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.deepEqual(f.events, [cat(cid), 'clock', 'sign', put, ...(route === put ? [] : [cat(receiptCid)])]);
        const recovery = fixture();
        assert.deepEqual(await verifyStoredRetrieval(receiptCid, cid, settings, recovery), { receiptCid, receipt });
        assert.deepEqual(recovery.events, [cat(receiptCid), cat(cid)]);
    }
});

async function configFile(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oya-retrieval-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify(settings));
    return file;
}

test('verify exports exactly the two checked blocks for offline verification', async t => {
    const file = await configFile(t);
    const dir = join(dirname(file), 'handoff');
    const f = fixture();
    const args = ['verify', receiptCid, cid, file, '--export', dir];
    assert.deepEqual(await runRetrievalCli(args, f), { receiptCid, receipt });
    assert.deepEqual(f.events, [cat(receiptCid), cat(cid)]);
    const blocks = join(dir, 'blocks');
    const bytes = await fs.readFile(join(blocks, 'receipt.json'));
    const source = await fs.readFile(join(blocks, 'content.bin'));
    assert.deepEqual(bytes, encode(receipt));
    assert.deepEqual(source, content);
    await assert.rejects(runRetrievalCli(args, f), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(join(blocks, 'content.bin')), source);
    assert.deepEqual((await fs.readdir(blocks)).sort(), ['content.bin', 'receipt.json']);
    const cli = fileURLToPath(new URL('../src/attest-retrieval.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'verify-files',
        join(blocks, 'receipt.json'), join(blocks, 'content.bin'), cid, nodeAddress], { env: {} });
    assert.deepEqual(JSON.parse(stdout), { receiptCid, receipt });
    for (const path of [dir, blocks, join(blocks, 'receipt.json'), join(blocks, 'content.bin')]) {
        assert.equal((await fs.stat(path)).mode & 0o077, 0);
    }
});

test('failed verification or write leaves no handoff and a symlink is never followed', async t => {
    const file = await configFile(t);
    const dir = join(dirname(file), 'handoff');
    const run = () => runRetrievalCli(['verify', receiptCid, cid, file, '--export', dir], fixture());
    await writeFile(file, JSON.stringify({ ...settings, nodeAddress: other.address }));
    await assert.rejects(run(), /metadata mismatch/);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    await writeFile(file, JSON.stringify(settings));
    const damaged = fixture({ [cat(cid)]: () => new Response(Buffer.alloc(content.length)) });
    await assert.rejects(runRetrievalCli(['verify', receiptCid, cid, file, '--export', dir], damaged), /CID\/content mismatch/);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    await symlink(dirname(file), dir);
    await assert.rejects(run(), { code: 'EEXIST' });
    assert.deepEqual((await fs.readdir(dirname(file))).sort(), ['handoff', 'settings.json']);
    await rm(dir);
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (path, ...rest) => {
        if (path.endsWith('content.bin')) throw new Error('disk full');
        await write(path, ...rest);
    });
    await assert.rejects(run(), /disk full/);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('CLI create uses the configured identity; verify reads both blocks without accessing keys or writing', async t => {
    const file = await configFile(t);
    const f = fixture();
    const run = (args, env) => runRetrievalCli([...args, file], { env, fetchImpl: f.fetchImpl, now: f.now });
    const dir = dirname(file);
    const keyFile = join(dir, 'node.env');
    const env = { OYA_LOCAL_DIR: dir, OYA_NODE_PRIVATE_KEY: wallet.privateKey };
    const create = () => run(['create', cid], env);
    await assert.rejects(run(['create', cid], { OYA_NODE_PRIVATE_KEY: wallet.privateKey }), /Invalid node signing key/);
    await assert.rejects(create(), /Invalid node signing key/); // Missing file: no ambient fallback.
    await writeFile(keyFile, `OYA_NODE_PRIVATE_KEY=${other.privateKey}\n`, { mode: 0o600 });
    await assert.rejects(create(), /Unauthorized/);
    await writeFile(keyFile, `OYA_NODE_PRIVATE_KEY=${wallet.privateKey}\n`);
    await chmod(dir, 0o755);
    await assert.rejects(create(), /Invalid node signing key/);
    await chmod(dir, 0o700);
    await chmod(keyFile, 0o644);
    await assert.rejects(create(), /Invalid node signing key/);
    await chmod(keyFile, 0o600);
    const alias = join(dir, 'alias');
    await link(keyFile, alias);
    await assert.rejects(create(), /Invalid node signing key/);
    await rm(keyFile);
    await symlink(alias, keyFile);
    await assert.rejects(create(), /Invalid node signing key/);
    await rm(keyFile);
    await writeFile(keyFile, `OYA_NODE_PRIVATE_KEY=${wallet.privateKey}\n`, { mode: 0o600 });
    assert.deepEqual(f.events, []);
    assert.deepEqual(await run(['create', cid], { ...env, OYA_NODE_PRIVATE_KEY: other.privateKey }), { receiptCid, receipt });
    assert.deepEqual(f.events.splice(0), [cat(cid), 'clock', put, cat(receiptCid)]);
    const noKeys = new Proxy({}, { get() { assert.fail('verify accessed environment'); } });
    assert.deepEqual(await run(['verify', receiptCid, cid], noKeys), { receiptCid, receipt });
    assert.deepEqual(f.events, [cat(receiptCid), cat(cid)]);
});

test('verify-files checks exact local bytes against independent expectations without keys or transport', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-verify-files-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const signed = join(dir, 'receipt'), source = join(dir, 'content');
    const run = (r = signed, s = source, c = cid, a = nodeAddress) => runRetrievalCli(['verify-files', r, s, c, a], {
        env: new Proxy({}, { get() { assert.fail('accessed environment'); } }),
        fetchImpl() { assert.fail('accessed network'); },
    });
    await writeFile(signed, encode(receipt));
    await writeFile(source, content);
    assert.deepEqual(await run(), { receiptCid, receipt });
    await assert.rejects(run(signed, source, receiptCid), /CID\/content mismatch/);
    await assert.rejects(run(signed, source, cid, other.address), /metadata mismatch/);
    await writeFile(signed, JSON.stringify(receipt) + '\n');
    await assert.rejects(run(), /metadata mismatch/);
    await writeFile(signed, encode(receipt));
    await writeFile(source, Buffer.alloc(content.length));
    await assert.rejects(run(), /CID\/content mismatch/);
});

test('verify-files rejects oversized and non-regular files', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-verify-files-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const signed = join(dir, 'receipt'), source = join(dir, 'content'), alias = join(dir, 'alias');
    const run = (r, s) => runRetrievalCli(['verify-files', r, s, cid, nodeAddress]);
    await writeFile(signed, encode(receipt));
    await writeFile(source, content);
    await symlink(source, alias);
    await assert.rejects(run(signed, alias), { code: 'ELOOP' });
    await assert.rejects(run(dir, source), /Invalid input file/);
    await assert.rejects(run(signed, '/dev/null'), /Invalid input file/);
    await writeFile(source, Buffer.alloc(1048577));
    await assert.rejects(run(signed, source), /Invalid input file/);
    await writeFile(signed, Buffer.alloc(1025));
    await assert.rejects(run(signed, join(dir, 'missing')), /Invalid input file/);
});

test('CLI process reports usage and operational failure on stderr, never printing private input', async t => {
    const cli = fileURLToPath(new URL('../src/attest-retrieval.mjs', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [cli, ...args], { env: { OYA_NODE_PRIVATE_KEY: 'private-invalid-test-key' } });
    const file = await configFile(t);
    for (const [args, pattern] of [[['verify'], /^Usage:/], [['verify-files'], /^Usage:/],
        [['verify-files', file, file, cid, nodeAddress], /^Retrieval attestation failed\./], [['create', cid, file], /^Retrieval attestation failed\./]]) {
        await assert.rejects(run(args), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.match(error.stderr, pattern);
            for (const secret of ['private-invalid-test-key', file, settings.ipfsAuthorization]) assert.ok(!error.stderr.includes(secret));
            return true;
        });
    }
});
