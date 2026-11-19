import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, Interface } from 'ethers';
import { hashLedgerCid } from '@oyaprotocol/ethereum';
import { publishSignedMessage } from '@oyaprotocol/messages';
import { createInboxServer } from '../src/inbox/http.mjs';
import { testNode } from '../src/peers/test-loop.mjs';
import { peerJobStatus } from '../src/peers/send.mjs';

const cli = fileURLToPath(new URL('../src/peers/client.mjs', import.meta.url));
const sender = Wallet.createRandom(), recipient = Wallet.createRandom(), other = Wallet.createRandom();
const ledger = '0x' + '11'.repeat(20), txHash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32);
const abi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
const text = 'diagnostic private text marker\r\n';
function cidFor(bytes, codec = 0x55) {
    const input = Buffer.concat([Buffer.from([1, codec, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]);
    let result = 'b', accumulator = 0, bits = 0;
    for (const byte of input) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; result += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator >> bits) & 31]; }
    }
    if (bits) result += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator << (5 - bits)) & 31];
    return result;
}
const event = (cid, node = recipient.address) => ({
    ...abi.encodeEventLog(abi.getEvent('Log'), [node, hashLedgerCid(cid), cid]), address: ledger,
    transactionHash: txHash, blockHash, blockNumber: '0x2', transactionIndex: '0x0', logIndex: '0x7', removed: false,
});
async function listen(t, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-test-loop-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const state = { sends: [], statuses: [], reads: [], chain: '0x7a69',
        block: { hash: blockHash, number: '0x2', timestamp: '0x123' }, content: null, receipt: null };
    const store = {
        async enqueue(job) {
            const files = await readdir(join(directory, 'peer-outbox'));
            const saved = JSON.parse(await readFile(join(directory, 'peer-outbox', job.requestId + '.json')));
            assert.deepEqual(saved.job, job, 'saved before admission');
            assert.equal(files.length, state.sends.length + 1);
            if (state.sends.length) assert.ok(state.reads.includes('/api/v0/cat'), 'previous evidence before next send');
            state.sends.push(job);
            state.transactionHash = '0x' + createHash('sha256').update(job.requestId).digest('hex');
            // Use the real publisher to establish exact serialized bytes and real signature validation.
            await publishSignedMessage(job.message, { config: { url: 'http://127.0.0.1:1', maxRetries: 0, retryDelayMs: 0, timeoutMs: 1000 }, fetch: async (_url, options) => {
                state.content = Buffer.from(await options.body.get('file').arrayBuffer());
                state.cid = cidFor(state.content);
                return new Response(JSON.stringify({ Hash: state.cid }));
            } });
            state.receipt = { transactionHash: state.transactionHash, blockHash, blockNumber: '0x2', transactionIndex: '0x0',
                from: recipient.address, to: ledger, contractAddress: null, status: '0x1', gasUsed: '0x8000',
                cumulativeGasUsed: '0x8000', logsBloom: '0x' + '00'.repeat(256), logs: [{ ...event(state.cid), transactionHash: state.transactionHash }] };
            await state.onAdmission?.(job, state.response);
            for (const log of state.receipt.logs) log.transactionHash = state.receipt.transactionHash;
            if (state.onReceipt) state.onReceipt();
            return { requestId: job.requestId, status: state.admission ?? 'queued' };
        },
        async status(job) {
            state.statuses.push(job);
            if (state.onStatus) return state.onStatus(job, state.response);
            return { requestId: job.requestId, status: 'logged', cid: state.cid, transactionHash: state.transactionHash,
                result: { secret: 'response-private-marker' }, error: 'response-private-marker' };
        },
    };
    const inbox = createInboxServer({ config: { target: 'diagnostic', allowedSigners: [sender.address] }, store });
    inbox.prependListener('request', (_req, res) => { state.response = res; });
    const origin = await listen(t, inbox);
    const evidence = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        state.reads.push(req.url.startsWith('/api/v0/cat') ? '/api/v0/cat' : body.method);
        if (state.onRead?.(req, res, body)) return;
        if (req.url === `/api/v0/cat?arg=${state.cid}`) { res.end(state.content); return; }
        const result = { eth_chainId: state.chain, eth_getTransactionReceipt: state.receipt, eth_getBlockByNumber: state.block }[body?.method];
        if (result === undefined) { res.writeHead(500); res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    const url = await listen(t, evidence);
    const settings = { chainId: 31337, ledgerContract: ledger, rpcUrl: url + '/rpc', ipfsUrl: url,
        rpcAuthorization: 'rpc-private-marker', ipfsAuthorization: 'ipfs-private-marker', timeoutMs: 3000, requestTimeoutMs: 500 };
    const textFile = join(directory, 'text'), settingsFile = join(directory, 'evidence.json');
    await writeFile(textFile, text);
    await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    await writeFile(join(directory, 'node.env'), `OYA_NODE_PRIVATE_KEY=${sender.privateKey}\n`, { mode: 0o600 });
    await writeFile(join(directory, 'worker.json'), JSON.stringify({ peers: { registryFile: 'registry.json' } }));
    await writeFile(join(directory, 'registry.json'), JSON.stringify([
        { nodeAddress: recipient.address, url: origin + '/v1/jobs', target: 'diagnostic' },
    ]));
    const env = { OYA_LOCAL_DIR: directory };
    const input = { nodeAddress: recipient.address, textFile, settings, count: 2, timeoutMs: 5000,
        execute: true, pollIntervalMs: 250, maxPolls: 2 };
    const f = { directory, state, input, env, settingsFile, run: (overrides, options) => testNode({ ...input, ...overrides }, { env, ...options }) };
    f.args = ['test', '--execute', recipient.address, textFile, settingsFile, '2', '5000'];
    return f;
}
function runCli(f, args = f.args, onChild) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr, report: JSON.parse(stdout) }));
        onChild?.(child);
    });
}
function safe(report) {
    const output = JSON.stringify(report);
    for (const secret of [sender.privateKey, text.trim(), 'rpc-private-marker', 'ipfs-private-marker', 'response-private-marker', 'signature']) {
        assert.ok(!output.includes(secret), 'redacts private values');
    }
}
async function retained(f, count = 1) {
    const files = await readdir(join(f.directory, 'peer-outbox'));
    assert.equal(files.length, count);
    for (const file of files) {
        const path = join(f.directory, 'peer-outbox', file);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const saved = JSON.parse(await readFile(path));
        assert.ok(f.state.sends.some(job => job.requestId === saved.job.requestId));
    }
}

