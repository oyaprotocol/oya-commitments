import assert from 'node:assert/strict';
import test from 'node:test';

import { createIpfsPublishConfig, publishToIpfs } from '../dist/index.js';

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

test('publishToIpfs publishes content and returns normalized details', async () => {
    const calls = [];
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001/',
        headers: {
            Authorization: 'Bearer test-token',
        },
        timeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 0,
    });
    const result = await publishToIpfs({
        config,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return createTextResponse(
                200,
                '\n{"Name":"note.txt","Hash":"bafy-publish-ok","Size":"11"}\n'
            );
        },
        content: 'hello world',
        filename: 'note.txt',
        mediaType: 'text/plain; charset=utf-8',
    });

    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        'http://ipfs.example:5001/api/v0/add?cid-version=1&pin=false&progress=false'
    );
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.ok(calls[0].options.body instanceof FormData);

    assert.deepEqual(result, {
        cid: 'bafy-publish-ok',
        uri: 'ipfs://bafy-publish-ok',
        filename: 'note.txt',
        mediaType: 'text/plain; charset=utf-8',
        contentByteLength: 11,
        providerSize: 11,
        attemptCount: 1,
        providerResponse: {
            Name: 'note.txt',
            Hash: 'bafy-publish-ok',
            Size: '11',
        },
    });
});

test('publishToIpfs retries retryable HTTP failures and succeeds', async () => {
    let attempts = 0;
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 0,
    });
    const result = await publishToIpfs({
        config,
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                return createTextResponse(503, '{"error":"temporary outage"}', 'Service Unavailable');
            }
            return createTextResponse(200, '{"Hash":"bafy-retry-ok","Size":"3"}');
        },
        content: new Uint8Array([1, 2, 3]),
        filename: 'artifact.bin',
        mediaType: 'application/octet-stream',
    });

    assert.equal(attempts, 2);
    assert.equal(result.cid, 'bafy-retry-ok');
    assert.equal(result.attemptCount, 2);
    assert.equal(result.contentByteLength, 3);
});

test('publishToIpfs retries retryable network errors and succeeds', async () => {
    let attempts = 0;
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 0,
    });
    const result = await publishToIpfs({
        config,
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('connect ECONNRESET');
                error.code = 'ECONNRESET';
                throw error;
            }
            return createTextResponse(200, '{"Hash":"bafy-network-ok","Size":"8"}');
        },
        content: 'retry me',
        filename: 'retry.txt',
        mediaType: 'text/plain; charset=utf-8',
    });

    assert.equal(attempts, 2);
    assert.equal(result.cid, 'bafy-network-ok');
    assert.equal(result.attemptCount, 2);
});

test('publishToIpfs retries fetch errors when a retryable network code is nested in error.cause', async () => {
    let attempts = 0;
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 2,
        retryDelayMs: 0,
    });
    const result = await publishToIpfs({
        config,
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError('fetch failed', {
                    cause: Object.assign(new Error('connect ECONNREFUSED'), {
                        code: 'ECONNREFUSED',
                    }),
                });
            }
            return createTextResponse(200, '{"Hash":"bafy-cause-ok","Size":"8"}');
        },
        content: 'retry me',
        filename: 'retry-cause.txt',
        mediaType: 'text/plain; charset=utf-8',
    });

    assert.equal(attempts, 2);
    assert.equal(result.cid, 'bafy-cause-ok');
    assert.equal(result.attemptCount, 2);
});

test('publishToIpfs does not retry non-retryable HTTP failures', async () => {
    let attempts = 0;
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 3,
        retryDelayMs: 0,
    });
    await assert.rejects(
        publishToIpfs({
            config,
            fetch: async () => {
                attempts += 1;
                return createTextResponse(400, '{"error":"bad request"}', 'Bad Request');
            },
            content: 'bad request',
            filename: 'bad.txt',
            mediaType: 'text/plain; charset=utf-8',
        }),
        /400 Bad Request/
    );
    assert.equal(attempts, 1);
});

