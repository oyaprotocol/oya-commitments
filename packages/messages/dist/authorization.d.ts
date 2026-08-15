import type { SignedMessageInput } from './schema.js';
type SignedMessageAuthorizationErrorCode = 'unauthorized_signer';
interface SignedMessageAuthorizer {
    readonly allowedSignerCount: number;
    authorize(input: unknown): Readonly<SignedMessageInput>;
}
declare class SignedMessageAuthorizationError extends Error {
    readonly code: SignedMessageAuthorizationErrorCode;
    readonly status: number;
    constructor();
}
declare function createSignedMessageAuthorizer(allowedSigners: readonly string[]): Readonly<SignedMessageAuthorizer>;
export { createSignedMessageAuthorizer, SignedMessageAuthorizationError, };
export type { SignedMessageAuthorizationErrorCode, SignedMessageAuthorizer, };
