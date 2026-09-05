import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import {
    createHttpConfig,
    EthereumJsonRpcError,
    EthereumTransactionReceiptTimeoutError,
    HttpStatusError,
    ethGetTransactionReceipt,
    ethWaitForTransactionReceipt,
} from '../dist/index.js';

const transactionHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const address = `0x${'ef'.repeat(20)}`;

function createConfig(overrides = {}) {
    return createHttpConfig({
        url: 'https://rpc.example/',
        headers: { Authorization: 'Bearer test-token' },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        ...overrides,
    });
}

function createLog(overrides = {}) {
    return {
        address,
        topics: [`0x${'01'.repeat(32)}`],
        data: '0x',
        transactionHash,
        blockHash,
        blockNumber: '0x20000000000001',
        transactionIndex: '0x2',
        logIndex: '0x3',
        removed: false,
        ...overrides,
    };
}

function createReceipt(overrides = {}) {
    return {
        transactionHash,
        transactionIndex: '0x2',
        blockHash,
        blockNumber: '0x20000000000001',
        from: address,
        to: address,
        contractAddress: null,
        cumulativeGasUsed: '0xffff',
        gasUsed: '0x5208',
        logs: [createLog()],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: '0x2',
        effectiveGasPrice: '0x123456789abcdef',
        ...overrides,
    };
}

function response(result, id = 1) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() { return JSON.stringify({ jsonrpc: '2.0', id, result }); },
    };
}

function httpFailure(status = 503) {
    return { ok: false, status, statusText: 'Unavailable', async text() { return ''; } };
}

function waitOptions(overrides = {}) {
    return {
        config: createConfig(),
        fetch: async () => response(createReceipt()),
        transactionHash,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        ...overrides,
    };
}

test('receipt lookup sends the requested hash and returns null without retrying pending state', async () => {
    const calls = [];
    const result = await ethGetTransactionReceipt({
        config: createConfig({ maxRetries: 4 }),
        transactionHash,
        id: 'receipt-1',
        fetch: async (url, options) => {
            calls.push({ url, options });
            return response(null, 'receipt-1');
        },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rpc.example');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        jsonrpc: '2.0', id: 'receipt-1', method: 'eth_getTransactionReceipt', params: [transactionHash],
    });
    assert.deepEqual(result, {
        receipt: null, attemptCount: 1, response: { jsonrpc: '2.0', id: 'receipt-1', result: null },
    });
});

test('receipt lookup normalizes successful receipt and log quantities without losing precision', async () => {
    const upperHash = `0x${'AB'.repeat(32)}`;
    const raw = createReceipt({ transactionHash: upperHash, providerField: { extra: true } });
    const { receipt, attemptCount, response: envelope } = await ethGetTransactionReceipt({
        config: createConfig(), transactionHash, fetch: async () => response(raw),
    });
    assert.equal(attemptCount, 1);
    assert.deepEqual(receipt, {
        transactionHash: upperHash, transactionIndex: 2n, blockHash,
        blockNumber: 9_007_199_254_740_993n, from: address, to: address, contractAddress: null,
        cumulativeGasUsed: 65_535n, gasUsed: 21_000n, logsBloom: raw.logsBloom,
        status: 'success', type: 2n, effectiveGasPrice: 0x123456789abcdefn,
        logs: [{
            address, topics: raw.logs[0].topics, data: '0x', transactionHash,
            blockHash, blockNumber: 9_007_199_254_740_993n,
            transactionIndex: 2n, logIndex: 3n, removed: false,
        }],
    });
    assert.deepEqual(envelope.result, raw);
    assert.equal('providerField' in receipt, false);
    envelope.result.logs[0].topics.push('bad');
    assert.equal(receipt.logs[0].topics.length, 1);
});

