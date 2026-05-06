import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createHttpConfig,
    EthereumJsonRpcError,
    HttpStatusError,
    requestEthereumJsonRpc,
} from '../dist/index.js';

function createConfig(overrides = {}) {
    return createHttpConfig({
        url: 'https://rpc.example/',
        headers: {
            Authorization: 'Bearer test-token',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        ...overrides,
    });
}

function createTextResponse(status, body, statusText = 'OK') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        async text() {
            return body;
        },
    };
}

test('createHttpConfig is re-exported for Ethereum transport configuration', () => {
    const config = createHttpConfig({
        url: 'https://rpc.example/',
        headers: {
            Authorization: 'Bearer token',
        },
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 50,
    });

    assert.deepEqual(config, {
        url: 'https://rpc.example',
        headers: {
            Authorization: 'Bearer token',
        },
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 50,
    });
    assert.throws(() => {
        config.headers.Authorization = 'mutated';
    }, /read only|Cannot assign/);

    assert.throws(
        () =>
            createHttpConfig({
                url: '',
                headers: {},
                timeoutMs: 1_000,
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.url must be a non-empty string/
    );
    assert.throws(
        () =>
            createHttpConfig({
                url: 'https://rpc.example',
                headers: new Headers(),
                timeoutMs: 1_000,
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.headers must be a plain object/
    );
    assert.throws(
        () =>
            createHttpConfig({
                url: 'https://rpc.example',
                headers: {
                    'content-type': 'application/json',
                },
                timeoutMs: 1_000,
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.headers must not include content-type/
    );
    assert.throws(
        () =>
            createHttpConfig({
                url: 'https://rpc.example',
                headers: {},
                timeoutMs: '1000',
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.timeoutMs must be a positive integer/
    );
});

test('requestEthereumJsonRpc sends a JSON-RPC POST and returns normalized details', async () => {
    const calls = [];
    const result = await requestEthereumJsonRpc({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createTextResponse(
                200,
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    result: '0x1',
                })
            );
        },
        method: 'eth_chainId',
        params: [],
        id: 7,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rpc.example');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[0].options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        jsonrpc: '2.0',
        id: 7,
        method: 'eth_chainId',
        params: [],
    });
    assert.equal(result.result, '0x1');
    assert.equal(result.attemptCount, 1);
    assert.equal(result.id, 7);
    assert.deepEqual(result.response, {
        jsonrpc: '2.0',
        id: 7,
        result: '0x1',
    });
});

test('requestEthereumJsonRpc retries retryable HTTP failures and succeeds', async () => {
    let attempts = 0;
    const result = await requestEthereumJsonRpc({
        config: createConfig({ maxRetries: 2 }),
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                return createTextResponse(503, '{"error":"temporary outage"}', 'Service Unavailable');
            }
            return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
        },
        method: 'eth_blockNumber',
    });

    assert.equal(attempts, 2);
    assert.equal(result.result, '0x2');
    assert.equal(result.attemptCount, 2);
});

test('requestEthereumJsonRpc retries retryable network errors and succeeds', async () => {
    let attempts = 0;
    const result = await requestEthereumJsonRpc({
        config: createConfig({ maxRetries: 2 }),
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError('fetch failed', {
                    cause: Object.assign(new Error('connect ECONNRESET'), {
                        code: 'ECONNRESET',
                    }),
                });
            }
            return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x3"}');
        },
        method: 'eth_blockNumber',
    });

    assert.equal(attempts, 2);
    assert.equal(result.result, '0x3');
});

test('requestEthereumJsonRpc does not retry eth_sendRawTransaction submissions', async () => {
    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 2 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(503, '{"error":"temporary outage"}', 'Service Unavailable');
            },
            method: 'eth_sendRawTransaction',
            params: ['0x02f86c01'],
        }),
        (error) => {
            assert.ok(error instanceof HttpStatusError);
            assert.equal(error.status, 503);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc does not retry methods outside the retry allowlist', async () => {
    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(503, '{"error":"temporary outage"}', 'Service Unavailable');
            },
            method: 'evm_mine',
        }),
        (error) => {
            assert.ok(error instanceof HttpStatusError);
            assert.equal(error.status, 503);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc does not retry non-raw transaction submission methods', async () => {
    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                throw new TypeError('fetch failed', {
                    cause: Object.assign(new Error('connect ECONNRESET'), {
                        code: 'ECONNRESET',
                    }),
                });
            },
            method: 'eth_sendTransaction',
            params: [
                {
                    from: '0x0000000000000000000000000000000000000000',
                    to: '0x0000000000000000000000000000000000000000',
                },
            ],
        }),
        /fetch failed/
    );
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc does not retry non-retryable HTTP failures', async () => {
    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(400, '{"error":"bad request"}', 'Bad Request');
            },
            method: 'eth_call',
        }),
        (error) => {
            assert.ok(error instanceof HttpStatusError);
            assert.equal(error.status, 400);
            assert.match(error.message, /400 Bad Request/);
            return true;
        }
    );
    assert.equal(attempts, 1);

    attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(0, '', '');
            },
            method: 'eth_call',
        }),
        (error) => {
            assert.ok(error instanceof HttpStatusError);
            assert.equal(error.status, 0);
            assert.match(error.message, /0 Unknown Status/);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc does not retry JSON-RPC errors', async () => {
    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        error: {
                            code: -32000,
                            message: 'execution reverted',
                            data: '0x08c379a0',
                        },
                    })
                );
            },
            method: 'eth_call',
        }),
        (error) => {
            assert.ok(error instanceof EthereumJsonRpcError);
            assert.equal(error.code, -32000);
            assert.equal(error.data, '0x08c379a0');
            assert.equal(error.method, 'eth_call');
            assert.match(error.message, /execution reverted/);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc enforces timeout even when injected fetch ignores signal', async () => {
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ timeoutMs: 10, maxRetries: 0 }),
            fetch: async () => await new Promise(() => {}),
            method: 'eth_blockNumber',
        }),
        /timed out/
    );
});

