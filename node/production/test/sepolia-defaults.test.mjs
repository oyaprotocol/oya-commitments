import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Transaction, Wallet } from 'ethers';
import { encodeLedgerCall } from '@oyaprotocol/ethereum';
import { parseConfig } from '../src/config.mjs';
import { parseInboxConfig } from '../src/inbox/config.mjs';
import { executionIdentity, jobText, signJob } from '../src/inbox/protocol.mjs';
import { processWork } from '../src/inbox/processor.mjs';
import { runOne } from '../src/inbox/worker.mjs';
import { cid, fixture, gate, signedMessage } from './runtime-fixture.mjs';

// These expectations deliberately do not import runtime default constants.
const sepoliaLedger = '0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3';
const sepoliaRpc = 'https://ethereum-sepolia-rpc.publicnode.com';
const otherLedger = '0x2222222222222222222222222222222222222222';
const zeroAddress = '0x0000000000000000000000000000000000000000';
const agent = Wallet.createRandom();
const nodeWallet = Wallet.createRandom();
const target = 'sepolia-defaults';
const nodeInput = (changes = {}) => ({ allowedSigners: [agent.address], ipfsUrl: 'http://ipfs.example', ...changes });
const inboxInput = execution => ({ target, allowedSigners: [agent.address], execution });
const parse = input => parseConfig(input, { env: {} });
const ledgerFields = ['chainId', 'ledgerContract', 'rpcUrl', 'receiptTimeoutMs', 'pollIntervalMs', 'gasLimit', 'maxFeePerGasWei'];

function assertSepolia(config) {
    assert.equal(config.mode, 'ledger');
    assert.equal(config.chainId, 11155111);
    assert.equal(config.ledgerContract, '0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3');
    assert.equal(new URL(config.rpc.url).href, 'https://ethereum-sepolia-rpc.publicnode.com/');
}

test('minimal node config resolves verified Sepolia Ledger defaults without mutating its input', async () => {
    const input = nodeInput();
    const before = structuredClone(input);
    Object.freeze(input.allowedSigners);
    Object.freeze(input);
    const config = parse(input);
    assertSepolia(config);
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(config), true);
    const authorized = await signedMessage(agent);
    assert.deepEqual(config.authorize(authorized), authorized);
    const disallowed = await signedMessage(Wallet.createRandom());
    assert.throws(() => config.authorize(disallowed), { code: 'unauthorized_signer' });
    assertSepolia(parse(nodeInput({ mode: 'ledger', chainId: 11155111 })));
});

test('explicit chain, contract, and RPC override defaults independently without cross-chain leakage', () => {
    for (const chainId of [1, 31337]) {
        const config = parse(nodeInput({ chainId, ledgerContract: otherLedger, rpcUrl: 'http://rpc.example' }));
        assert.equal(config.chainId, chainId);
        assert.equal(config.ledgerContract, otherLedger);
        assert.equal(new URL(config.rpc.url).href, 'http://rpc.example/');
        for (const missing of [['ledgerContract'], ['rpcUrl'], ['ledgerContract', 'rpcUrl']]) {
            const input = nodeInput({ chainId, ledgerContract: otherLedger, rpcUrl: 'http://rpc.example' });
            for (const key of missing) delete input[key];
            assert.throws(() => parse(input), `${chainId} must require ${missing.join(' and ')}`);
        }
    }
    const contract = parse(nodeInput({ ledgerContract: otherLedger }));
    assert.equal(contract.chainId, 11155111);
    assert.equal(contract.ledgerContract, otherLedger);
    assert.equal(new URL(contract.rpc.url).href, 'https://ethereum-sepolia-rpc.publicnode.com/');
    const rpc = parse(nodeInput({ rpcUrl: 'http://rpc.example' }));
    assert.equal(rpc.chainId, 11155111);
    assert.equal(rpc.ledgerContract, sepoliaLedger);
    assert.equal(new URL(rpc.rpc.url).href, 'http://rpc.example/');
});

const invalidAddresses = [null, false, 0, '', '0x', zeroAddress, `0x${'1'.repeat(39)}`, `0x${'g'.repeat(40)}`,
    '0xE6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3', [sepoliaLedger], {}];
const invalidChains = [null, false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '11155111', [], {}];
const invalidModes = [null, false, 0, '', 'IPFS', 'unknown', [], {}];

