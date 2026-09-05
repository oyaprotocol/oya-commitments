import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createIpfsConfig,
    readIpfsBytes,
    readIpfsPublicGatewayBytes,
    readIpfsPublicGatewayText,
    readIpfsText,
} from '../dist/index.js';

function createConfig(overrides = {}) {
    return createIpfsConfig({
        url: 'http://ipfs.example:5001/',
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

test('readIpfsBytes reads bounded arbitrary bytes and returns normalized details', async () => {
    const calls = [];
    const result = await readIpfsBytes({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['hi', new Uint8Array([0x00, 0xff])]);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ipfs.example:5001/api/v0/cat?arg=bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(Array.from(result.bytes), [0x68, 0x69, 0x00, 0xff]);
    assert.deepEqual(
        {
            cid: result.cid,
            uri: result.uri,
            byteLength: result.byteLength,
            attemptCount: result.attemptCount,
        },
        {
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            uri: 'ipfs://bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            byteLength: 4,
            attemptCount: 1,
        }
    );
});

test('readIpfsBytes rejects responses that exceed maxBytes', async () => {
    await assert.rejects(
        readIpfsBytes({
            config: createConfig(),
            fetch: async () => createStreamResponse(200, [new Uint8Array([0x00, 0x01, 0x02])]),
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 2,
        }),
        /exceeded maxBytes \(2\)/
    );
});

test('readIpfsBytes normalizes empty thrown values to the fallback error', async () => {
    await assert.rejects(
        readIpfsBytes({
            config: createConfig({ maxRetries: 0 }),
            fetch: async () => {
                throw null;
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /IPFS bytes read failed\./
    );
});

test('readIpfsPublicGatewayBytes reads bounded bytes with a gateway GET request', async () => {
    const calls = [];
    const result = await readIpfsPublicGatewayBytes({
        gatewayUrl: 'https://gateway.example/ipfs/',
        headers: {
            Accept: 'application/octet-stream',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['gw', new Uint8Array([0xff])]);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.example/ipfs/bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Accept, 'application/octet-stream');
    assert.deepEqual(Array.from(result.bytes), [0x67, 0x77, 0xff]);
    assert.deepEqual(
        {
            cid: result.cid,
            uri: result.uri,
            byteLength: result.byteLength,
            attemptCount: result.attemptCount,
        },
        {
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            uri: 'ipfs://bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            byteLength: 3,
            attemptCount: 1,
        }
    );
});

test('readIpfsPublicGatewayBytes preserves gateway query strings', async () => {
    const calls = [];
    await readIpfsPublicGatewayBytes({
        gatewayUrl: 'https://gateway.example/ipfs?token=abc',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['ok']);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.example/ipfs/bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e?token=abc');
});

test('readIpfsPublicGatewayBytes rejects gateway fragments before calling fetch', async () => {
    let attempts = 0;
    await assert.rejects(
        readIpfsPublicGatewayBytes({
            gatewayUrl: 'https://gateway.example/#fragment',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /gatewayUrl must not include a fragment/
    );
    assert.equal(attempts, 0);
});

test('readIpfsPublicGatewayBytes retries retryable HTTP failures and cancels bodies', async () => {
    let attempts = 0;
    const cancellations = [];
    const result = await readIpfsPublicGatewayBytes({
        gatewayUrl: 'https://gateway.example',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 0,
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
            return createStreamResponse(200, ['gateway retry ok']);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(attempts, 2);
    assert.equal(cancellations.length, 1);
    assert.match(cancellations[0].message, /503 Service Unavailable/);
    assert.deepEqual(Array.from(result.bytes), Array.from(encodeAscii('gateway retry ok')));
    assert.equal(result.attemptCount, 2);
});

test('readIpfsPublicGatewayBytes validates gateway options before calling fetch', async () => {
    let attempts = 0;
    const fetch = async () => {
        attempts += 1;
        return createStreamResponse(200, ['never']);
    };

    await assert.rejects(
        readIpfsPublicGatewayBytes({
            gatewayUrl: '   ',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch,
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /gatewayUrl must be a non-empty string/
    );

    await assert.rejects(
        readIpfsPublicGatewayBytes({
            gatewayUrl: 'https://gateway.example',
            headers: {
                Authorization: 123,
            },
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch,
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /headers.Authorization must be a string/
    );

    assert.equal(attempts, 0);
});

test('readIpfsPublicGatewayBytes rejects Headers instances before calling fetch', async () => {
    let attempts = 0;
    await assert.rejects(
        readIpfsPublicGatewayBytes({
            gatewayUrl: 'https://gateway.example',
            headers: new Headers({
                Authorization: 'Bearer test-token',
            }),
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /headers must be a plain object/
    );
    assert.equal(attempts, 0);
});

test('readIpfsPublicGatewayBytes allows content-type gateway headers', async () => {
    const calls = [];
    await readIpfsPublicGatewayBytes({
        gatewayUrl: 'https://gateway.example',
        headers: {
            'content-type': 'text/plain',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['ok']);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers['content-type'], 'text/plain');
});

test('readIpfsPublicGatewayBytes normalizes empty thrown values to the fallback error', async () => {
    await assert.rejects(
        readIpfsPublicGatewayBytes({
            gatewayUrl: 'https://gateway.example',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 0,
            retryDelayMs: 0,
            fetch: async () => {
                throw null;
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /IPFS public gateway bytes read failed\./
    );
});

test('readIpfsPublicGatewayText reads bounded ASCII text through the gateway byte reader', async () => {
    const calls = [];
    const result = await readIpfsPublicGatewayText({
        gatewayUrl: 'https://gateway.example',
        headers: {
            Accept: 'text/plain',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['gateway ', 'text\n']);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.example/ipfs/bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Accept, 'text/plain');
    assert.deepEqual(result, {
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        uri: 'ipfs://bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        text: 'gateway text\n',
        byteLength: 13,
        attemptCount: 1,
    });
});

test('readIpfsPublicGatewayText rejects non-ASCII bytes', async () => {
    await assert.rejects(
        readIpfsPublicGatewayText({
            gatewayUrl: 'https://gateway.example',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch: async () => createStreamResponse(200, [new Uint8Array([0x68, 0x69, 0x80])]),
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
        }),
        /public gateway response contained non-ASCII bytes/
    );
});

test('readIpfsPublicGatewayText uses text-specific caller abort errors', async () => {
    const controller = new AbortController();
    let attempts = 0;
    controller.abort(new Error('stop before request'));

    await assert.rejects(
        readIpfsPublicGatewayText({
            gatewayUrl: 'https://gateway.example',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 1,
            retryDelayMs: 0,
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
            maxBytes: 64,
            signal: controller.signal,
        }),
        /readIpfsPublicGatewayText was aborted by the caller/
    );
    assert.equal(attempts, 0);
});

test('readIpfsText reads bounded ASCII text and returns normalized details', async () => {
    const calls = [];
    const result = await readIpfsText({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['hello ', 'world\n']);
        },
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        maxBytes: 64,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ipfs.example:5001/api/v0/cat?arg=bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(result, {
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        uri: 'ipfs://bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
        text: 'hello world\n',
        byteLength: 12,
        attemptCount: 1,
    });
});

test('readIpfsText rejects a path instead of a canonical CID before fetching', async () => {
    const calls = [];
    await assert.rejects(readIpfsText({
        config: createConfig(),
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createStreamResponse(200, ['ok']);
        },
        cid: 'bafy/with/slash',
        maxBytes: 64,
    }), /cid must be a canonical CIDv1/);

    assert.equal(calls.length, 0);
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
        cid: 'bafkreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe',
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
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
        cid: 'bafkreibnecdvlqg33r72todcgjzfr5gvha5tz2ct4lj2ooxarnm22vglxy',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
        /cid must be a canonical CIDv1/
    );
    await assert.rejects(
        readIpfsText({
            config: createConfig(),
            fetch: async () => {
                attempts += 1;
                return createStreamResponse(200, ['never']);
            },
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
            cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
        cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
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
