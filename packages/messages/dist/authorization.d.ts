import type { SignedMessageInput } from './schema.js';
type SignedMessageAuthorizationErrorCode = 'unauthorized_signer';
declare class SignedMessageAuthorizationError extends Error {
    readonly code: SignedMessageAuthorizationErrorCode;
    readonly status: number;
    constructor();
}
declare function authorizeSignedMessage(input: unknown, allowedSigners: readonly string[]): Readonly<SignedMessageInput>;
export { authorizeSignedMessage, SignedMessageAuthorizationError, };
export type { SignedMessageAuthorizationErrorCode, };
