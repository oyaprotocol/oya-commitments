const ALLOWED_SIGNED_MESSAGE_FIELDS = new Set(['text', 'signer', 'signature']);
const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ETHEREUM_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const textEncoder = new TextEncoder();

interface SignedMessageInput {
    readonly text: string;
    readonly signer: string;
    readonly signature: string;
}

interface SignedMessage {
    readonly text: string;
    readonly signer: string;
    readonly signature: string;
    readonly textByteLength: number;
}

interface NormalizeSignedMessageOptions {
    readonly maxTextBytes?: number;
}

type SignedMessageValidationErrorCode =
    | 'invalid_body'
    | 'unsupported_field'
    | 'invalid_text'
    | 'text_too_large'
    | 'invalid_signer'
    | 'invalid_signature';

interface SignedMessageValidationErrorOptions {
    readonly code: SignedMessageValidationErrorCode;
    readonly message: string;
    readonly status?: number;
    readonly details?: Readonly<Record<string, unknown>>;
}

class SignedMessageValidationError extends Error {
    readonly code: SignedMessageValidationErrorCode;
    readonly status: number;
    readonly details: Readonly<Record<string, unknown>> | undefined;

    constructor({ code, message, status = 400, details }: SignedMessageValidationErrorOptions) {
        super(message);
        this.name = 'SignedMessageValidationError';
        this.code = code;
        this.status = status;
        this.details =
            details === undefined ? undefined : Object.freeze({ ...details });
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function createValidationError(
    options: SignedMessageValidationErrorOptions
): SignedMessageValidationError {
    return new SignedMessageValidationError(options);
}

function normalizeMaxTextBytes(
    options: NormalizeSignedMessageOptions | null | undefined
): number | undefined {
    const maxTextBytes = options?.maxTextBytes;
    if (maxTextBytes === undefined) {
        return undefined;
    }
    if (
        typeof maxTextBytes !== 'number' ||
        !Number.isInteger(maxTextBytes) ||
        maxTextBytes < 1
    ) {
        throw new Error('options.maxTextBytes must be a positive integer.');
    }
    return maxTextBytes;
}

function requireOnlySignedMessageFields(input: Record<string, unknown>): void {
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

function normalizeText(value: unknown, maxTextBytes: number | undefined): {
    readonly text: string;
    readonly textByteLength: number;
} {
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

    const textByteLength = textEncoder.encode(value).byteLength;
    if (maxTextBytes !== undefined && textByteLength > maxTextBytes) {
        throw createValidationError({
            code: 'text_too_large',
            message: `text exceeds maxTextBytes (${maxTextBytes}).`,
            details: {
                maxTextBytes,
                textByteLength,
            },
        });
    }

    return {
        text: value,
        textByteLength,
    };
}

function normalizeSigner(value: unknown): string {
    if (typeof value !== 'string' || !ETHEREUM_ADDRESS_PATTERN.test(value)) {
        throw createValidationError({
            code: 'invalid_signer',
            message: 'signer must be a 20-byte 0x-prefixed Ethereum address.',
        });
    }
    return value.toLowerCase();
}

function normalizeSignature(value: unknown): string {
    if (typeof value !== 'string' || !ETHEREUM_SIGNATURE_PATTERN.test(value)) {
        throw createValidationError({
            code: 'invalid_signature',
            message: 'signature must be a 65-byte 0x-prefixed Ethereum signature.',
        });
    }
    return value;
}

function normalizeSignedMessage(
    input: unknown,
    options: NormalizeSignedMessageOptions = {}
): SignedMessage {
    const maxTextBytes = normalizeMaxTextBytes(options);
    if (!isPlainObject(input)) {
        throw createValidationError({
            code: 'invalid_body',
            message: 'Request body must be a JSON object.',
        });
    }

    requireOnlySignedMessageFields(input);
    const { text, textByteLength } = normalizeText(input.text, maxTextBytes);
    const signer = normalizeSigner(input.signer);
    const signature = normalizeSignature(input.signature);

    return Object.freeze({
        text,
        signer,
        signature,
        textByteLength,
    });
}

export {
    SignedMessageValidationError,
    normalizeSignedMessage,
};
export type {
    NormalizeSignedMessageOptions,
    SignedMessage,
    SignedMessageInput,
    SignedMessageValidationErrorCode,
    SignedMessageValidationErrorOptions,
};