test('actual CLI: two sequential ordinary signed jobs, exact publisher bytes and independently selected event', async t => {
    const f = await fixture(t);
    f.state.onAdmission = () => {
        f.state.receipt.logs.unshift({ ...event(f.state.cid, other.address), logIndex: '0x1' });
        f.state.receipt.logs.push({ ...event(cidFor('unrelated')), logIndex: '0x9' });
    };
    const result = await runCli(f);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, '');
    assert.equal(result.report.outcome, 'completed');
    assert.equal(result.report.verified, 2);
    assert.equal(f.state.sends.length, 2);
    assert.equal(new Set(f.state.sends.map(job => job.requestId)).size, 2);
    for (const entry of result.report.jobs) {
        assert.equal(entry.admission.execution, 'queued');
        assert.equal(entry.reported.execution, 'logged');
        assert.equal(entry.evidence.status, 'verified');
        assert.equal(entry.evidence.logIndex, 7);
        assert.equal(entry.exactMessage, 'verified');
        assert.equal(entry.evidence.contentVerification, 'cid_sha256_and_expected_sha256');
        assert.equal(entry.evidence.expected.nodeAddress, recipient.address.toLowerCase());
    }
    await retained(f, 2); safe(result);
});

test('actual CLI lost acknowledgement stops, preserves exact job, never resubmits or polls', async t => {
    const f = await fixture(t);
    f.state.onAdmission = (_job, res) => { res.destroy(); };
    const result = await runCli(f);
    assert.equal(result.code, 1);
    assert.equal(result.report.reason, 'delivery_unknown');
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.statuses.length, 0);
    assert.equal(f.state.reads.length, 0);
    await retained(f); safe(result);
});

