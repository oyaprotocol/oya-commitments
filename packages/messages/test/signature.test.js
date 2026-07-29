import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SignedMessageValidationError,
    SignedMessageVerificationError,
    verifySignedMessage,
} from '../dist/index.js';

// These fixed vectors were generated with ethers v6 Wallet.signMessage using
// this public test-only private key:
// 0x0123456789012345678901234567890123456789012345678901234567890123
const SIGNER = '0x14791697260E4c9A71f18484C9f997B308e59325';
const TEXT = 'Please withdraw 100 USDC.';
const SIGNATURE =
    '0x36891560b97f673db6931408e45fd3e8ffca26ae50f1c68adbe74e57808b9248' +
    '0f55566cc281099d59dc574c7e444851af9a8978acd55503ca3d2565061e542d1b';
const RECOVERY_ONE_TEXT = 'Oya ASCII recovery 0';
const RECOVERY_ONE_SIGNATURE =
    '0xbd2127b32601006bb9d74d2fdea018906fee97410891af0d9158b482d79a49e25' +
    'e69968bddbe87cabb5956f52fba6ba1ad6b29dfe637d9e73381b26f60fbe77c1c';

function assertVerificationError(fn) {
    assert.throws(
        fn,
        (error) => {
            assert.ok(error instanceof SignedMessageVerificationError);
            assert.equal(error.name, 'SignedMessageVerificationError');
            assert.equal(error.code, 'invalid_signature');
            assert.equal(error.status, 401);
            assert.match(error.message, /valid EIP-191 signature/);
            return true;
        }
    );
}

test('verifySignedMessage verifies an EIP-191 signature and preserves the message', () => {
    const message = verifySignedMessage({
        text: TEXT,
        signer: SIGNER,
        signature: SIGNATURE,
    });

    assert.deepEqual(message, {
        text: TEXT,
        signer: SIGNER,
        signature: SIGNATURE,
    });
    assert.equal(Object.isFrozen(message), true);
});

test('verifySignedMessage accepts recovery values encoded as 0 or 1', () => {
    const signatureWithZeroRecovery = `${SIGNATURE.slice(0, -2)}00`;
    const zeroRecoveryMessage = verifySignedMessage({
        text: TEXT,
        signer: SIGNER.toLowerCase(),
        signature: signatureWithZeroRecovery,
    });
    const signatureWithOneRecovery = `${RECOVERY_ONE_SIGNATURE.slice(0, -2)}01`;
    const oneRecoveryMessage = verifySignedMessage({
        text: RECOVERY_ONE_TEXT,
        signer: SIGNER.toLowerCase(),
        signature: signatureWithOneRecovery,
    });

    assert.equal(zeroRecoveryMessage.signature, signatureWithZeroRecovery);
    assert.equal(zeroRecoveryMessage.signer, SIGNER.toLowerCase());
    assert.equal(oneRecoveryMessage.signature, signatureWithOneRecovery);
});

test('verifySignedMessage rejects changed signed fields', () => {
    assertVerificationError(() =>
        verifySignedMessage({
            text: `${TEXT}!`,
            signer: SIGNER,
            signature: SIGNATURE,
        })
    );
    assertVerificationError(() =>
        verifySignedMessage({
            text: TEXT,
            signer: '0x1111111111111111111111111111111111111111',
            signature: SIGNATURE,
        })
    );

    const changedSignature = `${SIGNATURE.slice(0, 2)}0${SIGNATURE.slice(3)}`;
    assertVerificationError(() =>
        verifySignedMessage({
            text: TEXT,
            signer: SIGNER,
            signature: changedSignature,
        })
    );
});

test('verifySignedMessage rejects unsupported recovery values and invalid scalars', () => {
    assertVerificationError(() =>
        verifySignedMessage({
            text: TEXT,
            signer: SIGNER,
            signature: `${SIGNATURE.slice(0, -2)}02`,
        })
    );
    assertVerificationError(() =>
        verifySignedMessage({
            text: TEXT,
            signer: SIGNER,
            signature: `0x${'0'.repeat(128)}1b`,
        })
    );
});

test('verifySignedMessage preserves schema validation errors', () => {
    assert.throws(
        () =>
            verifySignedMessage({
                text: TEXT,
                signer: SIGNER,
                signature: '0x1234',
            }),
        SignedMessageValidationError
    );
    assert.throws(
        () =>
            verifySignedMessage({
                text: 'Oya 🌱',
                signer: SIGNER,
                signature: SIGNATURE,
            }),
        (error) =>
            error instanceof SignedMessageValidationError &&
            error.code === 'invalid_text'
    );
});
