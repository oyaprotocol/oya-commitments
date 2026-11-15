import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { createBatchLogger, parseBatch } from '../src/batch-logging.mjs';
import { parseConfig } from '../src/config.mjs';
import { startNode } from '../src/main.mjs';
import { statusLocalNode } from '../scripts/local-status.mjs';
import { runOne, runWorker } from '../src/inbox/worker.mjs';
import { fixture, signedMessage, gate } from './runtime-fixture.mjs';

// Synthetic IPFS raw-block CIDs and mocked RPC, with real HTTP, signatures and disk checkpoints.
function contentCid(text) {
    const bytes = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash('sha256').update(text).digest()]);
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    let result = 'b';
    for (let i = 0; i < bits.length; i += 5) result += 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return result;
}
const abi = new Interface(['function log(string cid)', 'event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
async function setup(t, overrides = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-batch-'));
    const f = await fixture(t, { batchLogging: { stateDirectory: directory, maxMessages: 2, maxWaitMs: 60000 }, ...overrides });
    const uploads = [];
    let loggedCid, batch, runtime;
    const signer = { address: f.signer.address, async signTransaction(tx, signal) {
        loggedCid = abi.decodeFunctionData('log', tx.data)[0];
        return f.signer.signTransaction(tx, signal);
    } };
    const transport = async (url, request) => {
        if (url.startsWith(f.config.ipfs.url)) {
            const file = request.body.get('file');
            const text = await file.text();
            if (file.name === 'oya-message-batch.txt') assert.equal(file.type, 'text/plain');
            if (file.name.startsWith('oya-message-batch.') && f.state.manifestFailure) throw new Error('secret-provider-error');
            const response = await f.transport(url, request);
            if (!response.ok) return response;
            const cid = contentCid(text);
            uploads.push({ cid, text });
            return new Response(JSON.stringify({ Hash: cid }));
        }
        const response = await f.transport(url, request);
        const body = await response.json();
        const { method, params } = JSON.parse(request.body);
        if (method === 'eth_getTransactionReceipt') {
            // A transaction cannot be mined before its first broadcast in this mock.
            if (!f.state.transactions.some(tx => tx.hash === params[0])) body.result = null;
            if (body.result?.logs?.length) {
                const event = abi.encodeEventLog(abi.getEvent('Log'), [f.wallet.address, keccak256(toUtf8Bytes(loggedCid)), loggedCid]);
                Object.assign(body.result.logs[0], event);
                if (f.state.wrongReceipt) body.result.to = Wallet.createRandom().address;
            }
        }
        return new Response(JSON.stringify(body));
    };
    const options = { config: f.config, signer, fetch: transport };
    const s = { f, directory, uploads, options,
        journal: async () => JSON.parse(await readFile(join(directory, 'batch.json'), 'utf8')),
        async open(extra = {}) { batch = await createBatchLogger({ ...options, ...extra }); return batch; },
        async start() {
            runtime = await startNode(f.config, signer, { fetch: transport, log: () => {} });
            s.url = `http://127.0.0.1:${runtime.server.address().port}`;
            return runtime;
        },
        post: message => fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message ?? f.message) }),
        status: async () => (await fetch(`${s.url}/v1/batches`)).json(),
    };
    t.after(async () => { await runtime?.close(); await batch?.close(); await rm(directory, { recursive: true, force: true }); });
    return s;
}
async function waitFor(check) {
    for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for batch state');
}

