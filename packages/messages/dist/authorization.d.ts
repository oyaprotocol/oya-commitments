type SignedMessageAuthorizationErrorCode = 'unauthorized_signer';
declare class SignedMessageAuthorizationError extends Error {
    readonly code: SignedMessageAuthorizationErrorCode;
    readonly status: number;
    constructor();
}
declare function authorizeMessageSigner(signer: string, allowedSigners: readonly string[]): string;
export { authorizeMessageSigner, SignedMessageAuthorizationError, };
export type { SignedMessageAuthorizationErrorCode, };