test('receipt lookup supports reverts, contract creation, optional blob fields, and historical roots', async () => {
    for (const status of ['0x0', '0x1']) {
        const { receipt } = await ethGetTransactionReceipt({
            config: createConfig(), transactionHash,
            fetch: async () => response(createReceipt({
                status, to: null, contractAddress: address, type: '0x3',
                blobGasUsed: '0x20000', blobGasPrice: '0x3',
                logs: [createLog({ removed: undefined, blockTimestamp: '0x123' })],
            })),
        });
        assert.equal(receipt.status, status === '0x1' ? 'success' : 'reverted');
        assert.equal(receipt.to, null);
        assert.equal(receipt.contractAddress, address);
        assert.equal(receipt.blobGasUsed, 131_072n);
        assert.equal(receipt.blobGasPrice, 3n);
        assert.equal(receipt.logs[0].blockTimestamp, 291n);
        assert.equal('removed' in receipt.logs[0], false);
    }
    const { receipt } = await ethGetTransactionReceipt({
        config: createConfig(), transactionHash,
        fetch: async () => response(createReceipt({
            status: undefined, root: blockHash, type: undefined, effectiveGasPrice: undefined, logs: [],
        })),
    });
    assert.equal(receipt.status, null);
    assert.equal(receipt.root, blockHash);
    assert.equal('type' in receipt, false);
    assert.equal('effectiveGasPrice' in receipt, false);
});

test('receipt lookup retries transient HTTP failures using the existing RPC policy', async () => {
    let attempts = 0;
    const result = await ethGetTransactionReceipt({
        config: createConfig(), transactionHash,
        fetch: async () => ++attempts === 1 ? httpFailure() : response(createReceipt()),
    });
    assert.equal(attempts, 2);
    assert.equal(result.attemptCount, 2);
    assert.equal(result.receipt.status, 'success');
});

test('receipt lookup rejects malformed receipts and logs without another HTTP request', async () => {
    const cases = [
        [false, /receipt object/], [[], /receipt object/], [{}, /transactionHash/],
        [createReceipt({ transactionHash: blockHash }), /transactionHash.*match/],
        ...[
            ['transactionHash', '0x01'], ['blockHash', null], ['blockNumber', null],
            ['blockNumber', '0x01'], ['blockNumber', '0X1'], ['blockNumber', 12],
            ['transactionIndex', '0x'], ['gasUsed', '-0x1'], ['cumulativeGasUsed', '0xgg'],
            ['from', '0x'], ['to', undefined], ['contractAddress', false],
            ['logsBloom', '0x'], ['logs', null], ['status', '0x2'], ['status', '0x01'],
            ['status', true], ['status', null], ['status', undefined], ['root', '0x'],
            ['effectiveGasPrice', null], ['type', '0x00'], ['type', '0x100'], ['blobGasUsed', '0x-1'],
            ['blobGasPrice', ' 0x1'],
        ].map(([field, value]) => [createReceipt({ [field]: value }), new RegExp(`receipt.${field}`)]),
        [createReceipt({ logs: [null] }), /logs\[0\]/],
        ...[
            ['address', '0x12'], ['topics', null], ['topics', ['0x12']],
            ['topics', Array(5).fill(transactionHash)],
            ['data', '0x1'], ['data', ' 0x12'], ['blockHash', transactionHash],
            ['blockNumber', '0x2'], ['transactionHash', blockHash], ['transactionIndex', '0x1'],
            ['logIndex', null], ['removed', 0], ['blockTimestamp', '0x00'],
        ].map(([field, value]) => [createReceipt({ logs: [createLog({ [field]: value })] }), /receipt.logs\[0\]/]),
    ];
    for (const [raw, message] of cases) {
        let calls = 0;
        await assert.rejects(ethGetTransactionReceipt({
            config: createConfig(), transactionHash,
            fetch: async () => { calls += 1; return response(raw); },
        }), message);
        assert.equal(calls, 1);
    }
});

test('receipt lookup and wait reject invalid hashes before invoking fetch', async () => {
    for (const transactionHash of ['', '0x', '0x1234', 42, null]) {
        let calls = 0;
        const options = waitOptions({ transactionHash, fetch: async () => { calls += 1; } });
        await assert.rejects(ethGetTransactionReceipt(options), /transactionHash/);
        await assert.rejects(ethWaitForTransactionReceipt(options), /transactionHash/);
        assert.equal(calls, 0);
    }
});