for (const [field, values] of [
    ['mode', invalidModes], ['chainId', invalidChains], ['ledgerContract', invalidAddresses],
    ['rpcUrl', [null, false, 0, '', 'file:///rpc', 'ftp://rpc.example', 'https://', ['http://rpc.example'], {}]],
]) {
    test(`explicit invalid ${field} never silently selects a default`, () => {
        for (const value of values) assert.throws(() => parse(nodeInput({ [field]: value })), `${field}: ${String(value)}`);
    });
}

test('Sepolia defaults do not supply authorization or IPFS and still reject unknown configuration', () => {
    for (const input of [null, [], 'ledger', {},
        nodeInput({ allowedSigners: undefined }), nodeInput({ allowedSigners: null }), nodeInput({ allowedSigners: [] }),
        nodeInput({ allowedSigners: ['not-an-address'] }), nodeInput({ ipfsUrl: undefined }), nodeInput({ ipfsUrl: null }),
        nodeInput({ ipfsUrl: 'file:///ipfs' }), nodeInput({ typo: true })]) {
        assert.throws(() => parse(input));
    }
});

test('explicit IPFS node opts out of all Ledger defaults and rejects every supplied Ledger setting', () => {
    const config = parse(nodeInput({ mode: 'ipfs' }));
    assert.equal(config.mode, 'ipfs');
    assert.deepEqual(executionIdentity(config), { mode: 'ipfs' });
    for (const field of ['chainId', 'ledgerContract', 'rpc', 'limits', 'receiptTimeoutMs', 'pollIntervalMs']) {
        assert.equal(Object.hasOwn(config, field), false, field);
    }
    for (const field of ledgerFields) {
        for (const value of [undefined, null, 1]) {
            assert.throws(() => parse(nodeInput({ mode: 'ipfs', [field]: value })), /IPFS mode/, field);
        }
    }
});

test('minimal inbox execution matches the default worker identity without modifying operator input', () => {
    const input = inboxInput({ nodeAddress: nodeWallet.address });
    const before = structuredClone(input);
    Object.freeze(input.execution);
    Object.freeze(input.allowedSigners);
    Object.freeze(input);
    const config = parseInboxConfig(input);
    assert.deepEqual(config.execution, {
        mode: 'ledger', chainId: 11155111,
        ledgerContract: '0xe6deb4b3c31e15dbea0f932830e2f20ba2eddaa3', nodeAddress: nodeWallet.address.toLowerCase(),
    });
    assert.deepEqual(config.execution, executionIdentity(parse(nodeInput()), nodeWallet.address));
    assert.deepEqual(input, before);
    assert.notEqual(config.execution, input.execution);
    assert.deepEqual(parseInboxConfig(inboxInput({ mode: 'ledger', nodeAddress: nodeWallet.address })).execution, config.execution);
});

test('inbox honors explicit chain/contract identity, but other chains cannot inherit the Sepolia contract', () => {
    for (const chainId of [1, 31337]) {
        const execution = { mode: 'ledger', chainId, ledgerContract: otherLedger, nodeAddress: nodeWallet.address };
        const input = inboxInput(execution);
        const before = structuredClone(input);
        const inbox = parseInboxConfig(input);
        const node = parse(nodeInput({ chainId, ledgerContract: otherLedger, rpcUrl: 'http://rpc.example' }));
        assert.deepEqual(inbox.execution, executionIdentity(node, nodeWallet.address));
        assert.deepEqual(input, before);
        assert.equal(inbox.execution.chainId, chainId);
        assert.equal(inbox.execution.ledgerContract, otherLedger);
        assert.throws(() => parseInboxConfig(inboxInput({ chainId, nodeAddress: nodeWallet.address })));
    }
    const inbox = parseInboxConfig(inboxInput({ ledgerContract: otherLedger, nodeAddress: nodeWallet.address }));
    assert.equal(inbox.execution.chainId, 11155111);
    assert.equal(inbox.execution.ledgerContract, otherLedger);
});

test('inbox requires an execution object and an actual node address, never an inferred address', () => {
    const withoutExecution = { target, allowedSigners: [agent.address] };
    assert.throws(() => parseInboxConfig(withoutExecution));
    for (const input of [null, [], 'ledger']) assert.throws(() => parseInboxConfig(input));
    for (const execution of [undefined, null, false, 0, 'ledger', [], {}, { mode: 'ledger' },
        { mode: 'ledger', chainId: 11155111, ledgerContract: sepoliaLedger }]) {
        assert.throws(() => parseInboxConfig(inboxInput(execution)));
    }
    for (const nodeAddress of [undefined, ...invalidAddresses, 'REPLACE_WITH_PUBLIC_NODE_ADDRESS']) {
        assert.throws(() => parseInboxConfig(inboxInput({ nodeAddress })), `nodeAddress: ${String(nodeAddress)}`);
    }
});

