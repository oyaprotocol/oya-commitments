import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { createHttpConfig, createTransactionPreparer, EthereumJsonRpcError, logCid } from '@oyaprotocol/ethereum';
import { sample, loggerContract, node, createReceipt, response } from './fixtures/logger-transaction.js';

// Opaque test bytes, not a real signature. Hash independently checked with cast keccak 0x02abcd.
const rawTransaction = '0x02abcd';
const transactionHash = '0xe3607eedbe2ea88ad1994e3ef901f3c7ed167a59ebb5ffe5e40321e468f49eb1';
const signed = { rawTransaction, transactionHash };
const request = { to: loggerContract, data: '0x1234', value: 7n };

function fixture(overrides = {}) {
    const calls = [];
    const signatures = [];
    const results = {
        eth_chainId: '0x1',
        eth_getTransactionCount: '0x3',
        eth_getBlockByNumber: { baseFeePerGas: '0x64', gasLimit: '0x1c9c380' },
        eth_maxPriorityFeePerGas: '0x2',
        eth_estimateGas: '0x5209', // 21,001; the margin must round up.
    };
    const options = {
        config: createHttpConfig({
            url: 'https://rpc.example', headers: {}, timeoutMs: 1_000, maxRetries: 0, retryDelayMs: 0,
        }),
        fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            calls.push(body);
            assert.ok(body.method in results, `Unexpected RPC method ${body.method}`);
            return response(results[body.method], body.id);
        },
        chainId: 1n,
        signer: {
            address: node,
            signTransaction(transaction, signal) {
                assert.equal(this.address, node);
                signatures.push({ transaction, signal });
                return signed;
            },
        },
        ...overrides,
    };
    return { options, results, calls, signatures };
}

test('the factory creates a frozen EIP-1559 transaction with current RPC values and no broadcast', async () => {
    const { options, calls, signatures } = fixture();
    const prepare = createTransactionPreparer(options);
    assert.equal(calls.length, 0);
    const result = await prepare(request);
    assert.deepEqual(result, signed);
    assert.ok(Object.isFrozen(result));
    assert.equal(signatures.length, 1);
    assert.ok(Object.isFrozen(signatures[0].transaction));
    assert.equal('signal' in signatures[0].transaction, false);
    assert.deepEqual(signatures[0].transaction, {
        ...request, type: 2, chainId: 1n, nonce: 3,
        gasLimit: 25_202n, maxFeePerGas: 202n, maxPriorityFeePerGas: 2n,
    });
    assert.deepEqual(calls.map(({ method, params, id }) => ({ method, params, id })), [
        { method: 'eth_chainId', params: [], id: 1 },
        { method: 'eth_getTransactionCount', params: [node, 'pending'], id: 1 },
        { method: 'eth_getBlockByNumber', params: ['latest', false], id: 1 },
        { method: 'eth_maxPriorityFeePerGas', params: [], id: 1 },
        { method: 'eth_estimateGas', params: [{
            from: node, to: request.to, data: request.data, value: '0x7',
            type: '0x2', chainId: '0x1', nonce: '0x3',
            maxFeePerGas: '0xca', maxPriorityFeePerGas: '0x2',
        }, 'pending'], id: 1 },
    ]);
});

test('policies support exact ceilings, zero fees, empty calldata, large chain IDs, and fresh nonces', async () => {
    const { options, results, calls, signatures } = fixture({
        chainId: 9_007_199_254_740_993n, id: 'prepare-42', gasLimitMarginPercent: 0, baseFeeMultiplier: 3,
        limits: { gasLimit: 21_001n, feePerGas: 302n },
    });
    results.eth_chainId = '0x20000000000001';
    const prepare = createTransactionPreparer(options);
    await prepare({ ...request, data: '0x', value: 0n });
    assert.equal(signatures[0].transaction.maxFeePerGas, 302n);
    assert.equal(signatures[0].transaction.gasLimit, 21_001n);
    results.eth_getTransactionCount = '0x4';
    results.eth_getBlockByNumber.baseFeePerGas = '0x0';
    results.eth_maxPriorityFeePerGas = '0x0';
    await prepare(request);
    assert.equal(signatures[1].transaction.nonce, 4);
    assert.equal(signatures[1].transaction.maxFeePerGas, 0n);
    assert.ok(calls.every(({ id }) => id === 'prepare-42'));
    results.eth_chainId = '0x2';
    await assert.rejects(prepare(request), /did not match configured chainId/);
    assert.equal(signatures.length, 2);
});

test('invalid factory configuration is rejected before RPC or signing', () => {
    const invalid = [
        { chainId: 1 }, { chainId: 0n }, { chainId: -1n }, { chainId: 1n << 256n },
        { signer: null }, { signer: { address: node } },
        { signer: { address: '0x1234', signTransaction() {} } }, { fetch: null },
        { id: '' }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 },
        { gasLimitMarginPercent: -1 }, { gasLimitMarginPercent: 0.5 }, { gasLimitMarginPercent: Infinity },
        { baseFeeMultiplier: 0 }, { baseFeeMultiplier: 1.5 },
        { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 },
        { limits: null }, { limits: [] }, { limits: { gasLimit: 0n } },
        { limits: { gasLimit: 1 } }, { limits: { feePerGas: -1n } },
        { limits: { feePerGas: 1n << 256n } },
    ];
    for (const overrides of invalid) {
        const { options, calls, signatures } = fixture(overrides);
        assert.throws(() => createTransactionPreparer(options));
        assert.equal(calls.length, 0);
        assert.equal(signatures.length, 0);
    }
});

