import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
    createHttpConfig,
    hasRetryableNetworkErrorCode,
    isPlainObject,
    RETRYABLE_HTTP_NETWORK_ERROR_CODES,
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
