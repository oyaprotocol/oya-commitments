import { isPlainObject } from '@oyaprotocol/utils';
const ALLOWED_SIGNED_MESSAGE_FIELDS = new Set(['text', 'signer', 'signature']);
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
function requireSignedMessageFields(input) {
    if (!Object.hasOwn(input, 'text')) {
        throw createValidationError({
            code: 'invalid_text',
            message: 'text is required and must be a string.',
        });
    }
    if (!Object.hasOwn(input, 'signer')) {
        throw createValidationError({
            code: 'invalid_signer',
            message: 'signer must be a 20-byte 0x-prefixed Ethereum address.',
        });
    }
    if (!Object.hasOwn(input, 'signature')) {
        throw createValidationError({
            code: 'invalid_signature',
            message: 'signature must be a 65-byte 0x-prefixed Ethereum signature.',
        });
    }
}
function validateText(value) {
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
    return value;
}
function validateSigner(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw createValidationError({
            code: 'invalid_signer',
            message: 'signer must be a 20-byte 0x-prefixed Ethereum address.',
        });
    }
    return value;
}
function validateSignature(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
        throw createValidationError({
            code: 'invalid_signature',
            message: 'signature must be a 65-byte 0x-prefixed Ethereum signature.',
        });
    }
    return value;
}
function validateSignedMessage(input) {
    if (!isPlainObject(input)) {
        throw createValidationError({
            code: 'invalid_body',
            message: 'Request body must be a JSON object.',
        });
    }
    requireOnlySignedMessageFields(input);
    requireSignedMessageFields(input);
    const text = validateText(input.text);
    const signer = validateSigner(input.signer);
    const signature = validateSignature(input.signature);
    return Object.freeze({
        text,
        signer,
        signature,
    });
}
export { SignedMessageValidationError, validateSignedMessage, };
//# sourceMappingURL=schema.js.map