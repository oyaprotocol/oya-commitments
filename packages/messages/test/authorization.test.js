import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createSignedMessageAuthorizer,
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

test('createSignedMessageAuthorizer prevalidates and snapshots its allowlist', () => {
    const allowedSigners = [
        OTHER_SIGNER,
        SIGNER.toLowerCase(),
        SIGNER,
    ];
    const authorizeSignedMessage = createSignedMessageAuthorizer(allowedSigners);

    allowedSigners.splice(0, allowedSigners.length, OTHER_SIGNER);

    assert.equal(typeof authorizeSignedMessage, 'function');
    assert.equal(Object.isFrozen(authorizeSignedMessage), true);
    assert.equal(Object.hasOwn(authorizeSignedMessage, 'allowedSigners'), false);
    assert.doesNotThrow(() => authorizeSignedMessage(createSignedMessage()));
});

test('authorizer verifies and authorizes messages case-insensitively', () => {
    const authorizeSignedMessage = createSignedMessageAuthorizer([
        OTHER_SIGNER,
        SIGNER.toLowerCase(),
    ]);
    const message = authorizeSignedMessage(createSignedMessage());

    assert.deepEqual(message, createSignedMessage());
    assert.equal(message.signer, SIGNER);
    assert.equal(Object.isFrozen(message), true);
});

test('authorizer rejects verified signers outside the allowlist', () => {
    for (const allowedSigners of [[], [OTHER_SIGNER]]) {
        const authorizeSignedMessage = createSignedMessageAuthorizer(allowedSigners);
        assert.throws(
            () => authorizeSignedMessage(createSignedMessage()),
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

test('authorizer preserves validation and verification failures', () => {
    const authorizeSignedMessage = createSignedMessageAuthorizer([SIGNER]);
    assert.throws(
        () =>
            authorizeSignedMessage({
                ...createSignedMessage(),
                text: 'Changed text.',
            }),
        SignedMessageVerificationError
    );
    assert.throws(
        () =>
            authorizeSignedMessage({
                ...createSignedMessage(),
                signer: '0x1234',
            }),
        SignedMessageValidationError
    );
});

test('createSignedMessageAuthorizer rejects malformed configuration', () => {
    assert.throws(
        () => createSignedMessageAuthorizer(new Set([SIGNER])),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners must be an array/.test(error.message)
    );
    assert.throws(
        () => createSignedMessageAuthorizer([SIGNER, '0x1234']),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners\[1\] must be a 20-byte 0x-prefixed Ethereum address/.test(
                error.message
            )
    );
});
