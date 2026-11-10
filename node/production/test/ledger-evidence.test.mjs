import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Wallet, Interface } from 'ethers';
import { hashLedgerCid } from '@oyaprotocol/ethereum';
import { jobText, signJob } from '../src/inbox/protocol.mjs';
import { verifyLedgerEvidence, evidenceExitCode, readEvidenceJson } from '../src/inbox/evidence.mjs';

const cid = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrj5mf4ie';
const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const ledger = `0x${'11'.repeat(20)}`;
const node = `0x${'22'.repeat(20)}`;
const other = `0x${'33'.repeat(20)}`;
const agent = Wallet.createRandom();
const original = await signJob(agent, 'evidence-test', 'Exact message\n', { expiresAt: 1 });
const abi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
const runtime = fileURLToPath(new URL('../', import.meta.url));

async function setup(t) {
    const job = structuredClone(original);
    const event = abi.encodeEventLog(abi.getEvent('Log'), [node, hashLedgerCid(cid), cid]);
    const state = {
        status: { requestId: job.requestId, status: 'logged', cid, transactionHash: txHash,
            result: { status: 'logged', cid, transactionHash: txHash } },
        chain: '0x7a69', block: { hash: blockHash, number: '0x2', timestamp: '0x123' },
        receipt: { transactionHash: txHash, blockHash, blockNumber: '0x2', transactionIndex: '0x0',
            from: node, to: ledger, contractAddress: null, status: '0x1', gasUsed: '0x8000',
            cumulativeGasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`,
            logs: [{ ...event, address: ledger, transactionHash: txHash, blockHash, blockNumber: '0x2',
                transactionIndex: '0x0', logIndex: '0x0', removed: false }] },
        content: structuredClone(job.message), requests: [], hook: undefined,
    };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString();
        const body = text ? JSON.parse(text) : undefined;
        state.requests.push({ url: req.url, method: req.method, body, auth: req.headers.authorization });
        if (state.hook?.(req, res, body)) return;
        let data;
        if (req.url === '/v1/status') data = state.status;
        else if (req.url === `/api/v0/cat?arg=${cid}`) data = state.content;
        else if (req.url === '/rpc') {
            const results = { eth_chainId: state.chain, eth_getTransactionReceipt: state.receipt, eth_getBlockByNumber: state.block };
            if (!(body.method in results)) { res.writeHead(500); res.end(); return; }
            data = { jsonrpc: '2.0', id: body.id, result: results[body.method] };
        } else { res.writeHead(500); res.end(); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const config = { target: job.target, inboxUrl: url, chainId: 31337, ledgerContract: ledger,
        nodeAddress: node, rpcUrl: url + '/rpc', ipfsUrl: url, timeoutMs: 3000, requestTimeoutMs: 1000 };
    return { job, config, state, run: () => verifyLedgerEvidence(job, config) };
}

function readOnly(state) {
    for (const request of state.requests) {
        assert.equal(request.method, 'POST');
        if (request.url === '/rpc') assert.ok(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(request.body.method));
        else assert.ok(['/v1/status', `/api/v0/cat?arg=${cid}`].includes(request.url));
    }
    const routes = state.requests.map(r => r.url === '/rpc' ? r.body.method : r.url);
    assert.equal(new Set(routes).size, routes.length, 'no automatic retries');
}

test('historically expired job verifies exact signatures/content and read-only snapshot', async t => {
    const f = await setup(t);
    const report = await f.run();
    assert.equal(report.status, 'verified', JSON.stringify(report));
    assert.equal(evidenceExitCode(report), 0);
    assert.deepEqual(report.block, { number: '2', hash: blockHash, timestamp: '291' });
    assert.equal(report.transactionHash, txHash);
    assert.equal(report.target, original.target);
    assert.equal(report.expected.nodeAddress, node);
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    assert.deepEqual(f.state.requests[0].body, original);
    assert.equal(f.state.requests.length, 5);
    readOnly(f.state);
    assert.ok(!JSON.stringify(report).includes(original.message.text));
    assert.ok(!JSON.stringify(report).includes(original.message.signature));
});

const mismatchCases = [
    ['outer signature', f => { f.job.requestSignature = '0xdead'; }],
    ['inner signature', f => { f.job.message.signature = '0xdead'; }],
    ['message tampering', f => { f.job.message.text += '!'; }],
    ['wrong target', f => { f.config.target = 'another'; }],
    ['wrong request id', f => { f.state.status.requestId = 'other'; }],
    ['explicit wrong status target', f => { f.state.status.target = 'other'; }],
    ['null status', f => { f.state.status = null; }],
    ['unknown state', f => { f.state.status.status = 'invented'; }],
    ['result state', f => { f.state.status.result.status = 'published'; }],
    ['missing logged result', f => { delete f.state.status.result; }],
    ['checkpoint CID', f => { f.state.status.cid += 'a'; }],
    ['malformed CID', f => { f.state.status.cid = f.state.status.result.cid = 'secret-invalid-cid'; }],
    ['checkpoint hash', f => { f.state.status.transactionHash = blockHash; }],
    ['invalid tx hash', f => { f.state.status.transactionHash = f.state.status.result.transactionHash = 'bad'; }],
    ['wrong expected publisher', f => { f.config.nodeAddress = other; }],
    ['wrong expected Ledger', f => { f.config.ledgerContract = other; }],
    ['oversized receipt block number', f => { f.state.receipt.blockNumber = '0x' + 'f'.repeat(65); }],
    ['wrong event CID with consistent hash', f => {
        const different = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        Object.assign(f.state.receipt.logs[0], abi.encodeEventLog(abi.getEvent('Log'), [node, hashLedgerCid(different), different]));
    }],
    ['wrong chain', f => { f.state.chain = '0x1'; }],
    ['noncanonical chain quantity', f => { f.state.chain = '0x07a69'; }],
    ['receipt hash', f => { f.state.receipt.transactionHash = blockHash; }],
    ['receipt sender', f => { f.state.receipt.from = other; }],
    ['receipt destination', f => { f.state.receipt.to = other; }],
    ['contract creation', f => { f.state.receipt.contractAddress = other; }],
    ['null destination', f => { f.state.receipt.to = null; }],
    ['missing creation field', f => { delete f.state.receipt.contractAddress; }],
    ['reverted receipt', f => { f.state.receipt.status = '0x0'; }],
    ['malformed receipt', f => { f.state.receipt = {}; }],
    ['missing event', f => { f.state.receipt.logs = []; }],
    ['wrong log contract', f => { f.state.receipt.logs[0].address = other; }],
    ['wrong log node', f => { f.state.receipt.logs[0].topics[1] = `0x${'0'.repeat(24)}${other.slice(2)}`; }],
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
    ['different text', f => { f.state.content.text += '\n'; }],
    ['different content signature', f => { f.state.content.signature = '0xdead'; }],
    ['different content signer', f => { f.state.content.signer = other; }],
    ['extra content field', f => { f.state.content.extra = true; }],
    ['null content', f => { f.state.content = null; }],
];
for (const [name, mutate] of mismatchCases) {
    test(`mismatch: ${name}`, async t => {
        const f = await setup(t);
        mutate(f);
        const report = await f.run();
        assert.equal(report.status, 'mismatch', JSON.stringify(report));
        assert.equal(evidenceExitCode(report), 2);
        if (report.stage === 'input') assert.equal(f.state.requests.length, 0);
        readOnly(f.state);
    });
}

test('valid outer signature cannot authorize an invalid inner signature', async t => {
    const f = await setup(t);
    f.job.message.signature = await agent.signMessage('different text');
    f.job.requestSignature = await agent.signMessage(jobText(f.job));
    assert.equal((await f.run()).reason, 'invalid_job');
    assert.equal(f.state.requests.length, 0);
});

test('a different valid signed message is not the expected content', async t => {
    const f = await setup(t);
    f.state.content = (await signJob(agent, f.job.target, 'another valid message')).message;
    assert.equal((await f.run()).reason, 'signed_content');
});

test('fresh envelopes and reordered content keys verify without trusting status URLs', async t => {
    const f = await setup(t);
    Object.assign(f.job, await signJob(agent, f.job.target, f.job.message.text, { requestId: f.job.requestId }));
    f.state.content = { signature: f.job.message.signature, text: f.job.message.text, signer: f.job.message.signer };
    f.state.status.rpcUrl = 'https://untrusted.example';
    f.state.status.ipfsUrl = 'https://untrusted.example';
    assert.equal((await f.run()).status, 'verified');
    readOnly(f.state);
});

for (const status of ['queued', 'processing', 'published', 'failed', 'expired']) {
    test(`${status} is unavailable, not logged evidence`, async t => {
        const f = await setup(t);
        f.state.status.status = status;
        delete f.state.status.result;
        const report = await f.run();
        assert.equal(report.status, 'unavailable');
        assert.equal(report.reason, 'not_logged');
        assert.equal(f.state.requests.length, 1);
    });
}
for (const field of ['receipt', 'block']) {
    test(`missing ${field} is unavailable`, async t => {
        const f = await setup(t);
        f.state[field] = null;
        assert.equal((await f.run()).status, 'unavailable');
        readOnly(f.state);
    });
}

for (const route of ['/v1/status', '/rpc', `/api/v0/cat?arg=${cid}`]) {
    for (const kind of ['http', 'oversize', 'chunked', 'timeout', 'body_timeout', 'redirect', 'disconnect', 'json']) {
        test(`${route} ${kind} is bounded and sanitized`, async t => {
            const f = await setup(t);
            f.config.requestTimeoutMs = 60;
            f.state.hook = (req, res) => {
                if (req.url !== route) return false;
                if (kind === 'http') { res.writeHead(503); res.end('provider-secret'); }
                if (kind === 'oversize') { res.writeHead(200, { 'content-length': 200000 }); res.end(); }
                if (kind === 'chunked') { res.writeHead(200); res.end('x'.repeat(131073)); }
                if (kind === 'timeout') { /* Intentionally no response; client must abort. */ }
                if (kind === 'body_timeout') { res.writeHead(200); res.write('{'); }
                if (kind === 'redirect') { res.writeHead(307, { location: '/forbidden' }); res.end(); }
                if (kind === 'disconnect') res.destroy();
                if (kind === 'json') res.end('provider-secret');
                return true;
            };
            const report = await f.run();
            assert.equal(report.status, kind === 'json' ? 'mismatch' : 'unavailable', JSON.stringify(report));
            assert.ok(!JSON.stringify(report).includes('provider-secret'));
            readOnly(f.state);
        });
    }
}

for (const code of [301, 302, 303, 307, 308]) {
    test(`redirect ${code} cannot forward credentials or the signed job`, async t => {
        const destination = await setup(t);
        for (const route of ['/v1/status', '/rpc', `/api/v0/cat?arg=${cid}`]) {
            const f = await setup(t);
            f.config.rpcAuthorization = f.config.ipfsAuthorization = 'Bearer redirect-secret';
            f.state.hook = (req, res) => {
                if (req.url !== route) return false;
                res.writeHead(code, { location: destination.config.inboxUrl + '/v1/status' }); res.end(); return true;
            };
            const report = await f.run();
            assert.equal(report.status, 'unavailable');
            assert.equal(destination.state.requests.length, 0);
            assert.ok(!JSON.stringify(report).includes('redirect-secret'));
            readOnly(f.state);
        }
    });
}

test('unreachable endpoint and HTTP 404 evidence are unavailable', async t => {
    const f = await setup(t);
    const closed = createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    f.config.inboxUrl = `http://127.0.0.1:${port}`;
    assert.equal((await f.run()).reason, 'transport_failure');
    f.config.inboxUrl = f.config.ipfsUrl;
    f.state.hook = (_req, res) => { res.writeHead(404); res.end('not found'); return true; };
    assert.equal((await f.run()).status, 'unavailable');
});

test('overall deadline bounds several successful slow reads', async t => {
    const f = await setup(t);
    f.config.timeoutMs = 60;
    f.state.hook = (req, res, body) => {
        if (req.url === '/v1/status') { setTimeout(() => res.end(JSON.stringify(f.state.status)), 40); return true; }
        if (body?.method === 'eth_chainId') return true;
        return false;
    };
    const report = await f.run();
    assert.equal(report.reason, 'deadline');
    assert.equal(report.status, 'unavailable');
    readOnly(f.state);
});

test('RPC errors are unavailable; wrong JSON-RPC id is mismatch', async t => {
    for (const rpcError of [true, false]) {
        const f = await setup(t);
        f.state.hook = (req, res, body) => {
            if (req.url !== '/rpc') return false;
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcError ? body.id : 999,
                ...(rpcError ? { error: { code: -32000, message: 'private-provider-detail' } } : { result: '0x7a69' }) }));
            return true;
        };
        const report = await f.run();
        assert.equal(report.status, rpcError ? 'unavailable' : 'mismatch');
        assert.ok(!JSON.stringify(report).includes('private-provider-detail'));
        readOnly(f.state);
    }
});