for (const [field, values] of [['mode', invalidModes], ['chainId', invalidChains], ['ledgerContract', invalidAddresses]]) {
    test(`inbox rejects explicit invalid execution.${field} instead of defaulting`, () => {
        for (const value of values) {
            assert.throws(() => parseInboxConfig(inboxInput({ nodeAddress: nodeWallet.address, [field]: value })), String(value));
        }
    });
}

test('inbox rejects unknown execution fields and explicit IPFS remains exactly mode-only', () => {
    for (const field of ['rpcUrl', 'allowedSigners', 'nodeAdress', 'extra']) {
        assert.throws(() => parseInboxConfig(inboxInput({ nodeAddress: nodeWallet.address, [field]: undefined })));
    }
    const input = inboxInput({ mode: 'ipfs' });
    const before = structuredClone(input);
    Object.freeze(input.execution);
    const inbox = parseInboxConfig(input);
    assert.deepEqual(inbox.execution, { mode: 'ipfs' });
    assert.deepEqual(inbox.execution, executionIdentity(parse(nodeInput({ mode: 'ipfs' }))));
    assert.deepEqual(input, before);
    for (const field of ['nodeAddress', ...ledgerFields, 'extra']) {
        for (const value of [undefined, null, 1]) {
            assert.throws(() => parseInboxConfig(inboxInput({ mode: 'ipfs', [field]: value })), field);
        }
    }
});

// All cryptography and processing are real. Only transports and durable storage are
// fakes; the public default URL is inspected, never fetched. The shared fixture keeps
// explicit Anvil defaults for the existing suite while its receipts follow its config.
async function defaultWorker(t) {
    const f = await fixture(t, { chainId: 11155111, ledgerContract: sepoliaLedger, rpcUrl: sepoliaRpc });
    const parsed = parse({ allowedSigners: [f.agent.address], ipfsUrl: 'http://ipfs.example' });
    assertSepolia(parsed);
    const config = { ...parsed, operationTimeoutMs: 3000, receiptTimeoutMs: 1000, pollIntervalMs: 5,
        rpc: { ...parsed.rpc, maxRetries: 0 }, ipfs: { ...parsed.ipfs, maxRetries: 0 } };
    const job = await signJob(f.agent, target, 'verified Sepolia Ledger publication');
    const events = [], uploads = [], checkpoints = [], rpcRequests = [], receipts = [];
    const state = {};
    let checkpoint = {};
    const save = async change => {
        const kind = Object.hasOwn(change, 'cid') ? 'cid' : 'transaction';
        if (state.rejectCheckpoint === kind) throw new Error('checkpoint acknowledgement failed');
        checkpoint = { ...checkpoint, ...structuredClone(change) };
        checkpoints.push(structuredClone(change));
        events.push(`checkpoint:${kind}`);
    };
    const signer = { address: f.signer.address, async signTransaction(transaction, signal) {
        assert.equal(checkpoint.cid, cid, 'publication must be durably acknowledged before signing');
        assert.equal(f.state.uploads, 1);
        events.push('sign');
        return f.signer.signTransaction(transaction, signal);
    } };
    const fetch = async (url, request) => {
        if (url.startsWith(`${config.ipfs.url}/api/v0/add?`)) {
            events.push('ipfs:start');
            uploads.push(await request.body.get('file').text());
            const response = await f.transport(url, request);
            if (response.ok) events.push('ipfs:complete');
            return response;
        }
        assert.equal(url, config.rpc.url, 'unexpected transport destination');
        const rpc = JSON.parse(request.body);
        rpcRequests.push(rpc);
        if (rpc.method === 'eth_sendRawTransaction') {
            assert.ok(checkpoint.transaction, 'broadcast requires an acknowledged transaction checkpoint');
            assert.equal(rpc.params[0], checkpoint.transaction.rawTransaction);
            events.push('broadcast');
        }
        if (rpc.method === 'eth_getTransactionReceipt') {
            f.state.receiptMode = f.state.sends ? 'mined' : 'pending';
            events.push(`receipt:${f.state.receiptMode}`);
        }
        const response = await f.transport(url, request);
        if (rpc.method !== 'eth_getTransactionReceipt') return response;
        const body = await response.json();
        if (body.result) {
            state.mutateReceipt?.(body.result);
            receipts.push(structuredClone(body.result));
        }
        return Response.json(body);
    };
    const options = () => ({ work: { job, requestId: job.requestId, lease: randomUUID(), attempts: 1,
        checkpoint: structuredClone(checkpoint) }, config, target, allowedSigners: [f.agent.address], signer, save, fetch });
    return { f, job, config, state, events, uploads, checkpoints, rpcRequests, receipts, save, options,
        checkpoint: () => structuredClone(checkpoint), run: () => processWork(options()) };
}