test('invalid call intent is rejected before RPC or signing', async () => {
    const { options, calls, signatures } = fixture();
    const prepare = createTransactionPreparer(options);
    for (const changes of [
        { to: '0x' }, { to: ` ${node}` }, { data: '0x1' }, { data: '0xgg' },
        { value: 0 }, { value: -1n }, { value: 1n << 256n },
    ]) {
        await assert.rejects(prepare({ ...request, ...changes }));
    }
    assert.equal(calls.length, 0);
    assert.equal(signatures.length, 0);
});

test('malformed RPC results, unsupported fees, and unsafe quantities never reach the signer', async () => {
    const cases = [
        ['eth_chainId', '0x2', /did not match configured chainId/],
        ['eth_chainId', '0x01', /without leading zeros/],
        ['eth_getTransactionCount', '0x20000000000000', /safe integer/],
        ['eth_getTransactionCount', '-0x1', /quantity/],
        ['eth_getBlockByNumber', null, /baseFeePerGas/],
        ['eth_getBlockByNumber', { gasLimit: '0x5208' }, /baseFeePerGas/],
        ['eth_getBlockByNumber', { baseFeePerGas: '0x1', gasLimit: '0x0' }, /gasLimit/],
        ['eth_getBlockByNumber', { baseFeePerGas: '0x01', gasLimit: '0x5208' }, /quantity/],
        ['eth_maxPriorityFeePerGas', '0x00', /quantity/],
        ['eth_maxPriorityFeePerGas', '0x' + 'f'.repeat(65), /256 bits/],
        ['eth_maxPriorityFeePerGas', '0x' + 'f'.repeat(64), /maxFeePerGas/],
        ['eth_estimateGas', '0x', /quantity/],
        ['eth_estimateGas', 21_000, /quantity/],
        ['eth_estimateGas', '0x0', /positive/],
    ];
    for (const [method, result, expected] of cases) {
        const { options, results, signatures } = fixture();
        results[method] = result;
        await assert.rejects(createTransactionPreparer(options)(request), expected);
        assert.equal(signatures.length, 0);
    }
});

test('gas and fee ceilings reject before signing instead of reducing the selected values', async () => {
    for (const [limits, expected] of [
        [{ gasLimit: 25_201n }, /limits.gasLimit/],
        [{ feePerGas: 201n }, /limits.feePerGas/],
    ]) {
        const { options, signatures } = fixture({ limits });
        await assert.rejects(createTransactionPreparer(options)(request), expected);
        assert.equal(signatures.length, 0);
    }
    const { options, results, signatures } = fixture();
    results.eth_getBlockByNumber.gasLimit = '0x5209';
    await assert.rejects(createTransactionPreparer(options)(request), /block gas limit/);
    assert.equal(signatures.length, 0);
});

test('RPC transport retries are reused but execution reverts and signer failures are not retried', async () => {
    const { options, signatures } = fixture();
    options.config = { ...options.config, maxRetries: 1 };
    const fetch = options.fetch;
    let attempts = 0;
    options.fetch = async (...args) => {
        if (++attempts === 1) return { ok: false, status: 503, statusText: 'Unavailable', text: async () => '' };
        return fetch(...args);
    };
    await createTransactionPreparer(options)(request);
    assert.equal(attempts, 6);
    assert.equal(signatures.length, 1);

    const failed = fixture();
    failed.options.config = { ...failed.options.config, maxRetries: 2 };
    const normalFetch = failed.options.fetch;
    let estimates = 0;
    failed.options.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.method !== 'eth_estimateGas') return normalFetch(url, init);
        estimates++;
        return { ok: true, text: async () => JSON.stringify({
            jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted' },
        }) };
    };
    await assert.rejects(createTransactionPreparer(failed.options)(request), EthereumJsonRpcError);
    assert.equal(estimates, 1);
    assert.equal(failed.signatures.length, 0);

    let signingAttempts = 0;
    const cause = new Error('Signer unavailable');
    options.signer.signTransaction = async () => { signingAttempts++; throw cause; };
    await assert.rejects(createTransactionPreparer(options)(request), (error) => error === cause);
    assert.equal(signingAttempts, 1);
});

