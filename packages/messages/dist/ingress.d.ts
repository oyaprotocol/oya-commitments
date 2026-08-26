import type { SignedMessageAuthorizer } from './authorization.js';
import type { SignedMessageInput } from './schema.js';
interface HandleSignedMessageRequest {
    readonly method: string;
    readonly contentType: string | undefined;
    readonly body: Uint8Array;
}
interface HandleSignedMessageOptions {
    readonly authorize: SignedMessageAuthorizer;
    readonly maxBodyBytes: number;
    readonly maxTextBytes: number;
}
type SignedMessageHttpErrorCode = 'method_not_allowed' | 'unsupported_content_type' | 'body_too_large' | 'invalid_json' | 'text_too_large';
interface AcceptedSignedMessage {
    readonly status: 202;
    readonly body: Readonly<{
        status: 'accepted';
        signer: string;
    }>;
    readonly message: Readonly<SignedMessageInput>;
}
interface RejectedSignedMessage {
    readonly status: 400 | 401 | 403 | 405 | 413 | 415;
    readonly body: Readonly<{
        error: string;
        code: string;
        details?: Readonly<Record<string, unknown>>;
    }>;
}
type HandleSignedMessageResult = AcceptedSignedMessage | RejectedSignedMessage;
declare function handleSignedMessage(request: HandleSignedMessageRequest, options: HandleSignedMessageOptions): HandleSignedMessageResult;
export { handleSignedMessage };
export type { AcceptedSignedMessage, HandleSignedMessageOptions, HandleSignedMessageRequest, HandleSignedMessageResult, RejectedSignedMessage, SignedMessageHttpErrorCode, };
