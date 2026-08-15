import assert from 'node:assert/strict';
import test from 'node:test';

import {
    authorizeMessageSigner,
    SignedMessageAuthorizationError,
} from '../dist/index.js';

const SIGNER = '0x14791697260E4c9A71f18484C9f997B308e59325';
const OTHER_SIGNER = '0x1111111111111111111111111111111111111111';

test('authorizeMessageSigner authorizes addresses case-insensitively', () => {
    assert.equal(
        authorizeMessageSigner(SIGNER, [OTHER_SIGNER, SIGNER.toLowerCase()]),
        SIGNER
    );
    assert.equal(
        authorizeMessageSigner(SIGNER.toLowerCase(), [SIGNER]),
        SIGNER.toLowerCase()
    );
});

test('authorizeMessageSigner rejects signers outside the allowlist', () => {
    for (const allowedSigners of [[], [OTHER_SIGNER]]) {
        assert.throws(
            () => authorizeMessageSigner(SIGNER, allowedSigners),
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

test('authorizeMessageSigner rejects malformed addresses and allowlists', () => {
    assert.throws(
        () => authorizeMessageSigner('0x1234', [SIGNER]),
        (error) =>
            error instanceof TypeError &&
            /signer must be a 20-byte 0x-prefixed Ethereum address/.test(
                error.message
            )
    );
    assert.throws(
        () => authorizeMessageSigner(SIGNER, new Set([SIGNER])),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners must be an array/.test(error.message)
    );
    assert.throws(
        () => authorizeMessageSigner(SIGNER, [SIGNER, '0x1234']),
        (error) =>
            error instanceof TypeError &&
            /allowedSigners\[1\] must be a 20-byte 0x-prefixed Ethereum address/.test(
                error.message
            )
    );
});