test('strict opt-in limits and role boundaries', async () => {
    assert.equal(parseBatch(undefined, 'ledger'), undefined);
    const valid = { stateDirectory: 'private-batches', maxMessages: 2, maxWaitMs: 1000 };
    for (const input of [null, false, {}, { ...valid, extra: true }, { ...valid, maxMessages: 1 },
        { ...valid, maxMessages: 101 }, { ...valid, maxMessages: 2.5 }, { ...valid, maxWaitMs: 999 },
        { ...valid, maxWaitMs: 86400001 }, { ...valid, stateDirectory: '' }]) assert.throws(() => parseBatch(input, 'ledger'));
    assert.throws(() => parseBatch(valid, 'ipfs'));
    assert.throws(() => parseConfig({ mode: 'ipfs', batchLogging: valid, ipfsUrl: 'http://ipfs.example', allowedSigners: [Wallet.createRandom().address] }));
    let called = false;
    await assert.rejects(runOne({ config: { batchLogging: valid }, api: () => { called = true; } }), /direct runtime/);
    await assert.rejects(runWorker({ config: { batchLogging: valid } }), /direct runtime/);
    assert.equal(called, false);
});

test('HTTP count threshold publishes separate messages then one content-only manifest and one transaction', async t => {
    const s = await setup(t);
    await s.start();
    const first = await s.post();
    assert.equal(first.status, 202);
    const admission = await first.json();
    assert.equal(admission.status, 'pending');
    assert.equal(s.f.state.signs, 0);
    assert.equal(admission.publication.uri, `ipfs://${admission.publication.cid}`);
    const retry = await s.post();
    assert.equal(retry.status, 202);
    const duplicate = await retry.json();
    assert.deepEqual(duplicate, admission);
    assert.equal(s.uploads.length, 1);
    assert.equal((await s.post(await signedMessage(s.f.agent, 'second message'))).status, 202);
    await waitFor(async () => (await s.status()).recent.length === 1);
    const status = await s.status();
    assert.equal(status.recent[0].status, 'logged');
    assert.equal(s.uploads.length, 3);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
    assert.notEqual(s.uploads[0].cid, s.uploads[1].cid);
    assert.equal(s.uploads[2].text, s.uploads.slice(0, 2).map(m => m.cid).join('\n'));
    assert.equal(abi.decodeFunctionData('log', s.f.state.transactions[0].data)[0], s.uploads[2].cid);
    assert.ok(!JSON.stringify(status).includes('rawTransaction'));
    assert.ok(!JSON.stringify(status).includes(s.f.message.text));
});

test('identical ordered CIDs produce identical manifest bytes across nodes, chains and batches', async t => {
    const first = await setup(t);
    const second = await setup(t, { chainId: 31338,
        ledgerContract: '0x2222222222222222222222222222222222222222', allowedSigners: [first.f.agent.address] });
    const messages = [first.f.message, await signedMessage(first.f.agent, 'second content')];
    const batches = [];
    for (const s of [first, second]) {
        const batch = await s.open();
        batches.push(batch);
        for (const message of messages) await batch.accept(message);
        assert.equal(s.f.state.signs, 0);
        await batch.flush();
        const tx = s.f.state.transactions[0];
        assert.equal(tx.chainId, BigInt(s.f.config.chainId));
        assert.equal(tx.to.toLowerCase(), s.f.config.ledgerContract.toLowerCase());
        assert.equal(tx.from, s.f.wallet.address);
        assert.equal(abi.decodeFunctionData('log', tx.data)[0], s.uploads[2].cid);
    }
    assert.notEqual(batches[0].status().recent[0].batchId, batches[1].status().recent[0].batchId);
    assert.notEqual(first.f.wallet.address, second.f.wallet.address);
    assert.deepEqual(first.uploads, second.uploads);
    for (const message of messages) await batches[0].accept(message);
    await batches[0].flush();
    assert.deepEqual(first.uploads[5], first.uploads[2]);
    for (const message of [...messages].reverse()) await batches[0].accept(message);
    await batches[0].flush();
    assert.notEqual(first.uploads[8].cid, first.uploads[2].cid);
    assert.deepEqual(first.uploads[8].text.split('\n'), first.uploads[2].text.split('\n').reverse());
});

