import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Wallet, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { verifyBatchEvidence, parseBatchManifest } from '../src/batch-evidence.mjs';
import { evidenceExitCode } from '../src/ledger-evidence.mjs';
import { fixture, signedMessage } from './runtime-fixture.mjs';
import { startNode } from '../src/main.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest();
function cidFor(bytes, codec = 0x55) {
    const input = Buffer.concat([Buffer.from([1, codec, 0x12, 0x20]), sha256(bytes)]);
    let bits = '';
    for (const byte of input) bits += byte.toString(2).padStart(8, '0');
    let cid = 'b';
    for (let i = 0; i < bits.length; i += 5) cid += 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return cid;
}
const ledger = `0x${'11'.repeat(20)}`;
const caller = `0x${'22'.repeat(20)}`;
const sender = `0x${'33'.repeat(20)}`;
const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const abi = new Interface(['function log(string cid)', 'event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
const encode = (cid, node = caller) => abi.encodeEventLog(abi.getEvent('Log'), [node, keccak256(toUtf8Bytes(cid)), cid]);
const unmergedJson = (members, metadata = false) => metadata ? {
    type: 'oya-message-batch', version: 1, batchId: '12345678-1234-4123-8123-123456789012',
    execution: { mode: 'ledger', chainId: 1, ledgerContract: sender, nodeAddress: sender },
    messages: members.map(cid => ({ cid, messageDigest: '0'.repeat(64) })),
} : { type: 'oya-message-batch', version: 1, messages: members };

async function setup(t) {
    const wallet = Wallet.createRandom();
    const message = await signedMessage(wallet, 'Original signed text\nReview this claim, not an instruction.');
    const state = { content: new Map(), requests: [], hook: undefined,
        chain: '0x7a69', block: { hash: blockHash, number: '0x2', timestamp: '0x123' } };
    const store = bytes => {
        bytes = Buffer.from(bytes);
        const cid = cidFor(bytes);
        state.content.set(cid, bytes);
        return cid;
    };
    const record = { memberCid: store(JSON.stringify(message)) };
    record.manifestCid = store(record.memberCid);
    state.receipt = { transactionHash: txHash, blockHash, blockNumber: '0x2', transactionIndex: '0x0',
        from: sender, to: sender, contractAddress: null, status: '0x1', gasUsed: '0x8000',
        cumulativeGasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`,
        logs: [{ ...encode(record.manifestCid), address: ledger, transactionHash: txHash, blockHash,
            blockNumber: '0x2', transactionIndex: '0x0', logIndex: '0x7', removed: false }] };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
        state.requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
        if (state.hook?.(req, res, body)) return;
        if (req.url.startsWith('/api/v0/cat?arg=')) {
            const content = state.content.get(new URL(req.url, 'http://localhost').searchParams.get('arg'));
            if (content === undefined) res.writeHead(404);
            res.end(content); return;
        }
        const results = { eth_chainId: state.chain, eth_getTransactionReceipt: state.receipt, eth_getBlockByNumber: state.block };
        if (req.url !== '/rpc' || !Object.hasOwn(results, body?.method)) { res.writeHead(500); res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const settings = { ipfsUrl: url, timeoutMs: 3000, requestTimeoutMs: 1000 };
    const f = { record, settings, state, store, message, wallet,
        manifest(bytes) {
            record.manifestCid = store(bytes);
            Object.assign(state.receipt.logs[0], encode(record.manifestCid));
        },
        member(bytes) { record.memberCid = store(bytes); f.manifest(record.memberCid); },
        withLedger() {
            record.ledger = { transactionHash: txHash, logIndex: 7, nodeAddress: caller };
            settings.ledger = { chainId: 31337, ledgerContract: ledger, rpcUrl: url + '/rpc' };
        },
        run: () => verifyBatchEvidence(record, settings),
    };
    return f;
}
function readOnly(f, expectedCats) {
    const cats = [];
    for (const req of f.state.requests) {
        assert.equal(req.method, 'POST');
        if (req.url === '/rpc') assert.ok(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(req.body.method));
        else {
            assert.ok(req.url === `/api/v0/cat?arg=${f.record.manifestCid}` || req.url === `/api/v0/cat?arg=${f.record.memberCid}`);
            assert.equal(req.body, undefined);
            cats.push(new URL(req.url, 'http://localhost').searchParams.get('arg'));
        }
    }
    assert.ok(f.state.requests.length <= 6);
    if (expectedCats) assert.deepEqual(cats, expectedCats);
}

test('raw CID vector and one-member original review without any Ledger settings', async t => {
    assert.equal(cidFor('hello world'), 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    const f = await setup(t);
    const report = await f.run();
    assert.equal(report.status, 'verified', JSON.stringify(report));
    assert.equal(report.reason, 'batch_member_verified');
    assert.equal(evidenceExitCode(report), 0);
    assert.equal(report.format, 'cid-lines');
    assert.equal(report.memberCount, 1);
    assert.deepEqual(report.memberIndexes, [0]);
    assert.deepEqual(report.message, f.message);
    assert.deepEqual(report.checks, { manifest: 'verified', manifestFormat: 'verified', membership: 'verified', member: 'verified',
        signature: 'verified', signer: 'not_requested', ledger: 'not_requested', semantics: 'not_assessed' });
    assert.equal(report.signer, f.wallet.address.toLowerCase());
    assert.equal(report.textBytes, Buffer.byteLength(f.message.text));
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    readOnly(f, [f.record.manifestCid, f.record.memberCid]);
});

test('CID lines: ordered members, duplicate positions and unfetched unavailable neighbors', async t => {
    const f = await setup(t);
    const other = cidFor('never fetched');
    const members = [other, f.record.memberCid, f.record.memberCid, cidFor('also unavailable')];
    f.manifest(members.join('\n'));
    f.record.signer = f.wallet.address;
    const report = await f.run();
    assert.equal(report.status, 'verified', JSON.stringify(report));
    assert.equal(report.memberCount, 4);
    assert.deepEqual(report.memberIndexes, [1, 2]);
    assert.equal(report.checks.signer, 'verified');
    assert.equal(report.format, 'cid-lines');
    readOnly(f, [f.record.manifestCid, f.record.memberCid]);
});

for (const metadata of [false, true]) test(`unmerged JSON ${metadata ? 'execution' : 'CID-list'} manifest is rejected`, async t => {
    const f = await setup(t);
    f.manifest(JSON.stringify(unmergedJson([f.record.memberCid], metadata)));
    f.withLedger();
    assert.throws(() => parseBatchManifest(f.state.content.get(f.record.manifestCid)), /invalid_manifest/);
    const report = await f.run();
    assert.equal(report.status, 'mismatch');
    assert.equal(report.reason, 'invalid_manifest');
    assert.equal(evidenceExitCode(report), 2);
    assert.deepEqual(report.checks, { manifest: 'verified', manifestFormat: 'mismatch', membership: 'not_checked', member: 'not_checked',
        signature: 'not_checked', signer: 'not_requested', ledger: 'not_checked', semantics: 'not_assessed' });
    assert.equal(report.message, undefined);
    assert.equal(report.format, undefined);
    assert.equal(report.legacyMetadata, undefined);
    readOnly(f, [f.record.manifestCid]);
});

test('both raw CID bindings precede signature claims, even for otherwise valid signatures', async t => {
    for (const target of ['manifest', 'member']) {
        const f = await setup(t);
        const substituted = target === 'manifest' ? Buffer.from(f.record.memberCid + '\n') : Buffer.from(JSON.stringify(await signedMessage(f.wallet, 'substitute')));
        f.state.content.set(f.record[`${target}Cid`], substituted);
        const report = await f.run();
        assert.equal(report.status, 'mismatch');
        assert.equal(report.reason, `${target}_cid_content`);
        assert.equal(report.checks[target], 'mismatch');
        assert.equal(report.checks.signature, 'not_checked');
        assert.equal(report.message, undefined);
        readOnly(f);
    }
});

for (const target of ['manifest', 'member']) {
    for (const codec of [0x70, 0x71]) test(`unsupported ${target} codec ${codec} is partial before fetching it`, async t => {
        const f = await setup(t);
        const old = f.record[`${target}Cid`];
        const cid = cidFor(f.state.content.get(old), codec);
        f.record[`${target}Cid`] = cid;
        f.state.content.set(cid, f.state.content.get(old));
        if (target === 'member') f.manifest(cid);
        f.withLedger();
        const report = await f.run();
        assert.equal(report.status, 'partial');
        assert.equal(evidenceExitCode(report), 4);
        assert.equal(report.reason, `${target}_cid_unsupported`);
        assert.equal(report.checks[target], 'unsupported');
        assert.equal(report.checks.signature, 'not_checked');
        assert.equal(report.checks.ledger, 'not_checked');
        assert.equal(report.message, undefined);
        readOnly(f, target === 'manifest' ? [] : [f.record.manifestCid]);
    });
}

test('missing membership stops before member retrieval or receipt verification', async t => {
    const f = await setup(t);
    f.manifest(cidFor('not the member'));
    f.withLedger();
    const report = await f.run();
    assert.equal(report.reason, 'member_not_listed');
    assert.equal(report.checks.membership, 'mismatch');
    assert.equal(report.checks.member, 'not_checked');
    assert.equal(report.checks.ledger, 'not_checked');
    readOnly(f, [f.record.manifestCid]);
});

const malformedManifests = [
    ['empty', () => ''], ['trailing LF', cid => cid + '\n'], ['leading LF', cid => '\n' + cid],
    ['CRLF', cid => cid + '\r\n' + cid], ['whitespace', cid => ' ' + cid],
    ['header', cid => 'oya-message-batch\n' + cid], ['BOM', cid => '\ufeff' + cid],
    ['invalid UTF-8', () => Buffer.from([255])], ['URL', () => 'https://untrusted.example/private'],
    ['IPFS URI', cid => 'ipfs://' + cid], ['path', cid => cid + '/file'], ['uppercase', cid => cid.toUpperCase()],
    ['array', cid => JSON.stringify([cid])], ['empty JSON list', () => JSON.stringify(unmergedJson([]))],
    ['unknown version', cid => JSON.stringify({ ...unmergedJson([cid]), version: 2 })],
    ['unknown type', cid => JSON.stringify({ ...unmergedJson([cid]), type: 'unknown' })],
    ['unknown field', cid => JSON.stringify({ ...unmergedJson([cid]), rpcUrl: 'https://untrusted.example' })],
    ['mixed entries', cid => JSON.stringify(unmergedJson([cid, { cid }]))],
    ['too many lines', cid => Array(101).fill(cid).join('\n')],
    ['too many JSON entries', cid => JSON.stringify(unmergedJson(Array(101).fill(cid)))],
    ['missing JSON digest', cid => JSON.stringify({ ...unmergedJson([cid], true), messages: [{ cid }] })],
    ['bad JSON digest', cid => JSON.stringify({ ...unmergedJson([cid], true), messages: [{ cid, messageDigest: 'secret' }] })],
    ['JSON UUID', cid => JSON.stringify({ ...unmergedJson([cid], true), batchId: 'invalid' })],
    ['JSON execution', cid => JSON.stringify({ ...unmergedJson([cid], true), execution: { mode: 'ipfs' } })],
    ['JSON extra entry field', cid => JSON.stringify({ ...unmergedJson([cid], true), messages: [{ cid, messageDigest: '0'.repeat(64), url: 'https://untrusted.example' }] })],
    ['truncated JSON', () => '{'], ['null entries', () => JSON.stringify(unmergedJson(null))],
];
for (const [name, build] of malformedManifests) test(`malformed manifest: ${name}`, async t => {
    const f = await setup(t);
    f.manifest(build(f.record.memberCid));
    const report = await f.run();
    assert.equal(report.status, 'mismatch', JSON.stringify(report));
    assert.equal(report.reason, 'invalid_manifest');
    assert.equal(report.checks.manifestFormat, 'mismatch');
    assert.equal(report.checks.membership, 'not_checked');
    assert.equal(report.checks.signature, 'not_checked');
    assert.ok(!JSON.stringify(report).includes('untrusted.example'));
    readOnly(f, [f.record.manifestCid]);
});

test('parser maximum, unsupported inputs and exact ordered list are bounded', async () => {
    const members = Array.from({ length: 100 }, (_, i) => cidFor(String(i)));
    assert.deepEqual(parseBatchManifest(Buffer.from(members.join('\n'))), { format: 'cid-lines', members });
    for (const bytes of [undefined, null, '', {}, Buffer.alloc(131073)]) assert.throws(() => parseBatchManifest(bytes), /invalid_manifest/);
});

const invalidMessages = [
    ['modified text', message => ({ ...message, text: 'changed' })],
    ['wrong signer', message => ({ ...message, signer: sender })],
    ['invalid signature', message => ({ ...message, signature: '0x' + '00'.repeat(65) })],
    ['missing signature', message => ({ text: message.text, signer: message.signer })],
    ['extra envelope', message => ({ message })], ['extra fields', message => ({ ...message, rpcUrl: 'https://untrusted.example' })],
    ['non-string text', message => ({ ...message, text: 123 })], ['null', () => null], ['array', () => []],
];
for (const [name, mutate] of invalidMessages) test(`original signed envelope: ${name}`, async t => {
    const f = await setup(t);
    f.member(JSON.stringify(mutate(f.message)));
    const report = await f.run();
    assert.equal(report.status, 'mismatch');
    assert.equal(report.reason, 'invalid_signed_message');
    assert.equal(report.checks.member, 'verified');
    assert.equal(report.checks.signature, 'mismatch');
    assert.equal(report.message, undefined);
    readOnly(f);
});

test('original bytes, whitespace and field order survive review without reserialization', async t => {
    const f = await setup(t);
    const original = { signature: f.message.signature, text: f.message.text, signer: f.message.signer };
    f.member(' \n' + JSON.stringify(original, null, 2) + '\n');
    const report = await f.run();
    assert.equal(report.status, 'verified');
    assert.deepEqual(report.message, original);
    assert.equal(report.memberBytes, f.state.content.get(f.record.memberCid).length);
    assert.notEqual(f.record.memberCid, cidFor(JSON.stringify(f.message)));
    readOnly(f);
});

test('invalid member JSON and UTF-8 fail after byte verification', async t => {
    for (const bytes of [Buffer.from([255]), Buffer.from('{broken')]) {
        const f = await setup(t);
        f.member(bytes);
        const report = await f.run();
        assert.equal(report.reason, 'invalid_signed_message');
        assert.equal(report.checks.member, 'verified');
        assert.equal(report.checks.signature, 'mismatch');
    }
});

test('kernel ASCII-only message schema is preserved even for genuine Unicode signatures', async t => {
    const f = await setup(t);
    f.member(JSON.stringify(await signedMessage(f.wallet, 'Unicode snowman ☃')));
    const report = await f.run();
    assert.equal(report.reason, 'invalid_signed_message');
    assert.equal(report.checks.member, 'verified');
    assert.equal(report.checks.signature, 'mismatch');
});

test('maximum-sized member bytes verify, larger bodies stop before signature work', async t => {
    const f = await setup(t);
    const emptySize = Buffer.byteLength(JSON.stringify({ ...f.message, text: '' }));
    const text = 'a'.repeat(131072 - emptySize);
    const message = await signedMessage(f.wallet, text);
    f.member(JSON.stringify(message));
    assert.equal(f.state.content.get(f.record.memberCid).length, 131072);
    assert.equal((await f.run()).status, 'verified');
    f.member(JSON.stringify(await signedMessage(f.wallet, text + 'a')));
    const report = await f.run();
    assert.equal(report.reason, 'body_limit');
    assert.equal(report.checks.signature, 'not_checked');
});

test('redirect cannot forward explicit authentication to another endpoint', async t => {
    const destination = await setup(t);
    const f = await setup(t);
    f.settings.ipfsAuthorization = 'Bearer private-test-header';
    f.state.hook = (_req, res) => {
        res.writeHead(307, { location: destination.settings.ipfsUrl }); res.end(); return true;
    };
    const report = await f.run();
    assert.equal(report.status, 'unavailable');
    assert.equal(destination.state.requests.length, 0);
    assert.ok(!JSON.stringify(report).includes('private-test-header'));
});

test('optional RPC and IPFS credentials are independently scoped', async t => {
    const f = await setup(t);
    f.withLedger();
    f.settings.ipfsAuthorization = 'Bearer ipfs-test-header';
    f.settings.ledger.rpcAuthorization = 'Bearer rpc-test-header';
    const report = await f.run();
    assert.equal(report.status, 'verified');
    for (const req of f.state.requests) assert.equal(req.authorization,
        req.url === '/rpc' ? f.settings.ledger.rpcAuthorization : f.settings.ipfsAuthorization);
    assert.ok(!JSON.stringify(report).includes('test-header'));
    readOnly(f);
});

test('independent expected signer fails without confusing message author and logging caller', async t => {
    const f = await setup(t);
    f.record.signer = caller;
    const report = await f.run();
    assert.equal(report.reason, 'signer_identity');
    assert.equal(report.checks.signature, 'verified');
    assert.equal(report.checks.signer, 'mismatch');
    assert.equal(report.message, undefined);
});

test('separate Ledger check permits forwarding with CID-line manifests', async t => {
    const f = await setup(t);
    f.withLedger();
    const report = await f.run();
    assert.equal(report.status, 'verified', JSON.stringify(report));
    assert.equal(report.reason, 'batch_member_and_ledger_verified');
    assert.equal(report.checks.ledger, 'verified');
    assert.equal(report.ledger.nodeAddress, caller);
    assert.notEqual(report.ledger.nodeAddress, f.state.receipt.from);
    assert.notEqual(report.ledger.nodeAddress, report.signer);
    readOnly(f, [f.record.manifestCid, f.record.memberCid, f.record.manifestCid]);
    f.state.requests = [];
    f.record.ledger.nodeAddress = sender;
    const wrong = await f.run();
    assert.equal(wrong.status, 'mismatch');
    assert.equal(wrong.ledger.reason, 'node_identity');
    assert.equal(wrong.checks.signature, 'verified');
    readOnly(f);
});

for (const [name, mutate, status] of [
    ['chain', f => { f.state.chain = '0x1'; }, 'mismatch'],
    ['contract', f => { f.settings.ledger.ledgerContract = sender; }, 'mismatch'],
    ['manifest CID', f => { Object.assign(f.state.receipt.logs[0], encode(f.record.memberCid)); }, 'mismatch'],
    ['receipt', f => { f.state.receipt = null; }, 'unavailable'],
    ['revert', f => { f.state.receipt.status = '0x0'; }, 'mismatch'],
    ['log index', f => { f.record.ledger.logIndex = 0; }, 'mismatch'],
    ['block', f => { f.state.block.hash = txHash; }, 'mismatch'],
]) test(`optional Ledger ${name} failure preserves independent member verification`, async t => {
    const f = await setup(t);
    f.withLedger(); mutate(f);
    const report = await f.run();
    assert.equal(report.status, status, JSON.stringify(report));
    assert.equal(report.reason, 'ledger_evidence_failed');
    assert.equal(report.checks.signature, 'verified');
    assert.equal(report.checks.member, 'verified');
    assert.equal(report.ledger.status, status);
    readOnly(f);
});

test('changed manifest on independent Ledger reread cannot produce overall success', async t => {
    const f = await setup(t);
    f.withLedger();
    let count = 0;
    f.state.hook = (req, res) => {
        if (req.url !== `/api/v0/cat?arg=${f.record.manifestCid}` || ++count !== 2) return false;
        res.end('substitute'); return true;
    };
    const report = await f.run();
    assert.equal(report.status, 'mismatch');
    assert.equal(report.ledger.reason, 'cid_content');
    assert.equal(report.checks.ledger, 'verified');
    assert.equal(report.checks.member, 'verified');
    readOnly(f);
});

for (const target of ['manifest', 'member']) for (const kind of ['missing', 'oversize', 'chunked', 'stalled', 'body_stalled', 'redirect', 'disconnect']) {
    test(`${target} retrieval ${kind} is bounded and sanitized`, async t => {
        const f = await setup(t);
        f.settings.requestTimeoutMs = 80;
        f.state.hook = (req, res) => {
            if (req.url !== `/api/v0/cat?arg=${f.record[`${target}Cid`]}`) return false;
            if (kind === 'missing') { res.writeHead(404); res.end('provider-secret'); }
            if (kind === 'oversize') { res.writeHead(200, { 'content-length': 131073 }); res.end(); }
            if (kind === 'chunked') { res.writeHead(200); res.end(Buffer.alloc(131073)); }
            if (kind === 'body_stalled') { res.writeHead(200); res.write('x'); }
            if (kind === 'redirect') { res.writeHead(307, { location: '/forbidden' }); res.end(); }
            if (kind === 'disconnect') res.destroy();
            return true;
        };
        const report = await f.run();
        assert.equal(report.status, 'unavailable', JSON.stringify(report));
        assert.equal(report.checks[target], 'unavailable');
        assert.equal(report.checks.signature, 'not_checked');
        assert.ok(!JSON.stringify(report).includes('provider-secret'));
        readOnly(f);
    });
}

test('shared deadline covers member reads and optional Ledger work', async t => {
    for (const withLedger of [false, true]) {
        const f = await setup(t);
        if (withLedger) f.withLedger();
        f.settings.timeoutMs = 150;
        f.state.hook = (req, res, body) => {
            if (req.url === `/api/v0/cat?arg=${f.record.manifestCid}`) {
                setTimeout(() => res.end(f.state.content.get(f.record.manifestCid)), 60); return true;
            }
            return withLedger ? body?.method === 'eth_chainId' : req.url === `/api/v0/cat?arg=${f.record.memberCid}`;
        };
        const report = await f.run();
        assert.equal(report.status, 'unavailable');
        assert.equal(withLedger ? report.ledger.reason : report.reason, 'deadline');
        readOnly(f);
    }
});

test('invalid records and settings fail before any HTTP and never echo secrets', async t => {
    const f = await setup(t);
    for (const input of [undefined, null, [], true, 'private-secret']) {
        assert.equal((await verifyBatchEvidence(input, f.settings)).reason, 'invalid_record');
        assert.equal((await verifyBatchEvidence(f.record, input)).reason, 'invalid_settings');
    }
    for (const patch of [{ memberCid: 'https://untrusted.example' }, { manifestCid: f.record.manifestCid + '\n' },
        { signer: 'private-secret' }, { privateKey: 'private-secret' }, { ledger: { transactionHash: txHash, logIndex: 0 } }]) {
        assert.equal((await verifyBatchEvidence({ ...f.record, ...patch }, f.settings)).reason, 'invalid_record');
    }
    for (const patch of [{ ipfsUrl: 'file:///private' }, { ipfsUrl: 'http://remote.example' },
        { ipfsUrl: 'https://user:secret@example.com' }, { ipfsUrl: 'https://example.com?secret=1' },
        { ipfsAuthorization: 'secret\nheader' }, { timeoutMs: 120001 }, { timeoutMs: 0 }, { requestTimeoutMs: 30001 },
        { privateKey: 'private-secret' }, { ledger: { rpcUrl: 'https://rpc.example' } }]) {
        const report = await verifyBatchEvidence(f.record, { ...f.settings, ...patch });
        assert.equal(report.reason, 'invalid_settings');
        assert.ok(!JSON.stringify(report).includes('secret'));
    }
    f.withLedger();
    for (const patch of [{ cid: f.record.memberCid }, { transactionHash: 'bad' }, { logIndex: -1 }, { nodeAddress: 'bad' }, { contentSha256: '0'.repeat(64) }]) {
        assert.equal((await verifyBatchEvidence({ ...f.record, ledger: { ...f.record.ledger, ...patch } }, f.settings)).reason, 'invalid_record');
    }
    assert.equal((await verifyBatchEvidence({ manifestCid: f.record.manifestCid, memberCid: f.record.memberCid }, f.settings)).reason, 'invalid_record');
    assert.equal(f.state.requests.length, 0);
});

async function cli(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', join(runtime, 'test/evidence-read-guard.mjs'), join(runtime, 'src/verify-batch.mjs'), ...args],
            { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OYA_NODE_PRIVATE_KEY: 'must-not-read', OYA_IPFS_AUTHORIZATION: 'must-not-inherit' } });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

test('guarded real CLI reports all exit codes, reads only explicit files and preserves them', async t => {
    const f = await setup(t);
    const dir = await mkdtemp(join(tmpdir(), 'oya-batch-review-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const paths = [join(dir, 'record.json'), join(dir, 'settings.json')];
    f.settings.ipfsAuthorization = 'Bearer test-only-secret';
    for (const [status, code] of [['verified', 0], ['partial', 4], ['mismatch', 2], ['unavailable', 3]]) {
        if (status === 'partial') f.record.memberCid = cidFor('unsupported', 0x70);
        if (status === 'mismatch') f.record.memberCid = cidFor('wrong bytes');
        if (status === 'unavailable') f.state.content.delete(f.record.manifestCid);
        else {
            f.manifest(f.record.memberCid);
            if (status === 'mismatch') f.state.content.set(f.record.memberCid, Buffer.from('corrupt'));
        }
        const originals = [JSON.stringify(f.record), JSON.stringify(f.settings)];
        await Promise.all(paths.map((path, i) => writeFile(path, originals[i])));
        f.state.requests = [];
        const result = await cli(paths);
        assert.equal(result.code, code, result.stdout + result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(JSON.parse(result.stdout).status, status);
        assert.ok(!result.stdout.includes('test-only-secret'));
        assert.ok(!result.stdout.includes(f.settings.ipfsUrl));
        for (const request of f.state.requests) assert.equal(request.authorization, f.settings.ipfsAuthorization);
        assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), originals);
        readOnly(f);
    }
    for (const [args, expected] of [[[], 3], [[join(dir, 'missing'), paths[1]], 3], [[dir, paths[1]], 3]]) {
        const result = await cli(args);
        assert.equal(result.code, expected, result.stderr);
        assert.equal(JSON.parse(result.stdout).kind, 'batch-member');
        assert.ok(!result.stdout.includes(dir));
    }
    for (const input of ['{invalid', Buffer.from([255]), 'x'.repeat(65537)]) {
        await writeFile(paths[0], input);
        const result = await cli(paths);
        assert.equal(result.code, input.length > 65536 ? 3 : 2, result.stderr);
        assert.equal(JSON.parse(result.stdout).kind, 'batch-member');
    }
});

test('production HTTP publish/batch-log/retrieve/review uses actual original signed bytes', async t => {
    const review = await setup(t);
    const directory = await mkdtemp(join(tmpdir(), 'oya-batch-cycle-'));
    const f = await fixture(t, { batchLogging: { stateDirectory: directory, maxMessages: 2, maxWaitMs: 60000 } });
    const uploads = [];
    let loggedCid, receipt;
    const transport = async (url, request) => {
        if (url.startsWith(f.config.ipfs.url)) {
            const bytes = Buffer.from(await request.body.get('file').arrayBuffer());
            const cid = review.store(bytes);
            uploads.push({ bytes, cid });
            return new Response(JSON.stringify({ Hash: cid }));
        }
        const body = JSON.parse(request.body);
        const response = await f.transport(url, request);
        const reply = await response.json();
        if (body.method === 'eth_getTransactionReceipt') {
            if (!f.state.transactions.some(tx => tx.hash === body.params[0])) reply.result = null;
            else {
                Object.assign(reply.result.logs[0], encode(loggedCid, f.wallet.address));
                receipt = reply.result;
            }
        }
        return new Response(JSON.stringify(reply));
    };
    const signer = { address: f.signer.address, async signTransaction(tx, signal) {
        loggedCid = abi.decodeFunctionData('log', tx.data)[0];
        return f.signer.signTransaction(tx, signal);
    } };
    const node = await startNode(f.config, signer, { fetch: transport, log: () => {} });
    t.after(async () => { await node.close(); await rm(directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${node.server.address().port}`;
    const messages = [await signedMessage(f.agent, 'First independent original'), await signedMessage(f.agent, 'Second independent original')];
    const admissions = [];
    for (const message of messages) {
        const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
        assert.equal(response.status, 202);
        admissions.push(await response.json());
    }
    let status;
    for (let i = 0; i < 150; i++) {
        status = await (await fetch(url + '/v1/batches')).json();
        if (status.recent.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.recent[0]?.status, 'logged');
    assert.equal(f.state.sends, 1);
    assert.equal(f.state.signs, 1);
    assert.equal(uploads.length, 3);
    assert.equal(f.state.transactions[0].from, f.wallet.address);
    assert.equal(abi.decodeFunctionData('log', f.state.transactions[0].data)[0], uploads[2].cid);
    assert.equal(uploads[2].bytes.toString(), uploads.slice(0, 2).map(value => value.cid).join('\n'));
    for (let i = 0; i < 2; i++) {
        assert.deepEqual(JSON.parse(uploads[i].bytes), messages[i]);
        assert.equal(admissions[i].publication.cid, uploads[i].cid);
    }
    review.state.receipt = receipt;
    review.state.block = { hash: receipt.blockHash, number: receipt.blockNumber, timestamp: '0x123' };
    review.record.manifestCid = uploads[2].cid;
    review.record.memberCid = uploads[0].cid;
    review.withLedger();
    review.record.ledger = { transactionHash: receipt.transactionHash, logIndex: 0, nodeAddress: f.wallet.address };
    review.record.signer = f.agent.address;
    const paths = [join(directory, 'record.json'), join(directory, 'settings.json')];
    await writeFile(paths[0], JSON.stringify(review.record));
    await writeFile(paths[1], JSON.stringify(review.settings));
    const result = await cli(paths);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.reason, 'batch_member_and_ledger_verified');
    assert.deepEqual(report.message, messages[0]);
    assert.equal(report.ledger.transactionHash, f.state.transactions[0].hash);
    assert.equal(report.ledger.nodeAddress, f.wallet.address.toLowerCase());
    assert.equal(report.signer, f.agent.address.toLowerCase());
    assert.deepEqual(report.memberIndexes, [0]);
    assert.equal(report.memberCount, 2);
    readOnly(review, [uploads[2].cid, uploads[0].cid, uploads[2].cid]);
});

test('CLI and library stay read-only and are included in the runtime build allowlist', async () => {
    const ignore = await readFile(join(runtime, '.dockerignore'), 'utf8');
    for (const name of ['batch-evidence', 'verify-batch']) {
        const source = await readFile(join(runtime, `src/${name}.mjs`), 'utf8');
        assert.doesNotMatch(source, /from ['"]\..*(?:inbox|processor|worker|signer|secrets)/);
        assert.doesNotMatch(source, /process\.env|Wallet|signMessage|signTransaction|sendRawTransaction|\/v1\/|\/api\/v0\/(?:add|pin)/);
        assert.ok(ignore.includes(`!src/${name}.mjs`));
    }
});
