interface SignedMessageInput {
    readonly text: string;
    readonly signer: string;
    readonly signature: string;
}
type SignedMessageValidationErrorCode = 'invalid_body' | 'unsupported_field' | 'invalid_text' | 'invalid_signer' | 'invalid_signature';
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
declare function validateSignedMessage(input: unknown): Readonly<{
    text: string;
    signer: string;
    signature: string;
}>;
export { SignedMessageValidationError, validateSignedMessage, };
export type { SignedMessageInput, SignedMessageValidationErrorCode, SignedMessageValidationErrorOptions, };
