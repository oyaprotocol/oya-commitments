import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Interface, getIcapAddress } from 'ethers';
import { hashLedgerCid } from '@oyaprotocol/ethereum';
import { verifyLedgerEvidence, evidenceExitCode, readEvidenceJson } from '../src/ledger-evidence.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function cidFor(bytes, codec = 0x55) {
    const input = Buffer.concat([Buffer.from([1, codec, 0x12, 0x20]), Buffer.from(sha256(bytes), 'hex')]);
    let result = 'b', accumulator = 0, bits = 0;
    for (const byte of input) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; result += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator >> bits) & 31]; }
    }
    if (bits) result += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator << (5 - bits)) & 31];
    return result;
}
const content = Buffer.from([0, 255, 128, 1, 10, 13]);
const cid = cidFor(content);
const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const ledger = `0x${'11'.repeat(20)}`;
const node = `0x${'22'.repeat(20)}`;
const other = `0x${'33'.repeat(20)}`;
const abi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
const runtime = fileURLToPath(new URL('../', import.meta.url));
const encode = (cid, publisher = node) => abi.encodeEventLog(abi.getEvent('Log'), [publisher, hashLedgerCid(cid), cid]);

async function setup(t) {
    const record = { transactionHash: txHash, logIndex: 7 };
    const state = {
        chain: '0x7a69', block: { hash: blockHash, number: '0x2', timestamp: '0x123' },
        receipt: { transactionHash: txHash, blockHash, blockNumber: '0x2', transactionIndex: '0x0',
            from: other, to: other, contractAddress: null, status: '0x1', gasUsed: '0x8000',
            cumulativeGasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`,
            logs: [{ ...encode(cid), address: ledger, transactionHash: txHash, blockHash, blockNumber: '0x2',
                transactionIndex: '0x0', logIndex: '0x7', removed: false }] },
        cid, content: Buffer.from(content), requests: [], hook: undefined,
    };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString();
        const body = text ? JSON.parse(text) : undefined;
        state.requests.push({ url: req.url, method: req.method, body, auth: req.headers.authorization });
        if (state.hook?.(req, res, body)) return;
        if (req.url === `/api/v0/cat?arg=${state.cid}`) { res.end(state.content); return; }
        if (req.url !== '/rpc') { res.writeHead(500); res.end(); return; }
        const results = { eth_chainId: state.chain, eth_getTransactionReceipt: state.receipt, eth_getBlockByNumber: state.block };
        if (!(body.method in results)) { res.writeHead(500); res.end(); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const config = { chainId: 31337, ledgerContract: ledger,
        rpcUrl: url + '/rpc', ipfsUrl: url, timeoutMs: 3000, requestTimeoutMs: 1000 };
    return { record, config, state, run: () => verifyLedgerEvidence(record, config) };
}
function setContent(f, bytes, codec = 0x55) {
    f.state.content = bytes;
    f.state.cid = cidFor(bytes, codec);
    Object.assign(f.state.receipt.logs[0], encode(f.state.cid));
}
function readOnly(state) {
    for (const request of state.requests) {
        assert.equal(request.method, 'POST');
        if (request.url === '/rpc') assert.ok(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(request.body.method));
        else assert.equal(request.url, `/api/v0/cat?arg=${state.cid}`);
    }
    const routes = state.requests.map(r => r.url === '/rpc' ? r.body.method : r.url);
    assert.equal(new Set(routes).size, routes.length, 'no automatic retries');
    assert.ok(routes.length <= 4);
}

test('source-independent binary log verifies without any job, inbox, signature or node identity setting', async t => {
    const f = await setup(t);
    const report = await f.run();
    assert.equal(report.status, 'verified', JSON.stringify(report));
    assert.equal(report.version, 2);
    assert.equal(evidenceExitCode(report), 0);
    assert.deepEqual(report.block, { number: '2', hash: blockHash, timestamp: '291' });
    assert.equal(report.transactionHash, txHash);
    assert.equal(report.logIndex, 7);
    assert.equal(report.nodeAddress, node);
    assert.equal(report.cid, cid);
    assert.equal(report.contentBytes, content.length);
    assert.deepEqual(report.checks, { ledger: 'verified', availability: 'available', content: 'verified',
        cidBinding: 'verified', semantics: 'not_assessed' });
    assert.equal(report.contentVerification, 'cid_sha256');
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    assert.equal(f.state.requests.length, 4);
    assert.deepEqual(f.state.requests[0].body.params, []);
    readOnly(f.state);
});

test('fixed SHA-256 CID test vector prevents shared fixture encoder mistakes', async t => {
    const f = await setup(t);
    setContent(f, Buffer.from('hello world'));
    // Independent Python hashlib/base64 calculation of CIDv1(raw, sha2-256).
    assert.equal(f.state.cid, 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    assert.equal((await f.run()).status, 'verified');
});

test('arbitrary JSON, UTF-8, empty and boundary-sized bytes are verified without interpreting semantics', async t => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('{"claim":"not established"}'), Buffer.from('☃\n'), Buffer.alloc(131072, 42)]) {
        const f = await setup(t);
        setContent(f, bytes);
        const report = await f.run();
        assert.equal(report.status, 'verified', JSON.stringify(report));
        assert.equal(report.contentBytes, bytes.length);
        assert.equal(report.checks.semantics, 'not_assessed');
    }
});

test('optional independent expectations are all enforced, including caller distinct from transaction sender', async t => {
    const f = await setup(t);
    Object.assign(f.record, { cid, nodeAddress: node, contentSha256: sha256(content) });
    const report = await f.run();
    assert.equal(report.status, 'verified');
    assert.equal(report.contentVerification, 'cid_sha256_and_expected_sha256');
    assert.equal(report.expected.nodeAddress, node);
});

test('non-raw codecs report partial integrity unless an independent content digest is supplied', async t => {
    for (const codec of [0x70, 0x71]) {
        const f = await setup(t);
        setContent(f, Buffer.from('retrieved projection, not the root block'), codec);
        let report = await f.run();
        assert.equal(report.status, 'partial');
        assert.equal(evidenceExitCode(report), 4);
        assert.equal(report.checks.ledger, 'verified');
        assert.equal(report.checks.availability, 'available');
        assert.equal(report.checks.content, 'unsupported');
        assert.equal(report.checks.cidBinding, 'not_checked');
        assert.equal(report.contentVerification, null);
        f.record.contentSha256 = sha256(f.state.content);
        report = await f.run();
        assert.equal(report.status, 'verified');
        assert.equal(report.contentVerification, 'expected_sha256');
        assert.equal(report.checks.cidBinding, 'not_checked');
        f.state.content = Buffer.from('substituted bytes');
        report = await f.run();
        assert.equal(report.status, 'mismatch');
        assert.equal(report.reason, 'expected_content');
        assert.equal(report.checks.availability, 'available');
    }
});

test('wrong bytes remain available but fail integrity; an expected hash cannot override a raw CID', async t => {
    const f = await setup(t);
    f.state.content = Buffer.from('corrupt');
    f.record.contentSha256 = sha256(f.state.content);
    const report = await f.run();
    assert.equal(report.reason, 'cid_content');
    assert.equal(report.checks.ledger, 'verified');
    assert.equal(report.checks.availability, 'available');
    assert.equal(report.checks.content, 'mismatch');
    assert.equal(report.checks.cidBinding, 'mismatch');
});

test('selects block-global log index, not array offset or any matching event', async t => {
    const f = await setup(t);
    f.state.receipt.logs.unshift({ ...f.state.receipt.logs[0], logIndex: '0x6', ...encode(cid, other) });
    f.record.nodeAddress = node;
    assert.equal((await f.run()).status, 'verified');
    f.record.logIndex = 6;
    assert.equal((await f.run()).reason, 'node_identity');
    f.record.logIndex = 1;
    assert.equal((await f.run()).reason, 'log_missing');
});

test('contract creation and unrelated malformed Ledger event do not constrain the selected valid log', async t => {
    const f = await setup(t);
    f.state.receipt.to = null;
    f.state.receipt.contractAddress = other;
    f.state.receipt.logs.push({ ...f.state.receipt.logs[0], logIndex: '0x8', data: '0x' });
    assert.equal((await f.run()).status, 'verified');
});

const mismatchCases = [
    ['expected publisher', f => { f.record.nodeAddress = other; }],
    ['expected CID', f => { f.record.cid = cidFor(Buffer.from('other')); }],
    ['expected digest', f => { f.record.contentSha256 = '0'.repeat(64); }],
    ['expected Ledger', f => { f.config.ledgerContract = other; }],
    ['oversized block number', f => { f.state.receipt.blockNumber = '0x' + 'f'.repeat(65); }],
    ['chain', f => { f.state.chain = '0x1'; }],
    ['noncanonical chain quantity', f => { f.state.chain = '0x07a69'; }],
    ['receipt hash', f => { f.state.receipt.transactionHash = blockHash; }],
    ['reverted receipt', f => { f.state.receipt.status = '0x0'; }],
    ['malformed receipt', f => { f.state.receipt = {}; }],
    ['missing event', f => { f.state.receipt.logs = []; }],
    ['duplicate index', f => { f.state.receipt.logs.push(structuredClone(f.state.receipt.logs[0])); }],
    ['wrong log contract', f => { f.state.receipt.logs[0].address = other; }],
    ['unrelated event', f => { f.state.receipt.logs[0].topics[0] = blockHash; }],
    ['wrong CID hash', f => { f.state.receipt.logs[0].topics[2] = blockHash; }],
    ['malformed event data', f => { f.state.receipt.logs[0].data = '0x'; }],
    ['removed event', f => { f.state.receipt.logs[0].removed = true; }],
    ['malformed removed', f => { f.state.receipt.logs[0].removed = 'false'; }],
    ['log block number', f => { f.state.receipt.logs[0].blockNumber = '0x3'; }],
    ['log block hash', f => { f.state.receipt.logs[0].blockHash = txHash; }],
    ['log transaction hash', f => { f.state.receipt.logs[0].transactionHash = blockHash; }],
    ['log transaction index', f => { f.state.receipt.logs[0].transactionIndex = '0x1'; }],
    ['block hash changed', f => { f.state.block.hash = txHash; }],
    ['block number changed', f => { f.state.block.number = '0x3'; }],
    ['malformed block timestamp', f => { f.state.block.timestamp = 'today'; }],
    ['wrong bytes', f => { f.state.content = Buffer.from('different'); }],
];
for (const [name, mutate] of mismatchCases) {
    test(`mismatch: ${name}`, async t => {
        const f = await setup(t);
        mutate(f);
        const report = await f.run();
        assert.equal(report.status, 'mismatch', JSON.stringify(report));
        assert.equal(evidenceExitCode(report), 2);
        readOnly(f.state);
    });
}

test('unsupported CID syntax in a validly encoded event fails before content retrieval', async t => {
    const f = await setup(t);
    // Ledger accepts opaque strings; this verifier deliberately accepts only the kernel CID format.
    const invalid = 'https://untrusted.example/private';
    Object.assign(f.state.receipt.logs[0], abi.encodeEventLog(abi.getEvent('Log'), [node, blockHash, invalid]));
    const report = await f.run();
    assert.equal(report.status, 'mismatch');
    assert.equal(report.stage, 'event');
    assert.equal(report.checks.availability, 'not_checked');
    assert.ok(!JSON.stringify(report).includes('untrusted.example'));
    assert.ok(f.state.requests.every(req => req.url === '/rpc'));
});

test('binary content never supplies endpoints or executable validators', async t => {
    const f = await setup(t);
    setContent(f, Buffer.from('{"rpcUrl":"https://untrusted.example","validator":"throw Error()"}'));
    assert.equal((await f.run()).status, 'verified');
    readOnly(f.state);
});

test('missing, array and primitive inputs fail closed without throwing or performing HTTP', async t => {
    const f = await setup(t);
    for (const invalid of [undefined, null, [], true, 12, 'secret']) {
        assert.equal((await verifyLedgerEvidence(invalid, f.config)).reason, 'invalid_record');
        assert.equal((await verifyLedgerEvidence(f.record, invalid)).reason, 'invalid_settings');
    }
    assert.equal(f.state.requests.length, 0);
});

test('duplicate CIDs at different log indices are independently selectable', async t => {
    const f = await setup(t);
    f.state.receipt.logs.push({ ...f.state.receipt.logs[0], logIndex: '0x8' });
    f.record.logIndex = 8;
    const report = await f.run();
    assert.equal(report.status, 'verified');
    assert.equal(report.logIndex, 8);
});

test('invalid record fields and obsolete job inputs fail before HTTP', async t => {
    for (const patch of [{ transactionHash: 'private-invalid' }, { transactionHash: txHash + '\n' },
        { logIndex: -1 }, { logIndex: '7' }, { logIndex: 1.5 }, { logIndex: Number.MAX_SAFE_INTEGER + 1 },
        { logIndex: null }, { logIndex: undefined }, { cid: '../secret' }, { cid: cid + 'a' },
        { contentSha256: 'secret' }, { contentSha256: 'A'.repeat(64) }, { nodeAddress: 'bad' },
        { target: 'old-job' }, { message: {} }, { rpcUrl: 'https://untrusted.example' }]) {
        const f = await setup(t);
        Object.assign(f.record, patch);
        assert.equal((await f.run()).reason, 'invalid_record');
        assert.equal(f.state.requests.length, 0);
    }
});

test('invalid addresses fail before HTTP without echoing inputs', async t => {
    for (const value of [null, {}, 'secret-address', '0x8ba1f109551bD432803012645Ac136ddd64DBA72\n',
        '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', 'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK37', `0x${'0'.repeat(40)}`]) {
        for (const scope of ['record', 'config']) {
            const f = await setup(t);
            f[scope][scope === 'record' ? 'nodeAddress' : 'ledgerContract'] = value;
            const report = await f.run();
            assert.equal(report.status, 'mismatch');
            assert.equal(report.stage, 'input');
            assert.equal(f.state.requests.length, 0);
            assert.equal(report.expected, undefined);
            assert.ok(!JSON.stringify(report).includes('secret-address'));
        }
    }
});

test('hex casing, prefixless hex and direct ICAP preserve normalized expected identities', async t => {
    for (const form of [value => value.toLowerCase(), value => `0x${value.slice(2).toUpperCase()}`,
        value => value.slice(2), getIcapAddress]) {
        const f = await setup(t);
        const address = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
        f.config.ledgerContract = f.record.nodeAddress = form(address);
        f.state.receipt.logs[0].address = address;
        Object.assign(f.state.receipt.logs[0], encode(cid, address));
        const report = await f.run();
        assert.equal(report.status, 'verified');
        assert.equal(report.expected.nodeAddress, address.toLowerCase());
        assert.equal(report.expected.ledgerContract, address.toLowerCase());
    }
});

for (const field of ['receipt', 'block']) {
    test(`missing ${field} is unavailable`, async t => {
        const f = await setup(t);
        f.state[field] = null;
        const report = await f.run();
        assert.equal(report.status, 'unavailable');
        assert.equal(report.checks.ledger, 'unavailable');
        assert.equal(report.checks.availability, 'not_checked');
        readOnly(f.state);
    });
}
for (const route of ['/rpc', `/api/v0/cat?arg=${cid}`]) {
    for (const kind of ['http', 'oversize', 'chunked', 'timeout', 'body_timeout', 'redirect', 'disconnect', 'corrupt']) {
        test(`${route} ${kind} is bounded and sanitized`, async t => {
            const f = await setup(t);
            f.config.requestTimeoutMs = 80;
            f.state.hook = (req, res) => {
                if (req.url !== route) return false;
                if (kind === 'http') { res.writeHead(503); res.end('provider-secret'); }
                if (kind === 'oversize') { res.writeHead(200, { 'content-length': 200000 }); res.end(); }
                if (kind === 'chunked') { res.writeHead(200); res.end('x'.repeat(131073)); }
                if (kind === 'timeout') { /* Client must abort a stalled response. */ }
                if (kind === 'body_timeout') { res.writeHead(200); res.write('{'); }
                if (kind === 'redirect') { res.writeHead(307, { location: '/forbidden' }); res.end(); }
                if (kind === 'disconnect') res.destroy();
                if (kind === 'corrupt') res.end('provider-secret');
                return true;
            };
            const report = await f.run();
            assert.equal(report.status, kind === 'corrupt' ? 'mismatch' : 'unavailable', JSON.stringify(report));
            if (route !== '/rpc') {
                assert.equal(report.checks.ledger, 'verified');
                assert.equal(report.checks.availability, kind === 'corrupt' ? 'available' : 'unavailable');
            }
            assert.ok(!JSON.stringify(report).includes('provider-secret'));
            readOnly(f.state);
        });
    }
}
for (const code of [301, 302, 303, 307, 308]) {
    test(`redirect ${code} cannot forward credentials`, async t => {
        const destination = await setup(t);
        for (const route of ['/rpc', `/api/v0/cat?arg=${cid}`]) {
            const f = await setup(t);
            f.config.rpcAuthorization = f.config.ipfsAuthorization = 'Bearer redirect-secret';
            f.state.hook = (req, res) => {
                if (req.url !== route) return false;
                res.writeHead(code, { location: destination.config.rpcUrl }); res.end(); return true;
            };
            const report = await f.run();
            assert.equal(report.status, 'unavailable');
            assert.equal(destination.state.requests.length, 0);
            assert.ok(!JSON.stringify(report).includes('redirect-secret'));
            readOnly(f.state);
        }
    });
}

test('unreachable endpoint and HTTP 404 content are unavailable', async t => {
    const f = await setup(t);
    const closed = createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    const original = f.config.rpcUrl;
    f.config.rpcUrl = `http://127.0.0.1:${port}`;
    assert.equal((await f.run()).reason, 'transport_failure');
    f.config.rpcUrl = original;
    f.state.hook = (req, res) => {
        if (!req.url.startsWith('/api/')) return false;
        res.writeHead(404); res.end('not found'); return true;
    };
    const report = await f.run();
    assert.equal(report.status, 'unavailable');
    assert.equal(report.checks.ledger, 'verified');
    assert.equal(report.checks.availability, 'unavailable');
});

test('overall deadline bounds multiple reads', async t => {
    const f = await setup(t);
    f.config.timeoutMs = 80;
    f.state.hook = (_req, res, body) => {
        if (body?.method === 'eth_chainId') {
            setTimeout(() => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: f.state.chain })), 40);
            return true;
        }
        return body?.method === 'eth_getTransactionReceipt';
    };
    const report = await f.run();
    assert.equal(report.reason, 'deadline');
    assert.equal(report.status, 'unavailable');
    readOnly(f.state);
});