test('status projection is opt-in, strictly validated and never trusts nested or arbitrary fields', async t => {
    const f = await fixture(t);
    const report = await f.run({ count: 1 });
    assert.equal(report.outcome, 'completed');
    const file = report.jobs[0].savedFile;
    const status = await peerJobStatus(file);
    assert.equal(status.execution, 'logged');
    assert.equal(status.cid, undefined);
    const checked = await peerJobStatus(file, { evidence: true });
    assert.equal(checked.cid, f.state.cid); safe(checked);
    for (const patch of [{ cid: 'https://private.example' }, { transactionHash: 'secret' }, { cid: null }, { transactionHash: null }]) {
        f.state.onStatus = job => ({ requestId: job.requestId, status: 'logged', cid: f.state.cid, transactionHash: txHash, ...patch });
        assert.equal((await peerJobStatus(file, { evidence: true })).outcome, 'status_unknown');
    }
});

for (const [name, mutate, reason] of [
    ['wrong chain', f => { f.state.chain = '0x1'; }, 'chain_identity'],
    ['wrong node', f => { f.state.receipt.logs = [event(f.state.cid, other.address)]; }, 'log_missing'],
    ['wrong contract', f => { f.state.receipt.logs[0].address = other.address; }, 'log_missing'],
    ['wrong CID', f => { f.state.receipt.logs = [event(cidFor('wrong'))]; }, 'log_missing'],
    ['missing logs', f => { f.state.receipt.logs = []; }, 'log_missing'],
    ['removed log', f => { f.state.receipt.logs[0].removed = true; }, 'log_missing'],
    ['ambiguous logs', f => { f.state.receipt.logs.push({ ...f.state.receipt.logs[0], logIndex: '0x8' }); }, 'log_ambiguous'],
    ['duplicate index', f => { f.state.receipt.logs.push({ ...f.state.receipt.logs[0] }); }, 'duplicate_log_index'],
    ['reverted receipt', f => { f.state.receipt.status = '0x0'; }, 'receipt_status'],
    ['wrong block', f => { f.state.block.hash = txHash; }, 'block_identity'],
    ['wrong bytes at claimed CID', f => { f.state.content = Buffer.from('different'); }, 'cid_content'],
    ['different valid signed message and self-consistent CID', async f => {
        const message = { text: 'other valid content', signer: sender.address, signature: await sender.signMessage('other valid content') };
        f.state.content = Buffer.from(JSON.stringify(message));
        f.state.cid = cidFor(f.state.content); f.state.receipt.logs = [event(f.state.cid)];
    }, 'expected_content'],
]) {
    test(`independent evidence rejects ${name} and sends no replacement`, async t => {
        const f = await fixture(t);
        f.state.onAdmission = () => mutate(f);
        const report = await f.run();
        assert.equal(report.reason, 'evidence_not_verified', JSON.stringify(report));
        assert.equal(report.jobs[0].evidence.reason, reason);
        assert.equal(report.verified, 0);
        assert.equal(f.state.sends.length, 1);
        await retained(f); safe(report);
    });
}

test('unsupported CID binding is never loop success even with exact bytes', async t => {
    const f = await fixture(t);
    f.state.onAdmission = () => { f.state.cid = cidFor(f.state.content, 0x70); f.state.receipt.logs = [event(f.state.cid)]; };
    const report = await f.run();
    assert.equal(report.reason, 'evidence_not_verified');
    assert.equal(report.jobs[0].evidence.checks.cidBinding, 'not_checked');
    assert.equal(report.verified, 0);
    await retained(f);
});

for (const state of ['failed', 'expired', 'published']) {
    test(`reported ${state} is terminal, not Ledger success`, async t => {
        const f = await fixture(t);
        f.state.onStatus = job => ({ requestId: job.requestId, status: state });
        const report = await f.run();
        assert.equal(report.reason, 'reported_' + state);
        assert.equal(report.verified, 0); assert.equal(f.state.reads.length, 0);
        await retained(f);
    });
}

test('finite poll budget stops while pending without replacement', async t => {
    const f = await fixture(t);
    f.state.onStatus = job => ({ requestId: job.requestId, status: 'processing' });
    const report = await f.run();
    assert.equal(report.reason, 'poll_limit');
    assert.equal(report.jobs[0].polls, 2);
    assert.equal(f.state.sends.length, 1);
    await retained(f);
});

