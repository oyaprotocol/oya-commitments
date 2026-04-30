import assert from 'node:assert/strict';
import test from 'node:test';

import { createIpfsConfig, readIpfsText } from '../dist/index.js';

function createConfig(overrides = {}) {
    return createIpfsConfig({
        apiUrl: 'http://ipfs.example:5001/',
        headers: {
            Authorization: 'Bearer test-token',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        ...overrides,
    });
}

function encodeAscii(text) {
    return new TextEncoder().encode(text);
}

function createStream(chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encodeAscii(chunk) : chunk);
            }
            controller.close();
        },
    });
}

function createCancellableStream(chunks, onCancel) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encodeAscii(chunk) : chunk);
            }
            controller.close();
        },
        cancel(reason) {
            onCancel(reason);
        },
    });
}

function createStreamResponse(status, chunks, statusText = 'OK') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        body: createStream(chunks),
    };
}

test('readIpfsText reads bounded ASCII text and returns normalized details', async () => {
    const calls = [];
    const result = await readIpfsText({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['hello ', 'world\n']);
        },
        cid: 'bafy-read-ok',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ipfs.example:5001/api/v0/cat?arg=bafy-read-ok');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(result, {
        cid: 'bafy-read-ok',
        uri: 'ipfs://bafy-read-ok',
        text: 'hello world\n',
        byteLength: 12,
        attemptCount: 1,
    });
});

test('readIpfsText encodes the cid path argument', async () => {
    const calls = [];
    await readIpfsText({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['ok']);
        },
        cid: 'bafy/with/slash',
        maxBytes: 64,
    });

    assert.equal(calls[0].url, 'http://ipfs.example:5001/api/v0/cat?arg=bafy%2Fwith%2Fslash');
});

test('readIpfsText retries retryable HTTP failures and succeeds', async () => {
    let attempts = 0;
    const result = await readIpfsText({
        config: createConfig({ maxRetries: 2 }),
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                return createStreamResponse(503, ['temporary outage'], 'Service Unavailable');
            }
            return createStreamResponse(200, ['retry ok']);
        },
        cid: 'bafy-retry-ok',
        maxBytes: 64,
    });

    assert.equal(attempts, 2);
    assert.equal(result.text, 'retry ok');
    assert.equal(result.attemptCount, 2);
});

test('readIpfsText cancels retryable HTTP failure bodies before retrying', async () => {
    let attempts = 0;
    const cancellations = [];
    const result = await readIpfsText({
        config: createConfig({ maxRetries: 2 }),
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    body: createCancellableStream(['temporary outage'], (reason) => {
                        cancellations.push(reason);
                    }),
                };
            }
            return createStreamResponse(200, ['retry ok']);
        },
        cid: 'bafy-retry-cancel',
        maxBytes: 64,
    });

    assert.equal(attempts, 2);
    assert.equal(cancellations.length, 1);
    assert.match(cancellations[0].message, /503 Service Unavailable/);
    assert.equal(result.text, 'retry ok');
});

test('readIpfsText retries retryable network errors and succeeds', async () => {
    let attempts = 0;
    const result = await readIpfsText({
        config: createConfig({ maxRetries: 2 }),
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('connect ECONNRESET');
                error.code = 'ECONNRESET';
                throw error;
            }
            return createStreamResponse(200, ['network retry ok']);
        },
        cid: 'bafy-network-ok',
        maxBytes: 64,
    });

    assert.equal(attempts, 2);
    assert.equal(result.text, 'network retry ok');
    assert.equal(result.attemptCount, 2);
});

test('readIpfsText does not retry non-retryable HTTP failures', async () => {
    let attempts = 0;
    const cancellations = [];
    await assert.rejects(
        readIpfsText({
            config: createConfig({ maxRetries: 3 }),
            fetch: async () => {
                attempts += 1;
                return {
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    body: createCancellableStream(['missing'], (reason) => {
                        cancellations.push(reason);
                    }),
                };
            },
            cid: 'bafy-missing',
            maxBytes: 64,
        }),
        /404 Not Found/
    );
    assert.equal(attempts, 1);
    assert.equal(cancellations.length, 1);
    assert.match(cancellations[0].message, /404 Not Found/);
});

test('readIpfsText rejects responses that exceed maxBytes', async () => {
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => createStreamResponse(200, ['hello', ' world']),
            cid: 'bafy-too-large',
            maxBytes: 8,
        }),
        /exceeded maxBytes \(8\)/
    );
});

test('readIpfsText rejects non-ASCII bytes', async () => {
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => createStreamResponse(200, [new Uint8Array([0x68, 0x69, 0x80])]),
            cid: 'bafy-non-ascii',
            maxBytes: 64,
        }),
        /non-ASCII/
    );
});

test('readIpfsText requires a stream response body', async () => {
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                body: null,
            }),
            cid: 'bafy-no-body',
            maxBytes: 64,
        }),
        /body must be a ReadableStream/
    );
});

test('readIpfsText validates cid and maxBytes before calling fetch', async () => {
    let attempts = 0;
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: '   ',
            maxBytes: 64,
        }),
        /cid must be a non-empty string/
    );
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafy-invalid-limit',
            maxBytes: 0,
        }),
        /maxBytes must be a positive integer/
    );
    assert.equal(attempts, 0);
});

test('readIpfsText enforces timeout even when the injected fetch ignores signal', async () => {
    await assert.rejects(
        readIpfsText({
            config: createConfig({ timeoutMs: 10, maxRetries: 0 }),
            fetch: async () => await new Promise(() => {}),
            cid: 'bafy-timeout',
            maxBytes: 64,
        }),
        /timed out/
    );
});

test('readIpfsText does not call fetch when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    controller.abort(new Error('stop before request'));

    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafy-pre-aborted',
            maxBytes: 64,
            signal: controller.signal,
        }),
        /aborted by the caller/
    );
    assert.equal(attempts, 0);
});

test('readIpfsText aborts while waiting for the response body', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const readPromise = readIpfsText({
        config: createConfig({ timeoutMs: 10_000, maxRetries: 0 }),
        fetch: async () => {
            attempts += 1;
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                body: new ReadableStream({
                    pull() {
                        return new Promise(() => {});
                    },
                }),
            };
        },
        cid: 'bafy-abort-read',
        maxBytes: 64,
        signal: controller.signal,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempts > 0) {
            break;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(attempts, 1);
    controller.abort(new Error('stop reading'));
    await assert.rejects(readPromise, /aborted by the caller/);
});
