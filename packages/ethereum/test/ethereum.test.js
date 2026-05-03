import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEthereumRpcConfig,
    EthereumJsonRpcError,
    EthereumRawTransactionRecoveryError,
    ethSendRawTransaction,
} from '../dist/index.js';

const RAW_TRANSACTION = '0x02f86c01';
const TRANSACTION_HASH = `0x${'a'.repeat(64)}`;
const OTHER_TRANSACTION_HASH = `0x${'b'.repeat(64)}`;

function createConfig(overrides = {}) {
    return createEthereumRpcConfig({
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

test('ethSendRawTransaction submits a signed raw transaction and returns the transaction hash', async () => {
    const calls = [];
    const result = await ethSendRawTransaction({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            return createTextResponse(
                200,
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 9,
                    result: `0x${'A'.repeat(64)}`,
                })
            );
        },
        rawTransaction: '0x02F86C01',
        transactionHash: TRANSACTION_HASH,
        id: 9,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rpc.example');
    assert.deepEqual(calls[0].body, {
        jsonrpc: '2.0',
        id: 9,
        method: 'eth_sendRawTransaction',
        params: [RAW_TRANSACTION],
    });
    assert.deepEqual(
        {
            transactionHash: result.transactionHash,
            attemptCount: result.attemptCount,
            recovered: result.recovered,
        },
        {
            transactionHash: TRANSACTION_HASH,
            attemptCount: 1,
            recovered: false,
        }
    );
});

test('ethSendRawTransaction validates raw transaction data and optional transaction hash', async () => {
    let attempts = 0;
    const fetch = async () => {
        attempts += 1;
        return createTextResponse(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
    };

    await assert.rejects(
        ethSendRawTransaction({
            config: createConfig(),
            fetch,
            rawTransaction: '0x',
        }),
        /rawTransaction must be non-empty byte-aligned hex data/
    );
    await assert.rejects(
        ethSendRawTransaction({
            config: createConfig(),
            fetch,
            rawTransaction: RAW_TRANSACTION,
            transactionHash: '0x1234',
        }),
        /transactionHash must be a 32-byte hex string/
    );

    assert.equal(attempts, 0);
});

test('ethSendRawTransaction recovers duplicate retry errors with a supplied transaction hash', async () => {
    const calls = [];
    const result = await ethSendRawTransaction({
        config: createConfig({ maxRetries: 1 }),
        fetch: async (_url, options) => {
            const body = JSON.parse(options.body);
            calls.push(body);

            if (calls.length === 1) {
                return createTextResponse(
                    503,
                    '{"error":"temporary outage"}',
                    'Service Unavailable'
                );
            }
            if (body.method === 'eth_sendRawTransaction') {
                return createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        error: {
                            code: -32000,
                            message: 'already known',
                        },
                    })
                );
            }
            return createTextResponse(
                200,
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        hash: `0x${'A'.repeat(64)}`,
                        blockHash: null,
                    },
                })
            );
        },
        rawTransaction: RAW_TRANSACTION,
        transactionHash: TRANSACTION_HASH,
    });

    assert.deepEqual(
        calls.map((body) => body.method),
        ['eth_sendRawTransaction', 'eth_sendRawTransaction', 'eth_getTransactionByHash']
    );
    assert.deepEqual(calls[2].params, [TRANSACTION_HASH]);
    assert.equal(result.transactionHash, TRANSACTION_HASH);
    assert.equal(result.attemptCount, 2);
    assert.equal(result.recoveryAttemptCount, 1);
    assert.equal(result.recovered, true);
});

test('ethSendRawTransaction surfaces ambiguous duplicate retry errors without a transaction hash', async () => {
    let attempts = 0;
    await assert.rejects(
        ethSendRawTransaction({
            config: createConfig({ maxRetries: 1 }),
            fetch: async (_url, options) => {
                const body = JSON.parse(options.body);
                attempts += 1;
                if (attempts === 1) {
                    return createTextResponse(
                        503,
                        '{"error":"temporary outage"}',
                        'Service Unavailable'
                    );
                }
                return createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        error: {
                            code: -32000,
                            message: 'already known',
                        },
                    })
                );
            },
            rawTransaction: RAW_TRANSACTION,
        }),
        (error) => {
            assert.ok(error instanceof EthereumRawTransactionRecoveryError);
            assert.equal(error.transactionHash, null);
            assert.ok(error.originalError instanceof EthereumJsonRpcError);
            assert.equal(error.originalError.attemptCount, 2);
            return true;
        }
    );
    assert.equal(attempts, 2);
});

test('ethSendRawTransaction rejects mismatched transaction hashes', async () => {
    await assert.rejects(
        ethSendRawTransaction({
            config: createConfig(),
            fetch: async () =>
                createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: OTHER_TRANSACTION_HASH,
                    })
                ),
            rawTransaction: RAW_TRANSACTION,
            transactionHash: TRANSACTION_HASH,
        }),
        /returned a transaction hash that did not match transactionHash/
    );
});

test('ethSendRawTransaction rejects recovery when transaction lookup does not confirm the hash', async () => {
    let sendAttempts = 0;
    await assert.rejects(
        ethSendRawTransaction({
            config: createConfig({ maxRetries: 1 }),
            fetch: async (_url, options) => {
                const body = JSON.parse(options.body);
                if (body.method === 'eth_sendRawTransaction') {
                    sendAttempts += 1;
                }
                if (sendAttempts === 1) {
                    return createTextResponse(
                        503,
                        '{"error":"temporary outage"}',
                        'Service Unavailable'
                    );
                }
                if (body.method === 'eth_sendRawTransaction') {
                    return createTextResponse(
                        200,
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: body.id,
                            error: {
                                code: -32000,
                                message: 'nonce too low',
                            },
                        })
                    );
                }
                return createTextResponse(
                    200,
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        result: null,
                    })
                );
            },
            rawTransaction: RAW_TRANSACTION,
            transactionHash: TRANSACTION_HASH,
        }),
        (error) => {
            assert.ok(error instanceof EthereumRawTransactionRecoveryError);
            assert.equal(error.transactionHash, TRANSACTION_HASH);
            assert.match(error.message, /did not confirm/);
            return true;
        }
    );
});
