import type { SignedMessageInput } from './schema.js';
type SignedMessageVerificationErrorCode = 'invalid_signature';
declare class SignedMessageVerificationError extends Error {
    readonly code: SignedMessageVerificationErrorCode;
    readonly status: 401;
    constructor();
}
declare function verifySignedMessage(input: unknown): Readonly<SignedMessageInput>;
export { SignedMessageVerificationError, verifySignedMessage, };
export type { SignedMessageVerificationErrorCode, };
