import assert from 'node:assert/strict';
import test from 'node:test';

import {
    authorizeSignedMessage,
    SignedMessageAuthorizationError,
    SignedMessageValidationError,
    SignedMessageVerificationError,
} from '../dist/index.js';

const SIGNER = '0x14791697260E4c9A71f18484C9f997B308e59325';
const OTHER_SIGNER = '0x1111111111111111111111111111111111111111';
const TEXT = 'Please withdraw 100 USDC.';
const SIGNATURE =
    '0x36891560b97f673db6931408e45fd3e8ffca26ae50f1c68adbe74e57808b9248' +
    '0f55566cc281099d59dc574c7e444851af9a8978acd55503ca3d2565061e542d1b';

function createSignedMessage() {
    return {
        text: TEXT,
        signer: SIGNER,
        signature: SIGNATURE,
    };
}

test('authorizeSignedMessage verifies and authorizes case-insensitively', () => {
    const message = authorizeSignedMessage(
        createSignedMessage(),
        [OTHER_SIGNER, SIGNER.toLowerCase()]
    );

    assert.deepEqual(message, createSignedMessage());
    assert.equal(message.signer, SIGNER);
    assert.equal(Object.isFrozen(message), true);
});

test('authorizeSignedMessage rejects verified signers outside the allowlist', () => {
    for (const allowedSigners of [[], [OTHER_SIGNER]]) {
        assert.throws(
            () => authorizeSignedMessage(createSignedMessage(), allowedSigners),
            (error) => {
                assert.ok(error instanceof SignedMessageAuthorizationError);
                assert.equal(error.name, 'SignedMessageAuthorizationError');
                assert.equal(error.code, 'unauthorized_signer');
                assert.equal(error.status, 403);
                assert.match(error.message, /signer is not authorized/);
                return true;
            }
        );
    }
});

test('authorizeSignedMessage preserves validation and verification failures', () => {
    assert.throws(
        () =>
            authorizeSignedMessage(
                { ...createSignedMessage(), text: 'Changed text.' },
                [SIGNER]
            ),
        SignedMessageVerificationError
    );
    assert.throws(
        () =>
            authorizeSignedMessage(
                { ...createSignedMessage(), signer: '0x1234' },
                [SIGNER]
            ),
        SignedMessageValidationError
    );
});

test('authorizeSignedMessage rejects malformed allowlists', () => {
    assert.throws(
        () => authorizeSignedMessage(createSignedMessage(), new Set([SIGNER])),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners must be an array/.test(error.message)
    );
    assert.throws(
        () => authorizeSignedMessage(createSignedMessage(), [SIGNER, '0x1234']),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners\[1\] must be a 20-byte 0x-prefixed Ethereum address/.test(
                error.message
            )
    );
});