test('receipt waiting requires explicit positive poll and deadline durations within timer limits', async () => {
    for (const field of ['timeoutMs', 'pollIntervalMs']) {
        for (const value of [undefined, null, 0, -1, 0.5, '10', NaN, Infinity, 2_147_483_648]) {
            let calls = 0;
            await assert.rejects(ethWaitForTransactionReceipt(waitOptions({
                [field]: value, fetch: async () => { calls += 1; },
            })), new RegExp(field));
            assert.equal(calls, 0);
        }
    }
});

test('receipt waiting immediately returns mined success or revert without extra polls', async () => {
    for (const status of ['0x1', '0x0']) {
        let calls = 0;
        const result = await ethWaitForTransactionReceipt(waitOptions({
            // Longer than the deadline: an unnecessary delay would fail this test.
            pollIntervalMs: 10_000,
            fetch: async () => { calls += 1; return response(createReceipt({ status })); },
        }));
        assert.equal(result.receipt.status, status === '0x1' ? 'success' : 'reverted');
        assert.equal(result.pollCount, 1);
        assert.equal(result.attemptCount, 1);
        assert.equal(calls, 1);
    }
});

test('receipt waiting counts pending polls separately from HTTP retries and returns the final response', async () => {
    let calls = 0;
    const raw = createReceipt();
    const result = await ethWaitForTransactionReceipt(waitOptions({
        id: 'wait-1',
        fetch: async (_url, options) => {
            assert.equal(JSON.parse(options.body).id, 'wait-1');
            calls += 1;
            if (calls === 2) return httpFailure();
            return response(calls < 5 ? null : raw, 'wait-1');
        },
    }));
    assert.equal(calls, 5);
    assert.equal(result.pollCount, 4);
    assert.equal(result.attemptCount, 5);
    assert.deepEqual(result.response, { jsonrpc: '2.0', id: 'wait-1', result: raw });
});

test('receipt waiting stops on semantic and exhausted transport failures', async () => {
    for (const mode of ['malformed', 'rpc', 'http']) {
        let calls = 0;
        await assert.rejects(ethWaitForTransactionReceipt(waitOptions({
            fetch: async () => {
                calls += 1;
                if (mode === 'http') return httpFailure();
                if (mode === 'malformed') return response(createReceipt({ status: '0x2' }));
                return {
                    ...response(null),
                    async text() {
                        return JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'receipt unavailable' } });
                    },
                };
            },
        })), (error) => {
            assert.equal(error instanceof EthereumTransactionReceiptTimeoutError, false);
            if (mode === 'rpc') assert.ok(error instanceof EthereumJsonRpcError);
            else if (mode === 'http') assert.ok(error instanceof HttpStatusError);
            else assert.match(error.message, /receipt.status/);
            return true;
        });
        assert.equal(calls, mode === 'http' ? 2 : 1);
    }
});

test('receipt lookup and wait honor a pre-aborted caller without invoking fetch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    let calls = 0;
    const options = waitOptions({ signal: controller.signal, fetch: async () => { calls += 1; } });
    await assert.rejects(ethGetTransactionReceipt(options), /aborted by the caller/);
    await assert.rejects(ethWaitForTransactionReceipt(options), (error) => {
        assert.match(error.message, /aborted by the caller/);
        assert.equal(error.cause, controller.signal.reason);
        return true;
    });
    assert.equal(calls, 0);
});

