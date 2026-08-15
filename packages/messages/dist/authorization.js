import { verifySignedMessage } from './ethereum-signature.js';
const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
class SignedMessageAuthorizationError extends Error {
    code;
    status;
    constructor() {
        super('signer is not authorized.');
        this.name = 'SignedMessageAuthorizationError';
        this.code = 'unauthorized_signer';
        this.status = 403;
    }
}
function requireEthereumAddress(value, label) {
    if (typeof value !== 'string' || !ETHEREUM_ADDRESS_PATTERN.test(value)) {
        throw new TypeError(`${label} must be a 20-byte 0x-prefixed Ethereum address.`);
    }
    return value;
}
function normalizeAllowedSigners(allowedSigners) {
    if (!Array.isArray(allowedSigners)) {
        throw new TypeError('allowedSigners must be an array.');
    }
    const normalizedSigners = new Set();
    for (const [index, allowedSigner] of allowedSigners.entries()) {
        normalizedSigners.add(requireEthereumAddress(allowedSigner, `allowedSigners[${index}]`).toLowerCase());
    }
    return normalizedSigners;
}
function authorizeSignedMessage(input, allowedSigners) {
    const normalizedSigners = normalizeAllowedSigners(allowedSigners);
    const message = verifySignedMessage(input);
    if (!normalizedSigners.has(message.signer.toLowerCase())) {
        throw new SignedMessageAuthorizationError();
    }
    return message;
}
export { authorizeSignedMessage, SignedMessageAuthorizationError, };
//# sourceMappingURL=authorization.js.map