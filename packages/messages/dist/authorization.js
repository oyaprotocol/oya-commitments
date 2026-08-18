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
function normalizeAllowedSigners(allowedSigners) {
    if (!Array.isArray(allowedSigners)) {
        throw new TypeError('allowedSigners must be an array.');
    }
    const normalizedSigners = new Set();
    for (const [index, allowedSigner] of allowedSigners.entries()) {
        if (typeof allowedSigner !== 'string' ||
            !ETHEREUM_ADDRESS_PATTERN.test(allowedSigner)) {
            throw new TypeError(`allowedSigners[${index}] must be a 20-byte 0x-prefixed Ethereum address.`);
        }
        normalizedSigners.add(allowedSigner.toLowerCase());
    }
    return normalizedSigners;
}
function createSignedMessageAuthorizer(allowedSigners) {
    const normalizedSigners = normalizeAllowedSigners(allowedSigners);
    const authorizeSignedMessage = (input) => {
        const message = verifySignedMessage(input);
        if (!normalizedSigners.has(message.signer.toLowerCase())) {
            throw new SignedMessageAuthorizationError();
        }
        return message;
    };
    return Object.freeze(authorizeSignedMessage);
}
export { createSignedMessageAuthorizer, SignedMessageAuthorizationError, };
//# sourceMappingURL=authorization.js.map