for (const phase of ['pending delay', 'fetch', 'body read', 'retry backoff']) {
    test(`receipt deadline interrupts ${phase} and aborts the transport signal`, { timeout: 2_000 }, async () => {
        let calls = 0;
        let transportSignal;
        const promise = ethWaitForTransactionReceipt(waitOptions({
            config: createConfig({ timeoutMs: 10_000, retryDelayMs: 10_000 }),
            timeoutMs: 20,
            pollIntervalMs: 10_000,
            fetch: async (_url, options) => {
                calls += 1;
                transportSignal = options.signal;
                if (phase === 'fetch') return new Promise(() => {});
                if (phase === 'body read') return { ...response(null), text: () => new Promise(() => {}) };
                if (phase === 'retry backoff') return httpFailure();
                return response(null);
            },
        }));
        await assert.rejects(promise, (error) => {
            assert.ok(error instanceof EthereumTransactionReceiptTimeoutError);
            assert.equal(error.transactionHash, transactionHash);
            assert.equal(error.timeoutMs, 20);
            assert.equal(error.pollCount, 1);
            return true;
        });
        assert.equal(calls, 1);
        assert.equal(transportSignal.aborted, true);
    });

    test(`caller cancellation interrupts receipt ${phase}`, { timeout: 2_000 }, async () => {
        const controller = new AbortController();
        let calls = 0;
        let transportSignal;
        const promise = ethWaitForTransactionReceipt(waitOptions({
            config: createConfig({ timeoutMs: 10_000, retryDelayMs: 10_000 }),
            timeoutMs: 10_000,
            pollIntervalMs: 10_000,
            signal: controller.signal,
            fetch: async (_url, options) => {
                calls += 1;
                transportSignal = options.signal;
                if (phase === 'fetch') return new Promise(() => {});
                if (phase === 'body read') return { ...response(null), text: () => new Promise(() => {}) };
                if (phase === 'retry backoff') return httpFailure();
                return response(null);
            },
        }));
        // Let the request finish or enter its pending body/backoff before aborting.
        await nextTurn();
        controller.abort(new Error('host stopped'));
        await assert.rejects(promise, (error) => {
            assert.equal(error instanceof EthereumTransactionReceiptTimeoutError, false);
            assert.match(error.message, /aborted by the caller/);
            assert.equal(error.cause, controller.signal.reason);
            return true;
        });
        assert.equal(calls, 1);
        assert.equal(transportSignal.aborted, true);
    });
}

test('receipt polling keeps one deadline across multiple successful pending lookups', { timeout: 2_000 }, async () => {
    let calls = 0;
    await assert.rejects(ethWaitForTransactionReceipt(waitOptions({
        timeoutMs: 40,
        pollIntervalMs: 1,
        fetch: async () => { calls += 1; return response(null); },
    })), (error) => {
        assert.ok(error instanceof EthereumTransactionReceiptTimeoutError);
        assert.equal(error.pollCount, calls);
        return true;
    });
    assert.ok(calls > 1);
});

test('receipt operations release timers and fallback caller listeners on every exit', async (context) => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    context.after(() => Object.defineProperty(AbortSignal, 'any', anyDescriptor));
    const timers = new Set();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        const timer = originalSetTimeout(() => {
            timers.delete(timer);
            callback(...args);
        }, delay);
        timers.add(timer);
        return timer;
    });
    context.mock.method(globalThis, 'clearTimeout', (timer) => {
        timers.delete(timer);
        return originalClearTimeout(timer);
    });
    for (const mode of ['success', 'invalid receipt', 'invalid config', 'invalid signal', 'timeout', 'cancel']) {
        const controller = new AbortController();
        const promise = ethWaitForTransactionReceipt(waitOptions({
            config: mode === 'invalid config' ? null : createConfig(),
            timeoutMs: mode === 'timeout' ? 10 : 10_000,
            pollIntervalMs: 10_000,
            signal: mode === 'invalid signal' ? {} : controller.signal,
            fetch: async () => response(mode === 'success' ? createReceipt() : mode === 'invalid receipt' ? {} : null),
        }));
        if (mode === 'cancel') {
            await nextTurn();
            controller.abort();
        }
        if (mode === 'success') await promise;
        else await assert.rejects(promise);
        await nextTurn();
        assert.equal(timers.size, 0, `${mode} leaked a timer`);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0, `${mode} leaked a listener`);
    }
});