test('requestEthereumJsonRpc does not call fetch when caller signal is already aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    controller.abort(new Error('stop before request'));

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
            },
            method: 'eth_chainId',
            signal: controller.signal,
        }),
        /requestEthereumJsonRpc was aborted by the caller/
    );

    assert.equal(attempts, 0);
});

test('requestEthereumJsonRpc aborts during retry backoff without making another attempt', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = requestEthereumJsonRpc({
        config: createConfig({ maxRetries: 2, retryDelayMs: 1_000 }),
        fetch: async () => {
            attempts += 1;
            return createTextResponse(503, '{"error":"temporary outage"}', 'Service Unavailable');
        },
        method: 'eth_blockNumber',
        signal: controller.signal,
    });

    setTimeout(() => controller.abort(new Error('stop retry')), 20);

    await assert.rejects(promise, /requestEthereumJsonRpc was aborted by the caller/);
    assert.equal(attempts, 1);
});

test('requestEthereumJsonRpc rejects invalid responses and non-serializable params clearly', async () => {
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 0 }),
            fetch: async () => createTextResponse(200, 'not json'),
            method: 'eth_chainId',
        }),
        /response was not valid JSON/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch: async () =>
                createTextResponse(200, '{"id":1,"result":"0x1"}'),
            method: 'eth_chainId',
            id: 1,
        }),
        /jsonrpc "2\.0"/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 0 }),
            fetch: async () => createTextResponse(200, '{"jsonrpc":"2.0","id":1}'),
            method: 'eth_chainId',
        }),
        /did not include a result/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch: async () =>
                createTextResponse(200, '{"jsonrpc":"2.0","id":2,"result":"0x1"}'),
            method: 'eth_chainId',
            id: 1,
        }),
        /response id did not match request id/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch: async () =>
                createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 2,
                        error: {
                            code: -32000,
                            message: 'wrong response',
                        },
                    })
                ),
            method: 'eth_chainId',
            id: 1,
        }),
        (error) => {
            assert.equal(error instanceof EthereumJsonRpcError, false);
            assert.match(error.message, /response id did not match request id/);
            return true;
        }
    );

    let attempts = 0;
    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig({ maxRetries: 0 }),
            fetch: async () => {
                attempts += 1;
                return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
            },
            method: 'eth_getBalance',
            params: ['0x0000000000000000000000000000000000000000', 1n],
        }),
        /params must be JSON-serializable/
    );
    assert.equal(attempts, 0);
});

test('requestEthereumJsonRpc validates request options before calling fetch', async () => {
    let attempts = 0;
    const fetch = async () => {
        attempts += 1;
        return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
    };

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch,
            method: '',
        }),
        /method must be a non-empty string/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch,
            method: 'eth_call',
            params: {},
        }),
        /params must be an array/
    );

    await assert.rejects(
        requestEthereumJsonRpc({
            config: createConfig(),
            fetch,
            method: 'eth_call',
            id: 1.5,
        }),
        /id must be a non-empty string or safe integer/
    );

    assert.equal(attempts, 0);
});
