import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import {
    logCid, LogCidError, EthereumTransactionReceiptTimeoutError,
    ethWaitForTransactionReceipt, decodeLoggerEvent,
} from '@oyaprotocol/ethereum';
import {
    fixtures, sample, loggerContract, node, transactionHash, rawTransaction,
    createLog, createReceipt, response, createOptions,
} from './fixtures/logger-transaction.js';

test('logCid prepares once, submits, waits, and verifies the expected Logger event', async () => {
    const stages = [];
    let polls = 0;
    const result = await logCid(sample.cid, createOptions({
        loggerContract: `0x${loggerContract.slice(2).toUpperCase()}`,
        nodeAddress: `0x${node.slice(2).toUpperCase()}`,
        transactionPreparer: (request) => {
            stages.push('prepare');
            assert.equal(Object.isFrozen(request), true);
            assert.deepEqual(request, {
                to: `0x${loggerContract.slice(2).toUpperCase()}`, data: sample.calldata, value: 0n,
            });
            return { rawTransaction, transactionHash };
        },
        fetch: async (_url, request) => {
            const { method, params } = JSON.parse(request.body);
            stages.push(method);
            if (method === 'eth_sendRawTransaction') {
                assert.deepEqual(params, [rawTransaction]);
                return response(`0x${transactionHash.slice(2).toUpperCase()}`);
            }
            assert.deepEqual(params, [transactionHash]);
            if (++polls === 1) return response(null);
            // A wallet can route the call; the event node is not inferred from receipt.from/to.
            return response(createReceipt({ from: loggerContract, to: node, logs: [
                createLog({ address: node, topics: [], data: '0x' }), createLog(),
            ] }));
        },
    }));
    assert.deepEqual(stages, ['prepare', 'eth_sendRawTransaction', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt']);
    assert.equal(result.cid, sample.cid);
    assert.equal(result.transactionHash, transactionHash);
    assert.equal(result.receipt.blockNumber, 16n);
    assert.equal(result.receipt.status, 'success');
    assert.deepEqual(result.event, { node, cid: sample.cid, cidKeccak256Hash: sample.cidKeccak256Hash, removed: false });
});

test('logCid forwards custom string and numeric IDs through submission and every receipt poll', async () => {
    for (const id of ['message-42', 0, 73, undefined]) {
        const ids = [];
        let polls = 0;
        const result = await logCid(sample.cid, createOptions({
            ...(id === undefined ? {} : { id }),
            fetch: async (_url, request) => {
                const body = JSON.parse(request.body);
                ids.push(body.id);
                if (body.method === 'eth_sendRawTransaction') return response(transactionHash, body.id);
                return response(++polls === 1 ? null : createReceipt(), body.id);
            },
        }));
        assert.deepEqual(ids, [id ?? 1, id ?? 1, id ?? 1]);
        assert.equal(result.transactionHash, transactionHash);
    }
});

test('logCid validates configuration before preparing or broadcasting a transaction', async () => {
    let calls = 0;
    for (const overrides of [
        { loggerContract: 'invalid' }, { nodeAddress: 'invalid' },
        { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { pollIntervalMs: 0 },
        { pollIntervalMs: 2_147_483_648 }, { config: {} }, { fetch: undefined },
        { transactionPreparer: undefined },
        ...[null, '', ' ', true, {}, [], 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
            .map((id) => ({ id })),
    ]) {
        await assert.rejects(logCid(sample.cid, createOptions({
            transactionPreparer: () => { calls++; throw new Error('Unexpected preparation'); },
            fetch: async () => { calls++; throw new Error('Unexpected fetch'); }, ...overrides,
        })));
    }
    await assert.rejects(logCid('bafy-invalid', createOptions({
        transactionPreparer: () => { calls++; },
    })), /canonical CIDv1/);
    assert.equal(calls, 0);
});

test('logCid preserves preparation failures and rejects malformed signer results before broadcast', async () => {
    const failure = new Error('Signer unavailable');
    const prepareCallbacks = [
        () => { throw failure; }, async () => { throw failure; },
        () => null, () => rawTransaction, () => ({ rawTransaction }),
        () => ({ rawTransaction: '0x', transactionHash }),
        () => ({ rawTransaction, transactionHash: '0x12' }),
    ];
    for (const transactionPreparer of prepareCallbacks) {
        let calls = 0;
        await assert.rejects(logCid(sample.cid, createOptions({
            transactionPreparer, fetch: async () => { calls++; },
        })), (error) => {
            assert.ok(error instanceof LogCidError);
            assert.equal(error.stage, 'prepare');
            assert.equal(error.cid, sample.cid);
            assert.equal(error.receipt, null);
            assert.ok(error.cause instanceof Error);
            if (transactionPreparer === prepareCallbacks[0]) assert.equal(error.cause, failure);
            return true;
        });
        assert.equal(calls, 0);
    }
});

test('logCid reuses signed bytes and the known hash through submission retry recovery', async () => {
    const prepared = { rawTransaction, transactionHash };
    const sends = [];
    let preparations = 0;
    const options = createOptions({
        id: 'submission-recovery',
        transactionPreparer: () => { preparations++; return prepared; },
        fetch: async (_url, request) => {
            const { method, params, id } = JSON.parse(request.body);
            assert.equal(id, 'submission-recovery');
            if (method === 'eth_sendRawTransaction') {
                sends.push(params[0]);
                prepared.rawTransaction = '0xff';
                prepared.transactionHash = `0x${'ff'.repeat(32)}`;
                if (sends.length === 1) return { ok: false, status: 503, statusText: 'Unavailable', text: async () => '' };
                return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
                    jsonrpc: '2.0', id, error: { code: -32000, message: 'already known' },
                }) };
            }
            assert.deepEqual(params, [transactionHash]);
            return response(method === 'eth_getTransactionByHash' ? { hash: transactionHash } : createReceipt(), id);
        },
    });
    options.config = { ...options.config, maxRetries: 1 };
    const result = await logCid(sample.cid, options);
    assert.equal(preparations, 1);
    assert.deepEqual(sends, [rawTransaction, rawTransaction]);
    assert.equal(result.transactionHash, transactionHash);
});

test('logCid retains transaction identity on ambiguous or invalid submission responses', async () => {
    for (const fetch of [
        async () => { throw new Error('Connection closed'); },
        async () => response(`0x${'ff'.repeat(32)}`),
    ]) {
        await assert.rejects(logCid(sample.cid, createOptions({ fetch })), (error) => {
            assert.ok(error instanceof LogCidError);
            assert.equal(error.stage, 'submit');
            assert.equal(error.transactionHash, transactionHash);
            assert.equal(error.receipt, null);
            return true;
        });
    }
});

test('logCid rejects unsuccessful receipts and absent, removed, or incorrect Logger events', async () => {
    const other = fixtures.cases[0];
    const receipts = [
        createReceipt({ status: '0x0' }),
        createReceipt({ status: undefined, root: `0x${'00'.repeat(32)}` }),
        createReceipt({ logs: [] }),
        createReceipt({ logs: [createLog({ removed: true })] }),
        createReceipt({ logs: [createLog({ address: node })] }),
        createReceipt({ logs: [createLog({ topics: [`0x${'11'.repeat(32)}`] })] }),
        createReceipt({ logs: [createLog({ topics: [fixtures.topics[0], `0x${'00'.repeat(32)}`, sample.cidKeccak256Hash] })] }),
        createReceipt({ logs: [createLog({ data: other.data, topics: [...fixtures.topics, other.cidKeccak256Hash] })] }),
        createReceipt({ logs: [createLog({ topics: [...fixtures.topics, other.cidKeccak256Hash] })] }),
        createReceipt({ logs: [createLog({ data: '0x' })] }),
    ];
    for (const receipt of receipts) {
        await assert.rejects(logCid(sample.cid, createOptions({
            fetch: async (_url, request) => response(
                JSON.parse(request.body).method === 'eth_sendRawTransaction' ? transactionHash : receipt
            ),
        })), (error) => {
            assert.ok(error instanceof LogCidError);
            assert.equal(error.stage, 'verify');
            assert.equal(error.transactionHash, transactionHash);
            assert.equal(error.receipt.transactionHash, transactionHash);
            return true;
        });
    }
});

test('logCid preserves the hash on malformed receipts', async () => {
    await assert.rejects(logCid(sample.cid, createOptions({
        fetch: async (_url, request) => response(
            JSON.parse(request.body).method === 'eth_sendRawTransaction' ? transactionHash : { status: '0x1' }
        ),
    })), (error) => error instanceof LogCidError && error.stage === 'receipt' &&
        error.transactionHash === transactionHash && error.receipt === null);
});

test('logCid receipt timeout retains the hash so observation can resume without another submission', async () => {
    let failure;
    await assert.rejects(logCid(sample.cid, createOptions({
        timeoutMs: 10,
        fetch: async (_url, request) => response(
            JSON.parse(request.body).method === 'eth_sendRawTransaction' ? transactionHash : null
        ),
    })), (error) => {
        failure = error;
        return error instanceof LogCidError && error.stage === 'receipt' &&
            error.cause instanceof EthereumTransactionReceiptTimeoutError;
    });
    const { config, timeoutMs, pollIntervalMs } = createOptions();
    const observed = await ethWaitForTransactionReceipt({
        config, timeoutMs, pollIntervalMs, transactionHash: failure.transactionHash,
        fetch: async (_url, request) => {
            assert.equal(JSON.parse(request.body).method, 'eth_getTransactionReceipt');
            return response(createReceipt());
        },
    });
    assert.equal(observed.receipt.status, 'success');
    assert.equal(decodeLoggerEvent(observed.receipt.logs[0], loggerContract).cid, failure.cid);
});

test('logCid aborts preparation without later broadcasting when the signer ignores cancellation', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const signed = Promise.withResolvers();
    let calls = 0;
    const promise = logCid(sample.cid, createOptions({
        signal: controller.signal,
        transactionPreparer: (request) => {
            assert.equal(request.signal, controller.signal);
            started.resolve();
            return signed.promise;
        },
        fetch: async () => { calls++; },
    }));
    await started.promise;
    const reason = new Error('Cancelled signing');
    controller.abort(reason);
    await assert.rejects(promise, (error) => error instanceof LogCidError &&
        error.stage === 'prepare' && error.transactionHash === null && error.cause === reason);
    signed.resolve({ rawTransaction, transactionHash });
    await nextTurn();
    assert.equal(calls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('logCid respects cancellation before preparation and during submission or receipt observation', async () => {
    for (const stage of ['prepare', 'submit', 'receipt']) {
        const controller = new AbortController();
        if (stage === 'prepare') controller.abort(new Error('Already cancelled'));
        let preparations = 0;
        let sends = 0;
        await assert.rejects(logCid(sample.cid, createOptions({
            signal: controller.signal,
            transactionPreparer: () => { preparations++; return { rawTransaction, transactionHash }; },
            fetch: async (_url, request) => {
                const { method } = JSON.parse(request.body);
                if (method === 'eth_sendRawTransaction') sends++;
                if (stage === 'submit' || method === 'eth_getTransactionReceipt') {
                    controller.abort(new Error('Cancelled request'));
                    return await new Promise(() => {});
                }
                return response(transactionHash);
            },
        })), (error) => error instanceof LogCidError && error.stage === stage &&
            error.transactionHash === (stage === 'prepare' ? null : transactionHash));
        assert.equal(preparations, stage === 'prepare' ? 0 : 1);
        assert.equal(sends, stage === 'prepare' ? 0 : 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
});