for (const changed of ['chain', 'contract', 'node']) {
    test(`content-only manifest does not allow recovery under a changed ${changed}`, async t => {
        const s = await setup(t);
        s.f.config.receiptTimeoutMs = 25;
        const batch = await s.open();
        await batch.accept(s.f.message);
        s.f.state.receiptMode = 'pending';
        await assert.rejects(batch.flush());
        await batch.close();
        const before = await s.journal();
        const options = { ...s.options, config: { ...s.f.config } };
        if (changed === 'chain') options.config.chainId++;
        if (changed === 'contract') options.config.ledgerContract = '0x2222222222222222222222222222222222222222';
        if (changed === 'node') options.signer = { address: Wallet.createRandom().address };
        await assert.rejects(createBatchLogger(options), /identity/);
        assert.deepEqual(await s.journal(), before);
        assert.equal(s.f.state.signs, 1);
        assert.equal(s.f.state.sends, 1);
        assert.equal(s.uploads.length, 2);
    });
}

test('manifest upload acknowledgement loss retries identical bytes after restart before any signing', async t => {
    const s = await setup(t);
    const transport = s.options.fetch;
    let loseAck = true;
    s.options.fetch = async (url, request) => {
        const response = await transport(url, request);
        if (loseAck && url.startsWith(s.f.config.ipfs.url) && s.uploads.length === 2) {
            throw new Error('lost manifest acknowledgement');
        }
        return response;
    };
    let batch = await s.open();
    await batch.accept(s.f.message);
    await assert.rejects(batch.flush());
    const saved = await s.journal();
    assert.equal(saved.pending.sealed, true);
    assert.equal(saved.pending.cid, undefined);
    assert.equal(s.uploads[1].text, s.uploads[0].cid);
    assert.equal(s.f.state.signs, 0);
    assert.equal(s.f.state.sends, 0);
    await assert.rejects(batch.accept(await signedMessage(s.f.agent, 'cannot join')));
    await batch.close();
    loseAck = false;
    batch = await s.open();
    await batch.flush();
    assert.deepEqual(s.uploads[2], s.uploads[1]);
    assert.equal(s.uploads.length, 3);
    assert.equal(s.f.state.signs, 1);
    assert.equal(batch.status().recent[0].manifestCid, s.uploads[1].cid);
});

test('manifest checkpoint write failure retries exact CID lines after restart without premature signing', async t => {
    const s = await setup(t);
    const transport = s.options.fetch;
    let failCheckpoint = true;
    s.options.fetch = async (url, request) => {
        const response = await transport(url, request);
        if (failCheckpoint && url.startsWith(s.f.config.ipfs.url) && s.uploads.length === 3) {
            failCheckpoint = false;
            await mkdir(join(s.directory, 'batch.next'));
        }
        return response;
    };
    let batch = await s.open();
    await batch.accept(s.f.message);
    await batch.accept(await signedMessage(s.f.agent, 'second member'));
    await assert.rejects(batch.flush());
    const saved = await s.journal();
    assert.equal(saved.pending.sealed, true);
    assert.equal(saved.pending.cid, undefined);
    assert.equal(s.f.state.signs, 0);
    assert.equal(s.f.state.sends, 0);
    await assert.rejects(batch.flush());
    await batch.close();
    await rm(join(s.directory, 'batch.next'), { recursive: true });
    batch = await s.open();
    await batch.flush();
    assert.equal(s.uploads[2].text, s.uploads.slice(0, 2).map(({ cid }) => cid).join('\n'));
    assert.deepEqual(s.uploads[3], s.uploads[2]);
    assert.equal(s.uploads.length, 4);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
    assert.equal(batch.status().recent[0].manifestCid, s.uploads[2].cid);
});

