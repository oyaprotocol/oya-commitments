import type { SignedMessageAuthorizer } from './authorization.js';
import type { SignedMessageInput } from './schema.js';
interface HandleSignedMessageRequest {
    readonly method: string;
    readonly contentType: string | undefined;
    readonly body: Uint8Array;
}
type AcceptedSignedMessageHandler<TResult = unknown> = (message: Readonly<SignedMessageInput>) => TResult | PromiseLike<TResult>;
interface HandleSignedMessageOptions<TResult = unknown> {
    readonly authorize: SignedMessageAuthorizer;
    readonly maxBodyBytes: number;
    readonly maxTextBytes: number;
    readonly onAcceptedMessage?: AcceptedSignedMessageHandler<TResult> | undefined;
}
interface AcceptedSignedMessage<TResult = unknown> {
    readonly status: 202;
    readonly body: Readonly<{
        status: 'accepted';
        signer: string;
    }>;
    readonly message: Readonly<SignedMessageInput>;
    readonly handleSignedMessageResult?: Awaited<TResult>;
}
interface RejectedSignedMessage {
    readonly status: 400 | 401 | 403 | 405 | 413 | 415;
    readonly body: Readonly<{
        error: string;
        code: string;
        details?: Readonly<Record<string, unknown>>;
    }>;
}
type HandleSignedMessageResult<TResult = unknown> = RejectedSignedMessage | AcceptedSignedMessage<TResult>;
declare function handleSignedMessage<TResult = unknown>(request: HandleSignedMessageRequest, options: HandleSignedMessageOptions<TResult>): Promise<HandleSignedMessageResult<TResult>>;
export { handleSignedMessage };
export type { AcceptedSignedMessageHandler, HandleSignedMessageOptions, HandleSignedMessageRequest, HandleSignedMessageResult, };
