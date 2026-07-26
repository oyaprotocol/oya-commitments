import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import {
    bytesToHex,
    concatBytes,
    hexToBytes,
    utf8ToBytes,
} from '@noble/hashes/utils';

import { validateSignedMessage } from './schema.js';
import type { SignedMessageInput } from './schema.js';

const ETHEREUM_SIGNED_MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';

type SignedMessageVerificationErrorCode = 'invalid_signature';

class SignedMessageVerificationError extends Error {
    readonly code: SignedMessageVerificationErrorCode;
    readonly status: number;

    constructor() {
        super('signature must be a valid EIP-191 signature for signer.');
        this.name = 'SignedMessageVerificationError';
        this.code = 'invalid_signature';
        this.status = 401;
    }
}

function normalizeRecoveryBit(value: number): 0 | 1 {
    if (value === 27) {
        return 0;
    }
    if (value === 28) {
        return 1;
    }
    if (value === 0 || value === 1) {
        return value;
    }
    throw new Error('Unsupported Ethereum signature recovery value.');
}

function createEthereumSignedMessageDigest(text: string): Uint8Array {
    const textBytes = utf8ToBytes(text);
    const prefixBytes = utf8ToBytes(
        `${ETHEREUM_SIGNED_MESSAGE_PREFIX}${textBytes.byteLength}`
    );
    return keccak_256(concatBytes(prefixBytes, textBytes));
}

function recoverEthereumAddress(text: string, signature: string): string {
    const signatureBytes = hexToBytes(signature.slice(2));
    const recoveryBit = normalizeRecoveryBit(signatureBytes[64]);
    const publicKey = secp256k1.Signature
        .fromCompact(signatureBytes.subarray(0, 64))
        .addRecoveryBit(recoveryBit)
        .recoverPublicKey(createEthereumSignedMessageDigest(text))
        .toRawBytes(false);
    const addressHash = keccak_256(publicKey.subarray(1));
    return `0x${bytesToHex(addressHash.subarray(addressHash.length - 20))}`;
}

function verifySignedMessage(input: unknown): Readonly<SignedMessageInput> {
    const message = validateSignedMessage(input);
    let recoveredAddress: string;

    try {
        recoveredAddress = recoverEthereumAddress(message.text, message.signature);
    } catch {
        throw new SignedMessageVerificationError();
    }

    if (recoveredAddress.toLowerCase() !== message.signer.toLowerCase()) {
        throw new SignedMessageVerificationError();
    }

    return message;
}

export {
    SignedMessageVerificationError,
    verifySignedMessage,
};
export type {
    SignedMessageVerificationErrorCode,
};