for (const legacyFormat of ['execution-metadata', 'content-only-json']) for (const signed of [false, true]) {
    test(`${legacyFormat} manifest checkpoint is retained on restart (${signed ? 'signed' : 'unsigned'})`, async t => {
        const s = await setup(t);
        const transport = s.options.fetch;
        // Emulate bytes published by the earlier revision, without changing the journal format.
        s.options.fetch = async (url, request) => {
            if (url.startsWith(s.f.config.ipfs.url)) {
                if (request.body.get('file').name.startsWith('oya-message-batch.')) {
                    const saved = await s.journal();
                    const legacy = legacyFormat === 'content-only-json'
                        ? { type: 'oya-message-batch', version: 1, messages: saved.pending.entries.map(({ cid }) => cid) }
                        : { type: 'oya-message-batch', version: 1, batchId: saved.pending.id,
                        execution: saved.identity,
                        messages: saved.pending.entries.map(({ cid, messageDigest }) => ({ cid, messageDigest })) };
                    const body = new FormData();
                    body.append('file', new Blob([JSON.stringify(legacy)], { type: 'application/json' }), 'oya-message-batch.json');
                    request = { ...request, body };
                }
            }
            return transport(url, request);
        };
        s.f.config.receiptTimeoutMs = 25;
        let batch = await s.open();
        await batch.accept(s.f.message);
        if (signed) s.f.state.receiptMode = 'pending';
        else s.f.state.preparationFailure = true;
        await assert.rejects(batch.flush());
        const saved = await s.journal();
        assert.ok(saved.pending.cid);
        assert.equal(Boolean(saved.pending.transaction), signed);
        assert.equal(Boolean(JSON.parse(s.uploads[1].text).execution), legacyFormat === 'execution-metadata');
        await batch.close();
        s.options.fetch = transport;
        s.f.state.receiptMode = 'mined';
        s.f.state.preparationFailure = false;
        const authorize = s.f.config.authorize;
        s.f.config.authorize = () => { throw new Error('revoked'); };
        batch = await s.open();
        if (!signed) {
            await assert.rejects(batch.flush(), /revoked/);
            assert.equal(s.f.state.signs, 0);
            assert.equal(s.f.state.sends, 0);
            s.f.config.authorize = authorize;
        }
        await batch.flush();
        assert.equal(s.uploads.length, 2);
        assert.equal(s.f.state.signs, 1);
        assert.equal(s.f.state.sends, 1);
        assert.equal(batch.status().recent[0].manifestCid, saved.pending.cid);
        if (signed) {
            assert.equal(batch.status().recent[0].transactionHash, saved.pending.transaction.transactionHash);
            assert.equal(s.f.state.transactions[0].serialized, saved.pending.transaction.rawTransaction);
        }
    });
}

test('elapsed trigger uses persisted time since last verified log, including idle time', async t => {
    const s = await setup(t);
    let clock = 100000;
    let batch = await s.open({ now: () => clock });
    await batch.close();
    clock += 60001;
    batch = await s.open({ now: () => clock });
    await batch.accept(s.f.message);
    await waitFor(() => batch.status().recent.length === 1);
    assert.equal((await s.journal()).lastLoggedAt, clock);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.uploads.length, 2);
});

test('idle batches never publish and shutdown retains underfilled batch for restart', async t => {
    const s = await setup(t);
    let batch = await s.open();
    await batch.flush();
    assert.equal(s.uploads.length, 0);
    const result = await batch.accept(s.f.message);
    await batch.close();
    assert.equal(s.f.state.signs, 0);
    batch = await s.open();
    assert.equal(batch.status().pending.batchId, result.batchId);
    assert.deepEqual(await batch.accept(s.f.message), result);
    assert.equal(s.uploads.length, 1);
    assert.equal(s.f.state.signs, 0);
    await batch.flush();
    assert.equal(batch.status().recent[0].status, 'logged');
    assert.equal(s.uploads.length, 2);
    assert.equal(s.uploads[1].text, s.uploads[0].cid);
});

test('failed manifest freezes membership, blocks admission, then retries without republishing messages', async t => {
    const s = await setup(t);
    const batch = await s.open();
    await batch.accept(s.f.message);
    s.f.state.manifestFailure = true;
    await assert.rejects(batch.flush());
    assert.equal(s.f.state.signs, 0);
    await assert.rejects(batch.accept(await signedMessage(s.f.agent, 'not admitted')));
    assert.equal(batch.status().blocked, true);
    s.f.state.manifestFailure = false;
    await batch.flush();
    assert.equal(s.uploads.length, 2);
    assert.equal(batch.status().blocked, false);
});