test('RPC failures and malformed envelopes are distinguished and sanitized', async t => {
    for (const variant of ['error', 'id', 'version', 'both', 'neither', 'utf8']) {
        const f = await setup(t);
        f.state.hook = (req, res, body) => {
            if (req.url !== '/rpc') return false;
            const reply = { jsonrpc: '2.0', id: body.id, result: '0x7a69' };
            if (variant === 'id') reply.id = 999;
            if (variant === 'version') reply.jsonrpc = '1.0';
            if (['error', 'both'].includes(variant)) reply.error = { code: -32000, message: 'private-provider-detail' };
            if (['error', 'neither'].includes(variant)) delete reply.result;
            res.end(variant === 'utf8' ? Buffer.from([255]) : JSON.stringify(reply));
            return true;
        };
        const report = await f.run();
        assert.equal(report.status, variant === 'error' ? 'unavailable' : 'mismatch');
        assert.ok(!JSON.stringify(report).includes('private-provider-detail'));
        readOnly(f.state);
    }
});

test('strict settings reject unsafe endpoints, credentials, old inbox settings and excessive limits before HTTP', async t => {
    for (const patch of [{ privateKey: 'not-used' }, { target: '' }, { chainId: 0 }, { chainId: '31337' },
        { nodeAddress: node }, { inboxUrl: 'https://inbox.example' }, { ledgerContract: 'bad' },
        { rpcUrl: 'http://remote.example' }, { ipfsUrl: 'file:///etc/passwd' },
        { rpcUrl: 'https://user:secret@example.com' }, { ipfsUrl: 'https://example.com?secret=1' },
        { ipfsUrl: 'https://example.com#fragment' }, { timeoutMs: 120001 }, { requestTimeoutMs: 30001 },
        { requestTimeoutMs: 0 }, { rpcAuthorization: 'secret\nvalue' }]) {
        const f = await setup(t);
        Object.assign(f.config, patch);
        assert.equal((await f.run()).reason, 'invalid_settings');
        assert.equal(f.state.requests.length, 0);
    }
});

