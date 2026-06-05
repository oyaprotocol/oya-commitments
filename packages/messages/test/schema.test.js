import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_MAX_TEXT_BYTES,
    SignedMessageValidationError,
    normalizeSignedMessage,
} from '../dist/index.js';

const VALID_SIGNER = '0x1111111111111111111111111111111111111111';
const MIXED_CASE_SIGNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const VALID_SIGNATURE = `0x${'a'.repeat(130)}`;
const UPPERCASE_SIGNATURE = `0x${'A'.repeat(130)}`;

function assertValidationError(fn, { code, status = 400, message }) {
    assert.throws(
        fn,
        (error) => {
            assert.ok(error instanceof SignedMessageValidationError);
            assert.equal(error.name, 'SignedMessageValidationError');
            assert.equal(error.code, code);
            assert.equal(error.status, status);
            if (message) {
                assert.match(error.message, message);
            }
            return true;
        }
    );
}

test('normalizeSignedMessage validates and freezes the minimal signed message shape', () => {
    const message = normalizeSignedMessage({
        text: 'Please withdraw 100 USDC.',
        signer: MIXED_CASE_SIGNER,
        signature: UPPERCASE_SIGNATURE,
    });

    assert.deepEqual(message, {
        text: 'Please withdraw 100 USDC.',
        signer: MIXED_CASE_SIGNER.toLowerCase(),
        signature: UPPERCASE_SIGNATURE,
        textByteLength: 25,
    });
    assert.equal(Object.isFrozen(message), true);
});

test('normalizeSignedMessage preserves exact text without trimming', () => {
    const text = '  keep leading and trailing spaces  ';
    const message = normalizeSignedMessage({
        text,
        signer: VALID_SIGNER,
        signature: VALID_SIGNATURE,
    });

    assert.equal(message.text, text);
    assert.equal(message.textByteLength, text.length);
});

test('normalizeSignedMessage rejects non-object bodies and unsupported fields', () => {
    assertValidationError(() => normalizeSignedMessage(null), {
        code: 'invalid_body',
        message: /Request body must be a JSON object/,
    });
    assertValidationError(() => normalizeSignedMessage([]), {
        code: 'invalid_body',
        message: /Request body must be a JSON object/,
    });
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 'hello',
                signer: VALID_SIGNER,
                signature: VALID_SIGNATURE,
                meta: {},
            }),
        {
            code: 'unsupported_field',
            message: /Unsupported field: meta/,
        }
    );
});

test('normalizeSignedMessage rejects missing, non-string, empty, and overlarge text', () => {
    assertValidationError(
        () =>
            normalizeSignedMessage({
                signer: VALID_SIGNER,
                signature: VALID_SIGNATURE,
            }),
        {
            code: 'invalid_text',
            message: /text is required and must be a string/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 123,
                signer: VALID_SIGNER,
                signature: VALID_SIGNATURE,
            }),
        {
            code: 'invalid_text',
            message: /text is required and must be a string/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: '',
                signer: VALID_SIGNER,
                signature: VALID_SIGNATURE,
            }),
        {
            code: 'invalid_text',
            message: /text must be non-empty/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage(
                {
                    text: 'ééé',
                    signer: VALID_SIGNER,
                    signature: VALID_SIGNATURE,
                },
                { maxTextBytes: 5 }
            ),
        {
            code: 'text_too_large',
            message: /text exceeds maxTextBytes \(5\)/,
        }
    );
});

test('normalizeSignedMessage validates signer and signature hex shape', () => {
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 'hello',
                signer: `0x${'1'.repeat(39)}`,
                signature: VALID_SIGNATURE,
            }),
        {
            code: 'invalid_signer',
            message: /20-byte 0x-prefixed Ethereum address/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 'hello',
                signer: `0x${'g'.repeat(40)}`,
                signature: VALID_SIGNATURE,
            }),
        {
            code: 'invalid_signer',
            message: /20-byte 0x-prefixed Ethereum address/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 'hello',
                signer: VALID_SIGNER,
                signature: `0x${'a'.repeat(128)}`,
            }),
        {
            code: 'invalid_signature',
            message: /65-byte 0x-prefixed Ethereum signature/,
        }
    );
    assertValidationError(
        () =>
            normalizeSignedMessage({
                text: 'hello',
                signer: VALID_SIGNER,
                signature: `0x${'z'.repeat(130)}`,
            }),
        {
            code: 'invalid_signature',
            message: /65-byte 0x-prefixed Ethereum signature/,
        }
    );
});

test('normalizeSignedMessage validates maxTextBytes options', () => {
    assert.equal(DEFAULT_MAX_TEXT_BYTES, 4096);
    assert.throws(
        () =>
            normalizeSignedMessage(
                {
                    text: 'hello',
                    signer: VALID_SIGNER,
                    signature: VALID_SIGNATURE,
                },
                { maxTextBytes: 0 }
            ),
        /options\.maxTextBytes must be a positive integer/
    );
});