for (const failure of ['pending', 'wrongReceipt', 'sendFailure']) {
    test(`${failure}: durable restart reconciles exact transaction, even after signer revocation`, async t => {
        const s = await setup(t);
        s.f.config.receiptTimeoutMs = 25;
        let batch = await s.open();
        await batch.accept(s.f.message);
        if (failure === 'wrongReceipt') s.f.state.wrongReceipt = true;
        else { s.f.state.receiptMode = 'pending'; s.f.state.sendFailure = failure === 'sendFailure'; }
        await assert.rejects(batch.flush());
        const checkpoint = await s.journal();
        assert.ok(checkpoint.pending.transaction);
        await batch.close();
        s.f.config.authorize = () => { throw new Error('revoked'); };
        s.f.state.receiptMode = 'mined';
        s.f.state.wrongReceipt = false;
        s.f.state.sendFailure = false;
        batch = await s.open();
        await batch.flush();
        assert.equal(batch.status().recent[0].transactionHash, checkpoint.pending.transaction.transactionHash);
        assert.equal(s.uploads[1].text, s.uploads[0].cid);
        for (const tx of s.f.state.transactions) assert.equal(tx.serialized, checkpoint.pending.transaction.rawTransaction);
        assert.equal(s.f.state.signs, 1);
        assert.equal(s.uploads.length, 2);
    });
}

test('authorization rejects outsiders/tampering before uploads and revoked pending signers before signing', async t => {
    const s = await setup(t);
    const batch = await s.open();
    await assert.rejects(batch.accept(await signedMessage(Wallet.createRandom())));
    await assert.rejects(batch.accept({ ...s.f.message, text: 'tampered' }));
    assert.equal(s.uploads.length, 0);
    await batch.accept(s.f.message);
    s.f.config.authorize = () => { throw new Error('revoked'); };
    await assert.rejects(batch.flush());
    assert.equal(s.uploads.length, 1);
    assert.equal(s.f.state.signs, 0);
});

test('exclusive directory lock, corrupt journal and execution identity fail closed', async t => {
    const s = await setup(t);
    const batch = await s.open();
    await assert.rejects(createBatchLogger(s.options), /EEXIST/);
    await batch.accept(s.f.message);
    await batch.close();
    await assert.rejects(createBatchLogger({ ...s.options, signer: { address: Wallet.createRandom().address } }), /identity/);
    const journal = await s.journal();
    journal.pending.entries[0].message.text = 'altered';
    await writeFile(join(s.directory, 'batch.json'), JSON.stringify(journal));
    await assert.rejects(createBatchLogger(s.options), /checkpoint|signature/);
    assert.equal(s.f.state.signs, 0);
});

test('journal failure after IPFS blocks later work and restart reloads acknowledged state', async t => {
    const s = await setup(t);
    let batch = await s.open();
    await mkdir(join(s.directory, 'batch.next'));
    await assert.rejects(batch.accept(s.f.message));
    assert.equal(s.uploads.length, 1);
    assert.equal(batch.status().pending, null);
    await assert.rejects(batch.accept(s.f.message));
    assert.equal(s.uploads.length, 1);
    await batch.close();
    await rm(join(s.directory, 'batch.next'), { recursive: true });
    batch = await s.open();
    await batch.accept(s.f.message);
    await batch.flush();
    assert.equal(s.f.state.signs, 1);
});