test('configuration and call fields are snapshotted before asynchronous work', async () => {
    const { options, signatures } = fixture({ limits: { gasLimit: 30_000n, feePerGas: 300n } });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const fetch = options.fetch;
    options.config = { ...options.config, headers: { Authorization: 'original' } };
    options.fetch = async (url, init) => {
        assert.equal(url, 'https://rpc.example');
        assert.equal(init.headers.Authorization, 'original');
        started.resolve();
        await release.promise;
        return fetch(url, init);
    };
    const prepare = createTransactionPreparer(options);
    options.config.url = 'https://changed.example';
    options.config.headers.Authorization = 'changed';
    options.limits.gasLimit = 1n;
    options.limits.feePerGas = 1n;
    options.signer.signTransaction = () => { throw new Error('Replaced signer'); };
    options.fetch = () => { throw new Error('Replaced transport'); };
    const mutableRequest = { ...request };
    const promise = prepare(mutableRequest);
    await started.promise;
    mutableRequest.to = node;
    mutableRequest.data = '0x';
    mutableRequest.value = 99n;
    release.resolve();
    await promise;
    assert.equal(signatures[0].transaction.to, request.to);
    assert.equal(signatures[0].transaction.data, request.data);
    assert.equal(signatures[0].transaction.value, request.value);
});

test('pre-aborted requests perform no RPC or signing', async () => {
    const { options, calls, signatures } = fixture();
    await assert.rejects(createTransactionPreparer(options)({
        ...request, signal: AbortSignal.abort('Cancelled'),
    }), /aborted/);
    assert.equal(calls.length, 0);
    assert.equal(signatures.length, 0);
});

test('cancellation during an uncooperative RPC prevents later signing', async () => {
    const { options, signatures } = fixture();
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    options.fetch = async () => { calls++; started.resolve(); await release.promise; return response('0x1'); };
    const promise = createTransactionPreparer(options)({ ...request, signal: controller.signal });
    await started.promise;
    controller.abort('Cancelled');
    await assert.rejects(promise, /aborted/);
    release.resolve();
    await nextTurn();
    assert.equal(calls, 1);
    assert.equal(signatures.length, 0);
});

for (const cancel of ['caller', 'deadline']) {
    test(`${cancel} cancellation bounds an uncooperative signer and ignores its late result`, async () => {
        const { options } = fixture({ timeoutMs: cancel === 'deadline' ? 30 : 1_000 });
        const controller = new AbortController();
        const started = Promise.withResolvers();
        const release = Promise.withResolvers();
        let signingSignal;
        let attempts = 0;
        options.signer.signTransaction = async (_transaction, signal) => {
            attempts++;
            signingSignal = signal;
            started.resolve();
            return await release.promise;
        };
        const promise = createTransactionPreparer(options)({ ...request, signal: controller.signal });
        await started.promise;
        if (cancel === 'caller') controller.abort('Cancelled');
        await assert.rejects(promise, /aborted|timed out/);
        assert.equal(signingSignal.aborted, true);
        release.resolve(signed);
        await nextTurn();
        assert.equal(attempts, 1);
    });
}

test('signed results must have type-2 bytes and a matching hash', async () => {
    for (const output of [
        null, {}, { ...signed, rawTransaction: '0x' }, { ...signed, rawTransaction: '0x02' },
        { ...signed, rawTransaction: '0x02abc' }, { ...signed, rawTransaction: '0x01abcd' },
        { ...signed, transactionHash: '0x1234' }, { ...signed, transactionHash: '0x' + 'ff'.repeat(32) },
    ]) {
        const { options } = fixture();
        options.signer.signTransaction = () => output;
        await assert.rejects(createTransactionPreparer(options)(request));
    }
    const { options } = fixture();
    const output = { rawTransaction: '0x02ABCD', transactionHash: '0x' + transactionHash.slice(2).toUpperCase() };
    options.signer.signTransaction = async () => output;
    const result = await createTransactionPreparer(options)(request);
    output.rawTransaction = '0x02';
    assert.equal(result.rawTransaction, '0x02ABCD');
});

test('the default preparer composes with Logger submission and event verification', async () => {
    const { options, signatures, calls } = fixture();
    const prepare = createTransactionPreparer(options);
    const loggingCalls = [];
    const result = await logCid(sample.cid, {
        config: options.config, loggerContract, nodeAddress: node, transactionPreparer: prepare,
        timeoutMs: 1_000, pollIntervalMs: 1,
        fetch: async (_url, init) => {
            assert.equal(signatures.length, 1);
            const body = JSON.parse(init.body);
            loggingCalls.push(body.method);
            if (body.method === 'eth_sendRawTransaction') {
                assert.deepEqual(body.params, [rawTransaction]);
                return response(transactionHash);
            }
            const receipt = createReceipt();
            return response({ ...receipt, transactionHash, logs: receipt.logs.map(log => ({ ...log, transactionHash })) });
        },
    });
    assert.equal(signatures[0].transaction.data, sample.calldata);
    assert.equal(signatures[0].transaction.value, 0n);
    assert.equal(signatures[0].transaction.to, loggerContract);
    assert.equal(result.transactionHash, transactionHash);
    assert.equal(result.event.node, node);
    assert.equal(calls.length, 5);
    assert.deepEqual(loggingCalls, ['eth_sendRawTransaction', 'eth_getTransactionReceipt']);
});
