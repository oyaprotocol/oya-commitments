import { assertPositiveInteger, isPlainObject } from '@oyaprotocol/utils';
const ALLOWED_SIGNED_MESSAGE_FIELDS = new Set(['text', 'signer', 'signature']);
const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ETHEREUM_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
class SignedMessageValidationError extends Error {
    code;
    status;
    details;
    constructor({ code, message, status = 400, details }) {
        super(message);
        this.name = 'SignedMessageValidationError';
        this.code = code;
        this.status = status;
        this.details =
            details === undefined ? undefined : Object.freeze({ ...details });
    }
}
function createValidationError(options) {
    return new SignedMessageValidationError(options);
}
function normalizeMaxTextBytes(options) {
    const maxTextBytes = options?.maxTextBytes;
    if (maxTextBytes === undefined) {
        return undefined;
    }
    return assertPositiveInteger(maxTextBytes, 'options.maxTextBytes');
}
function requireOnlySignedMessageFields(input) {
    for (const field of Object.keys(input)) {
        if (!ALLOWED_SIGNED_MESSAGE_FIELDS.has(field)) {
            throw createValidationError({
                code: 'unsupported_field',
                message: `Unsupported field: ${field}.`,
                details: { field },
            });
        }
    }
}
function normalizeText(value, maxTextBytes) {
    if (typeof value !== 'string') {
        throw createValidationError({
            code: 'invalid_text',
            message: 'text is required and must be a string.',
        });
    }
    if (value.length === 0) {
        throw createValidationError({
            code: 'invalid_text',
            message: 'text must be non-empty.',
        });
    }
    if (maxTextBytes !== undefined) {
        const textByteLength = new TextEncoder().encode(value).byteLength;
        if (textByteLength > maxTextBytes) {
            throw createValidationError({
                code: 'text_too_large',
                message: `text exceeds maxTextBytes (${maxTextBytes}).`,
                details: {
                    maxTextBytes,
                    textByteLength,
                },
            });
        }
    }
    return value;
}
function normalizeSigner(value) {
    if (typeof value !== 'string' || !ETHEREUM_ADDRESS_PATTERN.test(value)) {
        throw createValidationError({
            code: 'invalid_signer',
            message: 'signer must be a 20-byte 0x-prefixed Ethereum address.',
        });
    }
    return value.toLowerCase();
}
function normalizeSignature(value) {
    if (typeof value !== 'string' || !ETHEREUM_SIGNATURE_PATTERN.test(value)) {
        throw createValidationError({
            code: 'invalid_signature',
            message: 'signature must be a 65-byte 0x-prefixed Ethereum signature.',
        });
    }
    return value;
}
function normalizeSignedMessage(input, options = {}) {
    const maxTextBytes = normalizeMaxTextBytes(options);
    if (!isPlainObject(input)) {
        throw createValidationError({
            code: 'invalid_body',
            message: 'Request body must be a JSON object.',
        });
    }
    requireOnlySignedMessageFields(input);
    const text = normalizeText(input.text, maxTextBytes);
    const signer = normalizeSigner(input.signer);
    const signature = normalizeSignature(input.signature);
    return Object.freeze({
        text,
        signer,
        signature,
    });
}
export { SignedMessageValidationError, normalizeSignedMessage, };
//# sourceMappingURL=schema.js.map