test('transaction checkpoint write failure prevents broadcast', async t => {
    const s = await setup(t);
    const original = s.options.signer.signTransaction;
    s.options.signer.signTransaction = async (...args) => {
        const tx = await original(...args);
        await mkdir(join(s.directory, 'batch.next'));
        return tx;
    };
    const batch = await s.open();
    await batch.accept(s.f.message);
    await assert.rejects(batch.flush());
    assert.equal(s.f.state.sends, 0);
    assert.equal((await s.journal()).pending.transaction, undefined);
    await assert.rejects(batch.flush());
    assert.equal(s.f.state.signs, 1);
});

test('serialization/backpressure and shutdown wait for admitted IPFS work', async t => {
    const s = await setup(t);
    const batch = await s.open();
    const held = gate();
    s.f.state.onUpload = () => held.wait();
    const accepted = batch.accept(s.f.message);
    await held.entered;
    await assert.rejects(batch.accept(s.f.message));
    let stopped = false;
    const closing = batch.close().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stopped, false);
    held.release();
    await accepted;
    await closing;
    assert.equal((await s.journal()).pending.entries.length, 1);
    assert.equal(s.f.state.signs, 0);
});

test('reverted transaction has terminal failed status and is not silently re-signed', async t => {
    const s = await setup(t);
    const batch = await s.open();
    await batch.accept(s.f.message);
    s.f.state.receiptMode = 'reverted';
    await batch.flush();
    assert.equal(batch.status().recent[0].status, 'failed');
    assert.equal(batch.status().recent[0].error, 'transaction_reverted');
    await batch.flush();
    assert.equal(s.f.state.signs, 1);
});

test('individual upload failure never admits, seals or signs a message', async t => {
    const s = await setup(t);
    const batch = await s.open();
    s.f.state.ipfsFailure = true;
    await assert.rejects(batch.accept(s.f.message));
    assert.equal((await s.journal()).pending, null);
    assert.equal(s.f.state.signs, 0);
    s.f.state.ipfsFailure = false;
    await batch.accept(s.f.message);
    await batch.flush();
    assert.equal(s.f.state.signs, 1);
});

test('full batch rejects overflow without another upload and pending duplicate is stable', async t => {
    const s = await setup(t);
    const batch = await s.open();
    const first = await batch.accept(s.f.message);
    await batch.accept(await signedMessage(s.f.agent, 'two'));
    await assert.rejects(batch.accept(await signedMessage(s.f.agent, 'overflow')));
    assert.equal((await batch.accept(s.f.message)).batchId, first.batchId);
    assert.equal(s.uploads.length, 2);
    await batch.flush();
    assert.equal(batch.status().recent[0].messageCids.length, 2);
});

test('completion write failure recovers saved transaction instead of signing again', async t => {
    const s = await setup(t);
    const transport = s.options.fetch;
    let failCompletion = true;
    s.options.fetch = async (url, request) => {
        const response = await transport(url, request);
        if (!url.startsWith(s.f.config.ipfs.url) && JSON.parse(request.body).method === 'eth_getTransactionReceipt') {
            const body = await response.clone().json();
            if (body.result && failCompletion) {
                failCompletion = false;
                await mkdir(join(s.directory, 'batch.next'));
            }
        }
        return response;
    };
    let batch = await s.open();
    await batch.accept(s.f.message);
    await assert.rejects(batch.flush());
    const saved = await s.journal();
    assert.ok(saved.pending.transaction);
    assert.equal(batch.status().blocked, true);
    await batch.close();
    await rm(join(s.directory, 'batch.next'), { recursive: true });
    batch = await s.open();
    await batch.flush();
    assert.equal(batch.status().recent[0].transactionHash, saved.pending.transaction.transactionHash);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
});

test('bounded recent retention survives restart without retaining message text', async t => {
    const s = await setup(t);
    let batch = await s.open();
    let firstId;
    for (let i = 0; i < 101; i++) {
        const result = await batch.accept(await signedMessage(s.f.agent, `retention ${i}`));
        firstId ??= result.batchId;
        await batch.flush();
    }
    const journal = await s.journal();
    assert.equal(journal.recent.length, 100);
    assert.ok(journal.recent.every(item => item.batchId !== firstId));
    assert.equal(journal.pending, null);
    assert.ok(!JSON.stringify(journal).includes('retention '));
    await batch.close();
    batch = await s.open();
    assert.equal(batch.status().recent.length, 100);
});

