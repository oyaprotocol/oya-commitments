const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

type SignedMessageAuthorizationErrorCode = 'unauthorized_signer';

class SignedMessageAuthorizationError extends Error {
    readonly code: SignedMessageAuthorizationErrorCode;
    readonly status: number;

    constructor() {
        super('signer is not authorized.');
        this.name = 'SignedMessageAuthorizationError';
        this.code = 'unauthorized_signer';
        this.status = 403;
    }
}

function requireEthereumAddress(value: unknown, label: string): string {
    if (typeof value !== 'string' || !ETHEREUM_ADDRESS_PATTERN.test(value)) {
        throw new TypeError(
            `${label} must be a 20-byte 0x-prefixed Ethereum address.`
        );
    }
    return value;
}

function normalizeAllowedSigners(
    allowedSigners: readonly string[]
): ReadonlySet<string> {
    if (!Array.isArray(allowedSigners)) {
        throw new TypeError('allowedSigners must be an array.');
    }

    const normalizedSigners = new Set<string>();
    for (const [index, allowedSigner] of allowedSigners.entries()) {
        normalizedSigners.add(
            requireEthereumAddress(
                allowedSigner,
                `allowedSigners[${index}]`
            ).toLowerCase()
        );
    }
    return normalizedSigners;
}

function authorizeMessageSigner(
    signer: string,
    allowedSigners: readonly string[]
): string {
    const validatedSigner = requireEthereumAddress(signer, 'signer');
    const normalizedSigners = normalizeAllowedSigners(allowedSigners);
    if (!normalizedSigners.has(validatedSigner.toLowerCase())) {
        throw new SignedMessageAuthorizationError();
    }
    return validatedSigner;
}

export {
    authorizeMessageSigner,
    SignedMessageAuthorizationError,
};
export type {
    SignedMessageAuthorizationErrorCode,
};