test('publishToIpfs fails when the IPFS add response omits the cid', async () => {
    const config = createIpfsPublishConfig({
        apiUrl: 'http://ipfs.example:5001',
        headers: {},
        timeoutMs: 1_000,
        maxRetries: 0,
        retryDelayMs: 0,
    });
    await assert.rejects(
        publishToIpfs({
            config,
            fetch: async () => createTextResponse(200, '{"Name":"missing.txt","Size":"11"}'),
            content: 'missing cid',
            filename: 'missing.txt',
            mediaType: 'text/plain; charset=utf-8',
        }),
        /did not include a CID/
    );
});

test('createIpfsPublishConfig requires explicit transport configuration', () => {
    assert.throws(
        () =>
            createIpfsPublishConfig({
                apiUrl: 'http://ipfs.example:5001',
                headers: {},
                timeoutMs: 0,
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.timeoutMs must be a positive integer/
    );
    assert.throws(
        () =>
            createIpfsPublishConfig({
                apiUrl: 'http://ipfs.example:5001',
                headers: {
                    'content-type': 'application/json',
                },
                timeoutMs: 1_000,
                maxRetries: 1,
                retryDelayMs: 0,
            }),
        /config\.headers must not include content-type/
    );
});

test('publishToIpfs clears the fallback timeout timer after a successful request', async () => {
    const originalAbortSignalTimeout = AbortSignal.timeout;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const clearedTimers = [];

    Object.defineProperty(AbortSignal, 'timeout', {
        value: undefined,
        configurable: true,
        writable: true,
    });
    globalThis.setTimeout = (fn, ms) => ({ fn, ms, kind: 'fallback-timeout' });
    globalThis.clearTimeout = (timer) => {
        clearedTimers.push(timer);
    };

    try {
        const config = createIpfsPublishConfig({
            apiUrl: 'http://ipfs.example:5001',
            headers: {},
            timeoutMs: 1_000,
            maxRetries: 0,
            retryDelayMs: 0,
        });

        const result = await publishToIpfs({
            config,
            fetch: async () => createTextResponse(200, '{"Hash":"bafy-timeout-cleanup","Size":"5"}'),
            content: 'hello',
            filename: 'cleanup.txt',
            mediaType: 'text/plain; charset=utf-8',
        });

        assert.equal(result.cid, 'bafy-timeout-cleanup');
        assert.equal(clearedTimers.length, 1);
        assert.deepEqual(clearedTimers[0], { fn: clearedTimers[0].fn, ms: 1_000, kind: 'fallback-timeout' });
    } finally {
        Object.defineProperty(AbortSignal, 'timeout', {
            value: originalAbortSignalTimeout,
            configurable: true,
            writable: true,
        });
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('publishToIpfs aborts during retry backoff without making another attempt', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduledTimers = [];
    const controller = new AbortController();
    let attempts = 0;

    globalThis.setTimeout = (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        scheduledTimers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => {
        timer.cleared = true;
    };

    try {
        const config = createIpfsPublishConfig({
            apiUrl: 'http://ipfs.example:5001',
            headers: {},
            timeoutMs: 10_000,
            maxRetries: 1,
            retryDelayMs: 1_000,
        });

        const publishPromise = publishToIpfs({
            config,
            fetch: async () => {
                attempts += 1;
                const error = new Error('connect ECONNRESET');
                error.code = 'ECONNRESET';
                throw error;
            },
            content: 'abort me',
            filename: 'abort.txt',
            mediaType: 'text/plain; charset=utf-8',
            signal: controller.signal,
        });

        await Promise.resolve();
        await Promise.resolve();

        assert.equal(attempts, 1);
        assert.equal(scheduledTimers.length, 1);
        assert.equal(scheduledTimers[0].ms, 1_000);

        controller.abort(new Error('stop retrying'));

        await assert.rejects(publishPromise, /aborted by the caller/);
        assert.equal(attempts, 1);
        assert.equal(scheduledTimers[0].cleared, true);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