test('HTTP admission failure is sanitized and health/status report blocked background work', async t => {
    const s = await setup(t);
    await s.start();
    s.f.state.manifestFailure = true;
    assert.equal((await s.post()).status, 202);
    assert.equal((await s.post(await signedMessage(s.f.agent, 'second'))).status, 202);
    await waitFor(async () => (await s.status()).blocked);
    const healthResponse = await fetch(`${s.url}/healthz`);
    assert.equal(healthResponse.status, 503);
    const health = await healthResponse.json();
    assert.equal(health.status, 'batch_blocked');
    const lines = [];
    assert.equal(await statusLocalNode({ config: s.f.config, nodeAddress: s.f.wallet.address }, {
        fetch: async () => new Response(JSON.stringify(health), { status: 503 }), log: line => lines.push(line),
    }), 1);
    assert.ok(lines[0].includes('batch_blocked'));
    const rejected = await s.post(await signedMessage(s.f.agent, 'third'));
    assert.equal(rejected.status, 503);
    assert.ok(!(await rejected.text()).includes('secret-provider-error'));
    s.f.state.manifestFailure = false;
    await waitFor(async () => (await s.status()).recent.length === 1);
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
});

test('HTTP permanent batch size rejection is non-retryable and has no side effects', async t => {
    const s = await setup(t, { maxTextBytes: 16384 });
    await s.start();
    const response = await s.post(await signedMessage(s.f.agent, 'x'.repeat(8193)));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { code: 'batch_text_too_large', started: false, loggingOutcome: 'not_started' });
    assert.equal(s.uploads.length, 0);
    assert.equal(s.f.state.signs, 0);
    assert.equal((await s.status()).pending, null);
});

test('HTTP signature and allowlist failures have no batch publication effects', async t => {
    const s = await setup(t);
    await s.start();
    const outsider = await s.post(await signedMessage(Wallet.createRandom()));
    assert.equal(outsider.status, 403);
    const tampered = await s.post({ ...s.f.message, text: 'tampered' });
    assert.ok(tampered.status >= 400);
    assert.equal(s.uploads.length, 0);
    assert.equal(s.f.state.signs, 0);
    assert.equal((await s.status()).pending, null);
});

test('failure after signing but before broadcast resumes checkpoint without a new signature', async t => {
    const s = await setup(t);
    const transport = s.options.fetch;
    let fail = true;
    s.options.fetch = async (url, request) => {
        if (fail && !url.startsWith(s.f.config.ipfs.url) && JSON.parse(request.body).method === 'eth_getTransactionReceipt') {
            throw new Error('synthetic transport interruption');
        }
        return transport(url, request);
    };
    let batch = await s.open();
    await batch.accept(s.f.message);
    await assert.rejects(batch.flush());
    assert.equal(s.f.state.sends, 0);
    const saved = await s.journal();
    assert.ok(saved.pending.transaction);
    await batch.close();
    fail = false;
    batch = await s.open();
    await batch.flush();
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
    assert.equal(batch.status().recent[0].transactionHash, saved.pending.transaction.transactionHash);
});

test('transaction/CID mismatch in recovery state is rejected before any retry side effect', async t => {
    const s = await setup(t);
    s.f.config.receiptTimeoutMs = 25;
    const batch = await s.open();
    await batch.accept(s.f.message);
    s.f.state.receiptMode = 'pending';
    await assert.rejects(batch.flush());
    await batch.close();
    const saved = await s.journal();
    saved.pending.cid = contentCid('wrong manifest');
    await writeFile(join(s.directory, 'batch.json'), JSON.stringify(saved));
    await assert.rejects(createBatchLogger(s.options), /invalid_transaction_checkpoint/);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
    assert.equal(s.uploads.length, 2);
});
