import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes, } from '@noble/hashes/utils.js';
import { validateSignedMessage } from './schema.js';
const ETHEREUM_SIGNED_MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';
class SignedMessageVerificationError extends Error {
    code;
    status = 401;
    constructor() {
        super('signature must be a valid EIP-191 signature for signer.');
        this.name = 'SignedMessageVerificationError';
        this.code = 'invalid_signature';
    }
}
function normalizeRecoveryBit(value) {
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
function createEthereumSignedMessageDigest(text) {
    const textBytes = utf8ToBytes(text);
    const prefixBytes = utf8ToBytes(`${ETHEREUM_SIGNED_MESSAGE_PREFIX}${textBytes.byteLength}`);
    return keccak_256(concatBytes(prefixBytes, textBytes));
}
function recoverEthereumAddress(text, signature) {
    const signatureBytes = hexToBytes(signature.slice(2));
    const recoveryBit = normalizeRecoveryBit(signatureBytes[64]);
    const recoverableSignature = new Uint8Array(65);
    // Noble uses recovery || r || s; Ethereum serializes r || s || v.
    recoverableSignature[0] = recoveryBit;
    recoverableSignature.set(signatureBytes.subarray(0, 64), 1);
    // The message is already the EIP-191 Keccak-256 digest.
    const compressedPublicKey = secp256k1.recoverPublicKey(recoverableSignature, createEthereumSignedMessageDigest(text), { prehash: false });
    const publicKey = secp256k1.Point
        .fromBytes(compressedPublicKey)
        .toBytes(false);
    const addressHash = keccak_256(publicKey.subarray(1));
    return `0x${bytesToHex(addressHash.subarray(addressHash.length - 20))}`;
}
function verifySignedMessage(input) {
    const message = validateSignedMessage(input);
    let recoveredAddress;
    try {
        recoveredAddress = recoverEthereumAddress(message.text, message.signature);
    }
    catch {
        throw new SignedMessageVerificationError();
    }
    if (recoveredAddress.toLowerCase() !== message.signer.toLowerCase()) {
        throw new SignedMessageVerificationError();
    }
    return message;
}
export { SignedMessageVerificationError, verifySignedMessage, };
//# sourceMappingURL=ethereum-signature.js.map