for (const stage of ['status headers', 'status body', 'evidence headers', 'evidence body']) {
    test(`${stage} is bounded by total or request deadline`, async t => {
        const f = await fixture(t);
        if (stage.startsWith('status')) {
            f.state.onStatus = (_job, res) => {
                if (stage.endsWith('body')) { res.writeHead(200); res.write('{'); }
                return new Promise(() => {});
            };
        } else f.state.onRead = (_req, res) => {
            if (stage.endsWith('body')) { res.writeHead(200); res.write('{'); }
            return true;
        };
        const report = await f.run({ timeoutMs: 1000 });
        assert.ok(['deadline', 'evidence_not_verified'].includes(report.reason), JSON.stringify(report));
        assert.ok(report.elapsedMs < 2500);
        assert.equal(report.verified, 0); await retained(f);
    });
}

test('actual CLI total deadline cancels a status body and exits with saved path', async t => {
    const f = await fixture(t);
    f.state.onStatus = (_job, res) => { res.writeHead(200); res.write('{'); return new Promise(() => {}); };
    const result = await runCli(f, [...f.args.slice(0, -1), '800']);
    assert.equal(result.code, 1);
    assert.equal(result.report.reason, 'deadline');
    assert.equal(result.report.jobs.length, 1);
    await retained(f); safe(result);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`actual CLI ${signal} during status preserves file and stops without resubmitting`, async t => {
        const f = await fixture(t);
        let child;
        f.state.onStatus = () => { child.kill(signal); return new Promise(() => {}); };
        const result = await runCli(f, f.args, value => { child = value; });
        assert.equal(result.code, 1, result.stdout);
        assert.equal(result.report.reason, 'cancelled');
        assert.equal(f.state.sends.length, 1);
        await retained(f); safe(result);
    });
}

test('pre-cancellation causes no saved jobs or remote requests', async t => {
    const f = await fixture(t);
    const controller = new AbortController(); controller.abort();
    const report = await f.run({}, { signal: controller.signal });
    assert.equal(report.reason, 'cancelled');
    assert.deepEqual(report.jobs, []);
    assert.equal(f.state.sends.length, 0);
    await assert.rejects(readdir(join(f.directory, 'peer-outbox')), { code: 'ENOENT' });
});

for (const boundary of ['local read', 'first signature', 'persisted job']) {
    for (const interruption of ['deadline', 'starved deadline', 'cancelled']) {
        test(`${interruption} at ${boundary} prevents the next signature or transport`, async t => {
            const f = await fixture(t), controller = new AbortController();
            const probe = await open(f.input.textFile), proto = Object.getPrototypeOf(probe);
            await probe.close();
            let signs = 0, calls = 0, interrupted = false, directories = 0;
            const interrupt = async () => {
                interrupted = true;
                if (interruption === 'cancelled') controller.abort(new Error('response-private-marker'));
                else if (interruption === 'deadline') await new Promise(resolve => setTimeout(resolve, 650));
                else {
                    // Keep timers from running: only the synchronous monotonic gate can stop the effect.
                    const end = performance.now() + 650;
                    while (performance.now() < end) {}
                }
            };
            const sign = Wallet.prototype.signMessage;
            t.mock.method(Wallet.prototype, 'signMessage', async function(...args) {
                signs++;
                const signature = await sign.apply(this, args);
                if (boundary === 'first signature' && signs === 1) await interrupt();
                return signature;
            });
            if (boundary === 'local read') {
                const read = proto.read;
                t.mock.method(proto, 'read', async function(...args) {
                    if (!interrupted) await interrupt();
                    return read.apply(this, args);
                });
            } else if (boundary === 'persisted job') {
                const sync = proto.sync;
                t.mock.method(proto, 'sync', async function(...args) {
                    await sync.apply(this, args);
                    if ((await this.stat()).isDirectory() && ++directories === 2) {
                        const close = this.close;
                        this.close = async (...args) => { await close.apply(this, args); await interrupt(); };
                    }
                });
            }
            const report = await f.run({ timeoutMs: interruption === 'cancelled' ? 5000 : 500 }, {
                signal: controller.signal, transport: (...args) => { calls++; return fetch(...args); },
            });
            assert.equal(interrupted, true, 'must reach the adversarial boundary');
            assert.equal(report.reason, interruption === 'cancelled' ? 'cancelled' : 'deadline');
            assert.equal(signs, boundary === 'local read' ? 0 : boundary === 'first signature' ? 1 : 2);
            assert.equal(calls, 0);
            assert.equal(f.state.sends.length, 0);
            assert.equal(report.verified, 0);
            if (boundary === 'persisted job') {
                assert.equal(report.jobs.length, 1);
                const entry = report.jobs[0];
                assert.equal(entry.admission.outcome, 'delivery_unknown');
                const saved = JSON.parse(await readFile(entry.savedFile));
                assert.equal(saved.job.requestId, entry.requestId);
                assert.equal(saved.job.message.text, text);
                assert.equal((await stat(entry.savedFile)).mode & 0o777, 0o600);
                assert.deepEqual(await readdir(join(f.directory, 'peer-outbox')), [entry.requestId + '.json']);
            } else {
                assert.deepEqual(report.jobs, []);
                await assert.rejects(readdir(join(f.directory, 'peer-outbox')), { code: 'ENOENT' });
            }
            safe(report);
        });
    }
}

