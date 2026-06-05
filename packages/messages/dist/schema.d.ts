declare const DEFAULT_MAX_TEXT_BYTES = 4096;
type EthereumAddress = `0x${string}`;
type EthereumSignature = `0x${string}`;
interface SignedMessageInput {
    readonly text: string;
    readonly signer: string;
    readonly signature: string;
}
interface SignedMessage {
    readonly text: string;
    readonly signer: EthereumAddress;
    readonly signature: EthereumSignature;
    readonly textByteLength: number;
}
interface NormalizeSignedMessageOptions {
    readonly maxTextBytes?: number;
}
type SignedMessageValidationErrorCode = 'invalid_body' | 'unsupported_field' | 'invalid_text' | 'text_too_large' | 'invalid_signer' | 'invalid_signature';
interface SignedMessageValidationErrorOptions {
    readonly code: SignedMessageValidationErrorCode;
    readonly message: string;
    readonly status?: number;
    readonly details?: Readonly<Record<string, unknown>>;
}
declare class SignedMessageValidationError extends Error {
    readonly code: SignedMessageValidationErrorCode;
    readonly status: number;
    readonly details: Readonly<Record<string, unknown>> | undefined;
    constructor({ code, message, status, details }: SignedMessageValidationErrorOptions);
}
declare function normalizeSignedMessage(input: unknown, options?: NormalizeSignedMessageOptions): SignedMessage;
export { DEFAULT_MAX_TEXT_BYTES, SignedMessageValidationError, normalizeSignedMessage, };
export type { EthereumAddress, EthereumSignature, NormalizeSignedMessageOptions, SignedMessage, SignedMessageInput, SignedMessageValidationErrorCode, SignedMessageValidationErrorOptions, };