test('default worker verifies, publishes, checkpoints, signs Sepolia Ledger call, broadcasts, and verifies the mined event', async t => {
    const s = await defaultWorker(t);
    const upload = gate();
    t.after(upload.release);
    s.f.state.onUpload = upload.wait;
    const workerState = {};
    const completions = [];
    const inbox = parseInboxConfig({ target, allowedSigners: [s.f.agent.address], execution: { nodeAddress: s.f.wallet.address } });
    const api = async (path, body) => {
        if (path === '/v1/worker/claim') {
            assert.deepEqual(body, { target, execution: inbox.execution });
            s.events.push('claim');
            return { work: s.options().work, leaseMs: 3000 };
        }
        if (path === '/v1/worker/checkpoint') { await s.save(body.checkpoint); return {}; }
        if (path === '/v1/worker/complete') {
            s.events.push('complete');
            completions.push(body.result);
            return {};
        }
        assert.fail(`Unexpected worker API call: ${path}`);
    };
    const running = runOne({ ...s.options(), api, state: workerState });
    await Promise.race([upload.entered, running.then(() => assert.fail('Worker finished before reaching IPFS'))]);
    assert.equal(s.f.state.signs, 0);
    assert.equal(s.f.state.sends, 0);
    assert.deepEqual(s.f.state.calls, []);
    assert.deepEqual(s.checkpoint(), {});
    upload.release();
    assert.equal(await running, true);
    assert.equal(workerState.status, 'idle');
    assert.equal(workerState.completed, 1);
    const checkpoint = s.checkpoint();
    const transaction = Transaction.from(checkpoint.transaction.rawTransaction);
    assert.equal(transaction.chainId, 11155111n);
    assert.equal(transaction.to, '0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3');
    assert.equal(transaction.from, s.f.wallet.address);
    assert.equal(transaction.type, 2);
    assert.equal(transaction.value, 0n);
    assert.equal(transaction.data, encodeLedgerCall(cid));
    assert.equal(transaction.hash, checkpoint.transaction.transactionHash);
    assert.equal(s.f.state.transactions[0].serialized, checkpoint.transaction.rawTransaction);
    assert.deepEqual(completions, [{ status: 'logged', cid, transactionHash: transaction.hash }]);
    assert.deepEqual(workerState.lastResult, completions[0]);
    assert.deepEqual(s.uploads, [JSON.stringify(s.job.message)]);
    assert.deepEqual(s.checkpoints, [{ cid }, { transaction: checkpoint.transaction }]);
    assert.deepEqual(s.events, ['claim', 'ipfs:start', 'ipfs:complete', 'checkpoint:cid', 'sign',
        'checkpoint:transaction', 'receipt:pending', 'broadcast', 'receipt:mined', 'complete']);
    assert.equal(s.f.state.uploads, 1);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.sends, 1);
    assert.equal(s.f.state.mined, 1);
    assert.ok(s.rpcRequests.some(({ method }) => method === 'eth_chainId'));
    assert.deepEqual(s.rpcRequests.find(({ method }) => method === 'eth_getCode').params, [sepoliaLedger, 'latest']);
    assert.equal(s.receipts[0].to, sepoliaLedger);
    assert.equal(s.receipts[0].logs[0].address, sepoliaLedger);
});