test('cancellation interrupts independent evidence and never submits next job', async t => {
    const f = await fixture(t), controller = new AbortController();
    f.state.onRead = () => { controller.abort(); return true; };
    const report = await f.run({}, { signal: controller.signal });
    assert.equal(report.reason, 'cancelled');
    assert.equal(report.verified, 0);
    await retained(f);
});

test('invalid limits, settings and missing intent fail before signing or network', async t => {
    const f = await fixture(t);
    for (const change of [{ execute: false }, { execute: undefined }, { count: 0 }, { count: 21 }, { count: 1.5 },
        { timeoutMs: 0 }, { timeoutMs: 600001 }, { timeoutMs: Infinity }, { maxPolls: 121 }, { maxPolls: 0 },
        { pollIntervalMs: 249 }, { settings: {} }, { settings: { ...f.input.settings, rpcUrl: 'http://off-host.example' } }]) {
        await assert.rejects(f.run(change), error => ['execution_intent_required', 'invalid_test_limits', 'invalid_evidence_settings'].includes(error.code));
    }
    for (const args of [f.args.filter(arg => arg !== '--execute'), [...f.args.slice(0, -2), '1.0', '1000'],
        [...f.args.slice(0, -2), '21', '1000']]) {
        const result = await runCli(f, args);
        assert.equal(result.code, 2); safe(result);
    }
    assert.equal(f.state.sends.length, 0);
    await assert.rejects(readdir(join(f.directory, 'peer-outbox')), { code: 'ENOENT' });
});

for (const kind of ['oversized status', 'wrong request', 'unknown status', 'malformed status', 'redirect', 'http failure', 'oversized evidence']) {
    test(`${kind} is unknown or unavailable, redacted, and stops`, async t => {
        const f = await fixture(t);
        if (kind === 'oversized evidence') f.state.onRead = (_req, res) => { res.end('x'.repeat(131073)); return true; };
        else f.state.onStatus = (job, res) => {
            if (kind === 'wrong request') return { requestId: 'wrong', status: 'logged' };
            if (kind === 'unknown status') return { requestId: job.requestId, status: 'secret' };
            if (kind === 'redirect') { res.writeHead(302, { location: 'https://private.example' }); res.end(); }
            else if (kind === 'http failure') { res.writeHead(503); res.end('response-private-marker'); }
            else res.end(kind === 'oversized status' ? 'x'.repeat(131073) : 'response-private-marker');
            return new Promise(() => {});
        };
        const report = await f.run();
        assert.equal(report.outcome, 'stopped');
        assert.equal(report.jobs[0].admission.admission, 'reported');
        assert.equal(f.state.statuses.length, 1);
        assert.equal(report.verified, 0);
        assert.equal(f.state.sends.length, 1);
        await retained(f); safe(report);
    });
}


test('file synchronization failure preserves recovery artifact and prevents HTTP', async t => {
    const f = await fixture(t);
    const probe = await open(f.input.textFile), proto = Object.getPrototypeOf(probe);
    await probe.close();
    const original = proto.sync;
    t.mock.method(proto, 'sync', async function() {
        if ((await this.stat()).isFile()) throw new Error('response-private-marker');
        return original.call(this);
    });
    const report = await f.run();
    assert.equal(report.reason, 'local_error');
    assert.equal(report.code, 'save_failed');
    assert.ok(report.savedFile);
    const saved = JSON.parse(await readFile(report.savedFile));
    assert.equal(saved.job.message.text, text);
    assert.equal(f.state.sends.length, 0);
    safe(report);
});

