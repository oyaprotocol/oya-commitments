import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runOne } from '../src/inbox/worker.mjs';
import { processWork } from '../src/inbox/processor.mjs';
import { signJob } from '../src/inbox/protocol.mjs';
import { fixture, cid } from './runtime-fixture.mjs';

const otherAddress = `0x${'ab'.repeat(20)}`;

// Real signatures, transaction preparation and receipt/event parsing; only transports
// and durable storage are simulated. A fresh invocation receives the saved checkpoint.
async function setup(t, { poll = false, mutate = () => {}, sendError = false } = {}) {
    const f = await fixture(t);
    const job = await signJob(f.agent, 'test', 'testnet ledger acceptance');
    let checkpoint = {};
    let receiptReads = 0;
    let mutation = mutate;
    const events = [];
    const fetch = async (url, request) => {
        const response = await f.transport(url, request);
        if (url.startsWith(f.config.ipfs.url)) return response;
        const { method } = JSON.parse(request.body);
        if (method === 'eth_sendRawTransaction' && sendError) {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(request.body).id,
                error: { code: -32000, message: 'already known' } }));
        }
        if (method !== 'eth_getTransactionReceipt') return response;
        const body = await response.json();
        if (poll && ++receiptReads === 1) body.result = null;
        else if (body.result) mutation(body.result);
        return new Response(JSON.stringify(body));
    };
    const save = async change => { checkpoint = { ...checkpoint, ...change }; events.push('checkpoint'); };
    const options = () => ({ work: { job, requestId: job.requestId, checkpoint: structuredClone(checkpoint) },
        config: f.config, target: 'test', allowedSigners: [f.agent.address], signer: f.signer, fetch, save });
    return { f, job, events, options, checkpoint: () => structuredClone(checkpoint),
        correctReceipt: () => { mutation = () => {}; },
        run: () => processWork(options()) };
}

for (const poll of [false, true]) {
    for (const reverted of [false, true]) {
        for (const [name, mutate] of [
            ['wrong sender', receipt => { receipt.from = otherAddress; }],
            ['wrong destination', receipt => { receipt.to = otherAddress; }],
            ['null destination', receipt => { receipt.to = null; }],
            ['contract creation', receipt => { receipt.contractAddress = otherAddress; }],
        ]) {
            test(`${poll ? 'polled' : 'existing'} ${reverted ? 'reverted' : 'successful'} receipt rejects ${name} and resumes same hash`, async t => {
                const s = await setup(t, { poll, mutate });
                if (reverted) s.f.state.receiptMode = 'reverted';
                await assert.rejects(s.run(), /Ledger receipt identity mismatch/);
                const checkpoint = s.checkpoint();
                assert.ok(checkpoint.transaction);
                s.correctReceipt();
                const result = await s.run();
                assert.equal(result.status, reverted ? 'failed' : 'logged');
                assert.equal(result.transactionHash, checkpoint.transaction.transactionHash);
                assert.deepEqual(s.checkpoint(), checkpoint);
                assert.equal(s.f.state.signs, 1);
                assert.equal(s.f.state.uploads, 1);
                assert.equal(s.f.state.sends, poll ? 1 : 0);
            });
        }
    }
    test(`${poll ? 'polled' : 'existing'} valid receipt accepts case-insensitive sender`, async t => {
        const s = await setup(t, { poll, mutate: receipt => { receipt.from = `0x${receipt.from.slice(2).toUpperCase()}`; } });
        assert.deepEqual(await s.run(), { status: 'logged', cid, transactionHash: s.checkpoint().transaction.transactionHash });
    });
}

for (const [name, mutate] of [
    ['no event', receipt => { receipt.logs = []; }],
    ['wrong emitting contract', receipt => { receipt.logs[0].address = otherAddress; }],
    ['wrong event node', receipt => { receipt.logs[0].topics[1] = `0x${'0'.repeat(24)}${otherAddress.slice(2)}`; }],
    ['wrong CID hash', receipt => { receipt.logs[0].topics[2] = `0x${'00'.repeat(32)}`; }],
    ['removed event', receipt => { receipt.logs[0].removed = true; }],
    ['wrong receipt hash', receipt => { receipt.transactionHash = `0x${'00'.repeat(32)}`; }],
    ['wrong log block', receipt => { receipt.logs[0].blockNumber = '0x999'; }],
]) {
    test(`cannot log with ${name}`, async t => {
        const s = await setup(t, { mutate });
        await assert.rejects(s.run());
        assert.equal(s.f.state.signs, 1);
        s.correctReceipt();
        assert.equal((await s.run()).status, 'logged');
        assert.equal(s.f.state.signs, 1);
    });
}

test('duplicate broadcast error reconciles receipt without signing another transaction', async t => {
    const s = await setup(t, { poll: true, sendError: true });
    const result = await s.run();
    assert.equal(result.status, 'logged');
    assert.equal(s.f.state.sends, 1);
    assert.equal(s.f.state.signs, 1);
    assert.equal(result.transactionHash, s.checkpoint().transaction.transactionHash);
});

test('receipt timeout and restart reuse saved transaction and publication', async t => {
    const s = await setup(t);
    s.f.config.receiptTimeoutMs = 20;
    s.f.state.receiptMode = 'pending';
    await assert.rejects(s.run());
    const checkpoint = s.checkpoint();
    assert.equal(s.f.state.sends, 1);
    s.f.state.receiptMode = 'mined';
    assert.equal((await s.run()).transactionHash, checkpoint.transaction.transactionHash);
    assert.equal(s.f.state.sends, 1);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.uploads, 1);
});

for (const [name, change] of [
    ['unauthorized signer', options => { options.allowedSigners = [otherAddress]; }],
    ['tampered message', options => { options.work.job = { ...options.work.job, message: { ...options.work.job.message, text: 'tampered' } }; }],
]) {
    test(`${name} cannot publish or sign`, async t => {
        const s = await setup(t);
        const options = s.options();
        change(options);
        await assert.rejects(processWork(options));
        assert.equal(s.f.state.uploads, 0);
        assert.equal(s.f.state.signs, 0);
        assert.equal(s.f.state.sends, 0);
    });
}

for (const [name, field, value] of [['wrong chain', 'chainId', '0x1'], ['empty bytecode', 'code', '0x']]) {
    test(`${name} cannot sign or broadcast`, async t => {
        const s = await setup(t);
        s.f.state[field] = value;
        await assert.rejects(s.run(), /Ledger configuration mismatch/);
        assert.equal(s.f.state.signs, 0);
        assert.equal(s.f.state.sends, 0);
    });
}

test('worker retries an inconsistent receipt rather than completing, then resumes its checkpoint', async t => {
    const s = await setup(t, { mutate: receipt => { receipt.to = otherAddress; } });
    const calls = [];
    const state = {};
    const api = async (path, body) => {
        calls.push(path);
        if (path.endsWith('/claim')) return { work: { ...s.options().work, lease: randomUUID(), attempts: 1 }, leaseMs: 3000 };
        if (path.endsWith('/checkpoint')) await s.options().save(body.checkpoint);
        if (path.endsWith('/complete')) assert.equal(body.result.status, 'logged');
        return {};
    };
    await runOne({ ...s.options(), api, state });
    assert.equal(state.status, 'retrying');
    assert.ok(calls.includes('/v1/worker/retry'));
    assert.ok(!calls.includes('/v1/worker/complete'));
    s.correctReceipt();
    await runOne({ ...s.options(), api, state });
    assert.equal(state.completed, 1);
    assert.equal(state.lastResult.transactionHash, s.checkpoint().transaction.transactionHash);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.uploads, 1);
});