async function cli(recordPath, configPath, alias = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', join(runtime, 'test/evidence-read-guard.mjs'),
            ...(alias ? [join(runtime, 'src/inbox/client.mjs'), 'evidence'] : [join(runtime, 'src/verify-ledger.mjs')]),
            recordPath, configPath], {
            env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OYA_NODE_PRIVATE_KEY: 'must-not-read',
                OYA_AGENT_PRIVATE_KEY: 'must-not-read', OYA_RPC_AUTHORIZATION: 'must-not-inherit' },
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}
for (const alias of [false, true]) {
    test(`real ${alias ? 'alias' : 'standalone'} CLI uses only explicit reads and reports all exit codes`, async t => {
        const f = await setup(t);
        const dir = await mkdtemp(join(tmpdir(), 'oya-evidence-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const recordPath = join(dir, 'log.json'), configPath = join(dir, 'settings.json');
        f.config.rpcAuthorization = 'Bearer test-rpc-only';
        f.config.ipfsAuthorization = 'Bearer test-ipfs-only';
        const recordText = JSON.stringify(f.record), configText = JSON.stringify(f.config);
        await writeFile(recordPath, recordText);
        await writeFile(configPath, configText);
        for (const [status, code] of [['verified', 0], ['partial', 4], ['mismatch', 2], ['unavailable', 3]]) {
            f.state.requests = [];
            if (status === 'partial') setContent(f, content, 0x70);
            if (status === 'mismatch') { setContent(f, content); f.state.content = Buffer.from('wrong'); }
            if (status === 'unavailable') f.state.receipt = null;
            const result = await cli(recordPath, configPath, alias);
            assert.equal(result.code, code, result.stdout + result.stderr);
            assert.equal(result.stderr, '');
            assert.equal(JSON.parse(result.stdout).status, status);
            assert.ok(!result.stdout.includes('test-rpc-only'));
            assert.ok(!result.stdout.includes(f.config.ipfsUrl));
            readOnly(f.state);
            for (const req of f.state.requests) assert.equal(req.auth,
                req.url === '/rpc' ? f.config.rpcAuthorization : f.config.ipfsAuthorization);
        }
        assert.equal(await readFile(recordPath, 'utf8'), recordText);
        assert.equal(await readFile(configPath, 'utf8'), configText);
        const missing = await cli(join(dir, 'missing'), configPath, alias);
        assert.equal(missing.code, 3);
        assert.equal(JSON.parse(missing.stdout).reason, 'input_unreadable');
        assert.ok(!missing.stdout.includes(dir));
        for (const path of [recordPath, configPath]) {
            for (const invalid of ['{invalid-json', Buffer.from([0xff])]) {
                await writeFile(path, invalid);
                const malformed = await cli(recordPath, configPath, alias);
                assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr);
                assert.equal(JSON.parse(malformed.stdout).reason, 'invalid_input_json');
                assert.ok(!malformed.stdout.includes(dir));
            }
            await writeFile(path, path === recordPath ? recordText : configText);
        }
        await writeFile(recordPath, 'x'.repeat(65537));
        assert.equal((await cli(recordPath, configPath, alias)).code, 3);
        await assert.rejects(readEvidenceJson(dir));
    });
}

test('generic verifier imports no job, effectful processor, worker, signer, or secret loader', async () => {
    const source = await readFile(join(runtime, 'src/ledger-evidence.mjs'), 'utf8');
    assert.doesNotMatch(source, /from ['"]\..*(?:inbox|protocol|processor|worker|signer|secrets)/);
    assert.doesNotMatch(source, /process\.env|Wallet|signMessage|signTransaction|sendRawTransaction|\/v1\/|\/api\/v0\/(?:add|pin)/);
    const ignore = await readFile(join(runtime, '.dockerignore'), 'utf8');
    for (const module of ['ledger-evidence', 'verify-ledger']) assert.ok(ignore.includes(`!src/${module}.mjs`));
});