for (const [name, change] of [
    ['invalid message signature with a valid outer job signature', async s => {
        s.job.message.text = 'tampered after message signing';
        s.job.requestSignature = await s.f.agent.signMessage(jobText(s.job));
    }],
    ['invalid job signature with a valid message signature', async s => {
        s.job.requestSignature = await Wallet.createRandom().signMessage(jobText(s.job));
    }],
    ['valid signatures from a disallowed signer', async s => {
        Object.assign(s.job, await signJob(Wallet.createRandom(), target, 'not allowed'));
    }],
]) {
    test(`default worker rejects ${name} before upload, signing, or broadcast`, async t => {
        const s = await defaultWorker(t);
        await change(s);
        await assert.rejects(s.run(), { message: 'invalid_signed_job' });
        assert.deepEqual(s.events, []);
        assert.deepEqual(s.checkpoint(), {});
        assert.deepEqual(s.f.state.calls, []);
        assert.equal(s.f.state.uploads, 0);
        assert.equal(s.f.state.signs, 0);
        assert.equal(s.f.state.sends, 0);
    });
}

test('default worker cannot prepare, sign, or broadcast when IPFS publication fails', async t => {
    const s = await defaultWorker(t);
    s.f.state.ipfsFailure = true;
    await assert.rejects(s.run());
    assert.deepEqual(s.events, ['ipfs:start']);
    assert.deepEqual(s.checkpoint(), {});
    assert.deepEqual(s.f.state.calls, []);
    assert.equal(s.f.state.uploads, 1);
    assert.equal(s.f.state.signs, 0);
    assert.equal(s.f.state.sends, 0);
});

for (const kind of ['cid', 'transaction']) {
    test(`default worker stops at an unacknowledged ${kind} checkpoint without broadcast`, async t => {
        const s = await defaultWorker(t);
        s.state.rejectCheckpoint = kind;
        await assert.rejects(s.run(), /checkpoint acknowledgement failed/);
        assert.equal(s.f.state.uploads, 1);
        assert.equal(s.f.state.signs, kind === 'cid' ? 0 : 1);
        assert.equal(s.f.state.sends, 0);
        assert.deepEqual(s.checkpoint(), kind === 'cid' ? {} : { cid });
        if (kind === 'cid') assert.deepEqual(s.f.state.calls, []);
        assert.equal(s.f.state.calls.includes('eth_getTransactionReceipt'), false);
    });
}

for (const [name, change] of [
    ['wrong chain', f => { f.state.chainId = '0x7a69'; }],
    ['absent Ledger bytecode', f => { f.state.code = '0x'; }],
]) {
    test(`default worker rejects ${name} before transaction signing`, async t => {
        const s = await defaultWorker(t);
        change(s.f);
        await assert.rejects(s.run(), /Ledger configuration mismatch/);
        assert.deepEqual(s.checkpoint(), { cid });
        assert.equal(s.f.state.uploads, 1);
        assert.equal(s.f.state.signs, 0);
        assert.equal(s.f.state.sends, 0);
    });
}

for (const [name, mutate] of [
    ['receipt destination', receipt => { receipt.to = otherLedger; }],
    ['event contract', receipt => { receipt.logs[0].address = otherLedger; }],
]) {
    test(`default worker rejects the wrong ${name}, then resumes the same saved transaction`, async t => {
        const s = await defaultWorker(t);
        s.state.mutateReceipt = mutate;
        await assert.rejects(s.run());
        const checkpoint = s.checkpoint();
        assert.ok(checkpoint.transaction);
        delete s.state.mutateReceipt;
        assert.deepEqual(await s.run(), { status: 'logged', cid, transactionHash: checkpoint.transaction.transactionHash });
        assert.deepEqual(s.checkpoint(), checkpoint);
        assert.equal(s.checkpoints.length, 2);
        assert.equal(s.f.state.uploads, 1);
        assert.equal(s.f.state.signs, 1);
        assert.equal(s.f.state.sends, 1);
    });
}

test('explicit IPFS worker publishes with no node signer and no Ethereum transport', async () => {
    const config = parse(nodeInput({ mode: 'ipfs' }));
    const job = await signJob(agent, target, 'explicit IPFS opt-out');
    const checkpoints = [], uploads = [];
    const result = await processWork({ config, target, allowedSigners: [agent.address], signer: undefined,
        work: { requestId: job.requestId, job, checkpoint: {} }, save: async change => { checkpoints.push(change); },
        fetch: async (url, request) => {
            assert.ok(url.startsWith(`${config.ipfs.url}/api/v0/add?`), 'IPFS opt-out must not call Ethereum');
            uploads.push(await request.body.get('file').text());
            return Response.json({ Hash: cid });
        } });
    assert.deepEqual(result, { status: 'published', cid });
    assert.deepEqual(uploads, [JSON.stringify(job.message)]);
    assert.deepEqual(checkpoints, [{ cid }]);
});
