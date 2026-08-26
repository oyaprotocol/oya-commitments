import type { SignedMessageInput } from './schema.js';
type SignedMessageAuthorizationErrorCode = 'unauthorized_signer';
type SignedMessageAuthorizer = (input: unknown) => Readonly<SignedMessageInput>;
declare class SignedMessageAuthorizationError extends Error {
    readonly code: SignedMessageAuthorizationErrorCode;
    readonly status: 403;
    constructor();
}
declare function createSignedMessageAuthorizer(allowedSigners: readonly string[]): SignedMessageAuthorizer;
export { createSignedMessageAuthorizer, SignedMessageAuthorizationError, };
export type { SignedMessageAuthorizationErrorCode, SignedMessageAuthorizer, };
