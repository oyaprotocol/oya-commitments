import type { SignedMessageAuthorizer } from './authorization.js';
import type { SignedMessageInput } from './schema.js';
interface HandleSignedMessageRequest {
    readonly method: string;
    readonly contentType: string | undefined;
    readonly body: Uint8Array;
}
type AcceptedSignedMessageHandler<TResult = unknown> = (message: Readonly<SignedMessageInput>) => TResult | PromiseLike<TResult>;
interface HandleSignedMessageBaseOptions {
    readonly authorize: SignedMessageAuthorizer;
    readonly maxBodyBytes: number;
    readonly maxTextBytes: number;
}
interface HandleSignedMessageOptions extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage?: undefined;
}
interface HandleSignedMessageOptionsWithHandler<TResult> extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage: AcceptedSignedMessageHandler<TResult>;
}
interface HandleSignedMessageOptionsWithOptionalHandler<TResult> extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage?: AcceptedSignedMessageHandler<TResult> | undefined;
}
interface AcceptedSignedMessage {
    readonly status: 202;
    readonly body: Readonly<{
        status: 'accepted';
        signer: string;
    }>;
    readonly message: Readonly<SignedMessageInput>;
}
interface AcceptedSignedMessageWithHandler<TResult> extends AcceptedSignedMessage {
    readonly handleSignedMessageResult: TResult;
}
interface RejectedSignedMessage {
    readonly status: 400 | 401 | 403 | 405 | 413 | 415;
    readonly body: Readonly<{
        error: string;
        code: string;
        details?: Readonly<Record<string, unknown>>;
    }>;
}
type HandleSignedMessageResult<TResult = never> = RejectedSignedMessage | ([TResult] extends [never] ? AcceptedSignedMessage : AcceptedSignedMessageWithHandler<TResult>);
declare function handleSignedMessage(request: HandleSignedMessageRequest, options: HandleSignedMessageOptions): Promise<HandleSignedMessageResult>;
declare function handleSignedMessage<TResult>(request: HandleSignedMessageRequest, options: HandleSignedMessageOptionsWithHandler<TResult>): Promise<HandleSignedMessageResult<TResult>>;
declare function handleSignedMessage<TResult>(request: HandleSignedMessageRequest, options: HandleSignedMessageOptionsWithOptionalHandler<TResult>): Promise<HandleSignedMessageResult | HandleSignedMessageResult<TResult>>;
export { handleSignedMessage };
export type { AcceptedSignedMessageHandler, HandleSignedMessageOptions, HandleSignedMessageOptionsWithHandler, HandleSignedMessageOptionsWithOptionalHandler, HandleSignedMessageRequest, HandleSignedMessageResult, };
