import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertAsciiBytes,
    assertBytes32HexString,
    assertHeadersObject,
    assertHexData,
    assertHexString,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
    combineAbortSignals,
    createHttpConfig,
    createTimeoutSignal,
    hasRetryableNetworkErrorCode,
    HttpStatusError,
    invokeWithAbort,
    isPlainObject,
    readErrorStringChain,
    RETRYABLE_HTTP_NETWORK_ERROR_CODES,
    runWithRetry,
    throwIfSignalAborted,
    waitForRetryDelay,
} from '../dist/index.js';

test('string and integer validators normalize and reject invalid values', () => {
    assert.equal(assertNonEmptyString('  value  ', 'value'), 'value');
    assert.equal(assertPositiveInteger(1, 'count'), 1);
    assert.equal(assertNonNegativeInteger(0, 'count'), 0);

    assert.throws(
        () => assertNonEmptyString('   ', 'value'),
        /value must be a non-empty string/
    );
    assert.throws(
        () => assertPositiveInteger(0, 'count'),
        /count must be a positive integer/
    );
    assert.throws(
        () => assertNonNegativeInteger(-1, 'count'),
        /count must be a non-negative integer/
    );
});

test('assertHeadersObject validates plain string header records', () => {
    const headers = assertHeadersObject(
        {
            Authorization: 'Bearer token',
        },
        'headers',
        {
            disallowedNames: ['content-type'],
        }
    );

    assert.deepEqual(headers, {
        Authorization: 'Bearer token',
    });
    assert.equal(Object.isFrozen(headers), true);

    assert.throws(
        () => assertHeadersObject(new Map(), 'headers'),
        /headers must be a plain object/
    );
    assert.throws(
        () =>
            assertHeadersObject(
                {
                    'Content-Type': 'application/json',
                },
                'headers',
                {
                    disallowedNames: ['content-type'],
                }
            ),
        /headers must not include content-type/
    );
    assert.throws(
        () =>
            assertHeadersObject(
                {
                    Authorization: 123,
                },
                'headers'
            ),
        /headers\.Authorization must be a string/
    );
});

test('isPlainObject accepts plain records and rejects non-record objects', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(new Map()), false);
});

test('ASCII and hex validators preserve valid input and reject malformed values', () => {
    assert.doesNotThrow(() =>
        assertAsciiBytes(new Uint8Array([0x00, 0x41, 0x7f]), 'bytes must be ASCII')
    );
    assert.throws(
        () => assertAsciiBytes(new Uint8Array([0x80]), 'bytes must be ASCII'),
        /bytes must be ASCII/
    );

    assert.equal(assertHexString('  0xAbCd  ', 'hex'), '0xAbCd');
    assert.equal(assertHexData('0xAbCd', 'data'), '0xAbCd');
    assert.equal(
        assertBytes32HexString(`0x${'a'.repeat(64)}`, 'hash'),
        `0x${'a'.repeat(64)}`
    );

    assert.throws(
        () => assertHexString('abcd', 'hex'),
        /hex must be a 0x-prefixed hex string/
    );
    assert.throws(
        () => assertHexString('0xzz', 'hex'),
        /hex must be a 0x-prefixed hex string/
    );
    assert.throws(
        () => assertHexData('0x', 'data'),
        /data must be non-empty byte-aligned hex data/
    );
    assert.throws(
        () => assertHexData('0xzz', 'data'),
        /data must be a 0x-prefixed hex string/
    );
    assert.throws(
        () => assertHexData('0xabc', 'data'),
        /data must be non-empty byte-aligned hex data/
    );
    assert.throws(
        () => assertBytes32HexString('0xabcd', 'hash'),
        /hash must be a 32-byte hex string/
    );
    assert.throws(
        () => assertBytes32HexString(`0x${'g'.repeat(64)}`, 'hash'),
        /hash must be a 0x-prefixed hex string/
    );
});

test('createHttpConfig validates and freezes HTTP transport configuration', () => {
    const config = createHttpConfig({
        url: '  https://rpc.example///  ',
        headers: {
            Authorization: 'Bearer token',
        },
        timeoutMs: 1000,
        maxRetries: 2,
        retryDelayMs: 50,
    });

    assert.deepEqual(config, {
        url: 'https://rpc.example',
        headers: {
            Authorization: 'Bearer token',
        },
        timeoutMs: 1000,
        maxRetries: 2,
        retryDelayMs: 50,
    });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.headers), true);

    assert.throws(
        () =>
            createHttpConfig({
                url: 'https://rpc.example',
                headers: {
                    'Content-Type': 'application/json',
                },
                timeoutMs: 1000,
                maxRetries: 2,
                retryDelayMs: 50,
            }),
        /config\.headers must not include content-type/
    );
    assert.throws(
        () =>
            createHttpConfig({
                url: '/',
                headers: {},
                timeoutMs: 1000,
                maxRetries: 2,
                retryDelayMs: 50,
            }),
        /config\.url must be a non-empty string/
    );
});