test('strict settings reject keys, unsafe endpoints, credentials and excessive limits before HTTP', async t => {
    for (const patch of [{ privateKey: 'not-used' }, { target: '' }, { chainId: 0 }, { nodeAddress: 'bad' },
        { rpcUrl: 'http://remote.example' }, { ipfsUrl: 'file:///etc/passwd' }, { inboxUrl: 'https://user:secret@example.com' },
        { rpcUrl: 'https://user:secret@example.com' }, { ipfsUrl: 'https://example.com?secret=1' },
        { timeoutMs: 120001 }, { requestTimeoutMs: 30001 }, { rpcAuthorization: 'secret\nvalue' }]) {
        const f = await setup(t);
        Object.assign(f.config, patch);
        assert.equal((await f.run()).reason, 'invalid_settings');
        assert.equal(f.state.requests.length, 0);
    }
});

async function cli(jobPath, configPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', join(runtime, 'test/evidence-read-guard.mjs'),
            join(runtime, 'src/inbox/client.mjs'), 'evidence', jobPath, configPath], {
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

test('real CLI uses only explicit reads with no keys, reports all exit codes and preserves files', async t => {
    const f = await setup(t);
    const dir = await mkdtemp(join(tmpdir(), 'oya-evidence-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const jobPath = join(dir, 'job.json'), configPath = join(dir, 'settings.json');
    f.config.rpcAuthorization = 'Bearer test-rpc-only';
    f.config.ipfsAuthorization = 'Bearer test-ipfs-only';
    const jobText = JSON.stringify(f.job), configText = JSON.stringify(f.config);
    await writeFile(jobPath, jobText);
    await writeFile(configPath, configText);
    for (const [state, code] of [['verified', 0], ['mismatch', 2], ['unavailable', 3]]) {
        f.state.requests = [];
        if (state === 'mismatch') f.state.content.text = 'wrong';
        if (state === 'unavailable') f.state.receipt = null;
        const result = await cli(jobPath, configPath);
        assert.equal(result.code, code, result.stdout + result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(JSON.parse(result.stdout).status, state);
        assert.ok(!result.stdout.includes('test-rpc-only'));
        assert.ok(!result.stdout.includes(f.config.inboxUrl));
        readOnly(f.state);
        for (const req of f.state.requests) assert.equal(req.auth,
            req.url === '/rpc' ? f.config.rpcAuthorization : req.url.startsWith('/api/') ? f.config.ipfsAuthorization : undefined);
    }
    assert.equal(await readFile(jobPath, 'utf8'), jobText);
    assert.equal(await readFile(configPath, 'utf8'), configText);
    const missing = await cli(join(dir, 'missing'), configPath);
    assert.equal(missing.code, 3);
    assert.equal(JSON.parse(missing.stdout).reason, 'input_unreadable');
    assert.ok(!missing.stdout.includes(dir));
    await writeFile(jobPath, 'x'.repeat(65537));
    assert.equal((await cli(jobPath, configPath)).code, 3);
    await assert.rejects(readEvidenceJson(dir));
});

test('evidence imports no effectful processor, worker, signer, or secret loader', async () => {
    const source = await readFile(join(runtime, 'src/inbox/evidence.mjs'), 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:processor|worker|signer|secrets)\.mjs/);
    assert.doesNotMatch(source, /process\.env|Wallet|signMessage|signTransaction|sendRawTransaction|\/v1\/jobs|\/v1\/worker|\/api\/v0\/(?:add|pin)/);
});