test('cancellation at persistence boundary keeps signed file and makes no HTTP call', async t => {
    const f = await fixture(t), controller = new AbortController();
    const probe = await open(f.input.textFile), proto = Object.getPrototypeOf(probe);
    await probe.close();
    const original = proto.sync;
    t.mock.method(proto, 'sync', async function() {
        await original.call(this);
        if ((await this.stat()).isFile()) controller.abort();
    });
    const report = await f.run({}, { signal: controller.signal });
    assert.equal(report.reason, 'cancelled');
    assert.equal(f.state.sends.length, 0);
    assert.equal(report.jobs.length, 1);
    const saved = JSON.parse(await readFile(report.jobs[0].savedFile));
    assert.equal(saved.job.message.text, text);
    safe(report);
});

test('invalid settings file in real CLI fails closed without echoing input', async t => {
    const f = await fixture(t);
    for (const value of ['response-private-marker', 'x'.repeat(65537), JSON.stringify({ secret: 'rpc-private-marker' })]) {
        await writeFile(f.settingsFile, value);
        const result = await runCli(f);
        assert.equal(result.code, 2);
        assert.equal(result.report.code, 'invalid_evidence_settings');
        safe(result);
    }
    assert.equal(f.state.sends.length, 0);
});

test('maximum count completes finitely with a distinct event for every iteration', async t => {
    const f = await fixture(t);
    const report = await f.run({ count: 20, timeoutMs: 15000 });
    assert.equal(report.outcome, 'completed', JSON.stringify(report));
    assert.equal(report.verified, 20);
    assert.equal(f.state.sends.length, 20);
    await retained(f, 20);
});

test('reusing one matching event for a second job cannot count twice', async t => {
    const f = await fixture(t);
    let first;
    f.state.onAdmission = () => {
        first ??= f.state.transactionHash;
        f.state.transactionHash = first;
        f.state.receipt.transactionHash = first;
    };
    const report = await f.run({ count: 3 });
    assert.equal(report.reason, 'reused_event');
    assert.equal(report.verified, 1);
    assert.equal(f.state.sends.length, 2);
    await retained(f, 2);
});

test('ten-second ordinary status request deadline stops before a longer loop deadline', async t => {
    const f = await fixture(t);
    f.state.onStatus = () => new Promise(() => {});
    const report = await f.run({ timeoutMs: 15000 });
    assert.equal(report.reason, 'status_unknown');
    assert.ok(report.elapsedMs >= 9900 && report.elapsedMs < 14000);
    assert.equal(f.state.statuses.length, 1);
    await retained(f);
});

test('local failure after verified progress retains all previous results and files', async t => {
    const f = await fixture(t);
    f.state.onAdmission = () => rm(join(f.directory, 'node.env'));
    const report = await f.run();
    assert.equal(report.reason, 'local_error');
    assert.equal(report.code, 'invalid_node_settings_or_input');
    assert.equal(report.verified, 1);
    assert.equal(report.jobs.length, 1);
    await retained(f); safe(report);
});

for (const field of ['transactionHash', 'blockHash', 'transactionIndex', 'blockNumber']) {
    test(`receipt log ${field} must match its enclosing receipt`, async t => {
        const f = await fixture(t);
        f.state.onReceipt = () => { f.state.receipt.logs[0][field] = field.endsWith('Hash') ? '0x' + 'ff'.repeat(32) : '0x99'; };
        const report = await f.run();
        assert.equal(report.reason, 'evidence_not_verified');
        assert.equal(report.jobs[0].evidence.status, 'mismatch');
        assert.equal(report.verified, 0);
        await retained(f);
    });
}

test('missing and oversized content cannot be called verified', async t => {
    for (const oversized of [false, true]) {
        await t.test(String(oversized), async t => {
            const f = await fixture(t);
            f.state.onRead = (req, res) => {
                if (!req.url.startsWith('/api/v0/cat')) return false;
                if (oversized) res.end('x'.repeat(131073));
                else { res.writeHead(404); res.end('response-private-marker'); }
                return true;
            };
            const report = await f.run();
            assert.equal(report.reason, 'evidence_not_verified');
            assert.equal(report.jobs[0].evidence.checks.ledger, 'verified');
            assert.equal(report.jobs[0].evidence.status, 'unavailable');
            await retained(f); safe(report);
        });
    }
});