test('HttpStatusError captures normalized HTTP failure details', () => {
    const error = new HttpStatusError({
        operation: 'Example request',
        status: 503,
        statusText: ' Service Unavailable ',
        responseText: '{"error":"temporary outage"}',
    });

    assert.equal(error.name, 'HttpStatusError');
    assert.equal(error.message, 'Example request failed with 503 Service Unavailable.');
    assert.equal(error.operation, 'Example request');
    assert.equal(error.status, 503);
    assert.equal(error.statusText, 'Service Unavailable');
    assert.equal(error.responseText, '{"error":"temporary outage"}');

    const opaqueError = new HttpStatusError({
        operation: 'Opaque fetch response',
        status: 0,
        statusText: '',
    });

    assert.equal(opaqueError.message, 'Opaque fetch response failed with 0 Unknown Status.');
    assert.equal(opaqueError.status, 0);
    assert.equal(opaqueError.statusText, 'Unknown Status');
});

test('hasRetryableNetworkErrorCode detects retryable HTTP network codes', () => {
    assert.equal(RETRYABLE_HTTP_NETWORK_ERROR_CODES.has('ECONNRESET'), true);
    assert.equal(
        hasRetryableNetworkErrorCode({
            code: 'econnreset',
        }),
        true
    );
    assert.equal(
        hasRetryableNetworkErrorCode(
            new Error('fetch failed', {
                cause: {
                    code: 'UND_ERR_SOCKET',
                },
            })
        ),
        true
    );
    assert.equal(
        hasRetryableNetworkErrorCode({
            code: 'ERR_INVALID_URL',
        }),
        false
    );
    assert.equal(hasRetryableNetworkErrorCode(null), false);
});

test('readErrorStringChain collects string properties across error causes', () => {
    const error = new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket closed'), {
            code: 'ECONNRESET',
            cause: {
                message: 'nested plain object',
            },
        }),
    });

    assert.deepEqual(readErrorStringChain(error, 'name'), ['TypeError', 'Error']);
    assert.deepEqual(readErrorStringChain(error, 'message'), [
        'fetch failed',
        'socket closed',
        'nested plain object',
    ]);
    assert.deepEqual(readErrorStringChain(error, 'code'), ['ECONNRESET']);
    assert.deepEqual(readErrorStringChain({ message: 123 }, 'message'), []);
});

test('abort utilities compose signals and reject aborted operations', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals([first.signal, second.signal]);
    assert.ok(combined.signal instanceof AbortSignal);
    second.abort(new Error('stop combined operation'));
    assert.equal(combined.signal.aborted, true);
    assert.match(String(combined.signal.reason), /stop combined operation/);
    combined.cleanup?.();

    const timeout = createTimeoutSignal(1_000);
    assert.ok(timeout.signal instanceof AbortSignal);
    timeout.cleanup?.();

    await assert.rejects(
        invokeWithAbort(async () => await new Promise(() => {}), second.signal),
        /stop combined operation/
    );
    assert.throws(
        () => throwIfSignalAborted(second.signal, 'operation aborted', second.signal.reason),
        /operation aborted/
    );
});

test('waitForRetryDelay resolves immediately for zero delay and rejects aborted waits', async () => {
    await waitForRetryDelay({
        retryDelayMs: 0,
        signal: undefined,
        abortErrorMessage: 'retry aborted',
    });

    const controller = new AbortController();
    controller.abort(new Error('stop retry'));

    await assert.rejects(
        waitForRetryDelay({
            retryDelayMs: 1_000,
            signal: controller.signal,
            abortErrorMessage: 'retry aborted',
        }),
        /retry aborted/
    );
});

test('runWithRetry retries eligible failures and normalizes terminal errors', async () => {
    let attempts = 0;
    const result = await runWithRetry({
        maxRetries: 2,
        retryDelayMs: 0,
        timeoutMs: 1_000,
        abortErrorMessage: 'operation aborted',
        shouldRetry: (error) => error instanceof Error && error.message === 'temporary',
        normalizeError: (error) => (error instanceof Error ? error : new Error('normalized')),
        run: async ({ attempt, signal }) => {
            attempts += 1;
            assert.equal(signal instanceof AbortSignal, true);
            if (attempt === 1) {
                throw new Error('temporary');
            }
            return `attempt-${attempt}`;
        },
    });

    assert.equal(result, 'attempt-2');
    assert.equal(attempts, 2);

    await assert.rejects(
        runWithRetry({
            maxRetries: 1,
            retryDelayMs: 0,
            timeoutMs: 1_000,
            abortErrorMessage: 'operation aborted',
            shouldRetry: () => false,
            normalizeError: (error) =>
                error instanceof Error ? error : new Error('terminal failure'),
            run: async () => {
                throw 'terminal failure';
            },
        }),
        /terminal failure/
    );
});
