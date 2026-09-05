import { handleSignedMessage } from '../dist/index.js';
import type {
    AcceptedSignedMessageHandler,
    HandleSignedMessageOptions,
    HandleSignedMessageRequest,
    SignedMessageAuthorizer,
} from '../dist/index.js';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() =>
        Value extends Right ? 1 : 2)
        ? true
        : false;
type Expect<Value extends true> = Value;
type AcceptedResult<Result> = Extract<Result, { status: 202 }>;

declare const request: HandleSignedMessageRequest;
declare const authorize: SignedMessageAuthorizer;

const callbackResultPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    async onAcceptedMessage() {
        return { cid: 'bafy-callback-result' };
    },
});
type CallbackResult = Awaited<typeof callbackResultPromise>;
type CallbackValueIsExact = Expect<
    Equal<
        AcceptedResult<CallbackResult>['handleSignedMessageResult'],
        { cid: string } | undefined
    >
>;

const explicitlyPromisedHandler: AcceptedSignedMessageHandler<
    Promise<{ cid: string }>
> = async (message) => {
    void message;
    return { cid: 'bafy-explicit-promise-result' };
};
const promisedHandlerResultPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage: explicitlyPromisedHandler,
});
type PromisedHandlerResult = Awaited<typeof promisedHandlerResultPromise>;
type PromisedHandlerValueIsAwaited = Expect<
    Equal<
        AcceptedResult<PromisedHandlerResult>['handleSignedMessageResult'],
        { cid: string } | undefined
    >
>;

const undefinedResultPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage() {
        return undefined;
    },
});
type UndefinedResult = Awaited<typeof undefinedResultPromise>;
type UndefinedValueIsExact = Expect<
    Equal<
        AcceptedResult<UndefinedResult>['handleSignedMessageResult'],
        undefined
    >
>;

const callbackAbsentPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
});
const explicitlyUndefinedPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage: undefined,
});

declare const dynamicHandler:
    | AcceptedSignedMessageHandler<{ cid: string }>
    | undefined;
const dynamicOptions: HandleSignedMessageOptions<{ cid: string }> = {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage: dynamicHandler,
};
const dynamicResultPromise = handleSignedMessage(request, dynamicOptions);

async function checkNarrowing(): Promise<void> {
    const callbackResult = await callbackResultPromise;
    if (callbackResult.status === 202) {
        const optionalCallbackValue: { cid: string } | undefined =
            callbackResult.handleSignedMessageResult;
        const optionalCid: string | undefined =
            callbackResult.handleSignedMessageResult?.cid;
        // @ts-expect-error Acceptance alone does not guarantee a handler result.
        const requiredCallbackValue: { cid: string } =
            callbackResult.handleSignedMessageResult;
        void optionalCallbackValue;
        void optionalCid;
        void requiredCallbackValue;
        if ('handleSignedMessageResult' in callbackResult) {
            const exactCallbackValue: { cid: string } =
                callbackResult.handleSignedMessageResult;
            void exactCallbackValue;
        }
    } else {
        // @ts-expect-error Rejections do not expose the handler result property.
        callbackResult.handleSignedMessageResult;
    }

    const promisedHandlerResult = await promisedHandlerResultPromise;
    if (
        promisedHandlerResult.status === 202 &&
        'handleSignedMessageResult' in promisedHandlerResult
    ) {
        const exactPromisedHandlerValue: { cid: string } =
            promisedHandlerResult.handleSignedMessageResult;
        // @ts-expect-error Runtime await removes Promise methods from the value.
        promisedHandlerResult.handleSignedMessageResult.then;
        void exactPromisedHandlerValue;
    }

    const undefinedResult = await undefinedResultPromise;
    if (undefinedResult.status === 202) {
        const optionalUndefinedValue: undefined =
            undefinedResult.handleSignedMessageResult;
        void optionalUndefinedValue;
        if ('handleSignedMessageResult' in undefinedResult) {
            const exactUndefinedValue: undefined =
                undefinedResult.handleSignedMessageResult;
            void exactUndefinedValue;
        }
    }

    const callbackAbsentResult = await callbackAbsentPromise;
    if (callbackAbsentResult.status === 202) {
        callbackAbsentResult.handleSignedMessageResult;
    }

    const explicitlyUndefinedResult = await explicitlyUndefinedPromise;
    if (explicitlyUndefinedResult.status === 202) {
        explicitlyUndefinedResult.handleSignedMessageResult;
    }

    const dynamicResult = await dynamicResultPromise;
    if (dynamicResult.status === 202) {
        const optionalDynamicValue: { cid: string } | undefined =
            dynamicResult.handleSignedMessageResult;
        void optionalDynamicValue;
        if ('handleSignedMessageResult' in dynamicResult) {
            const exactDynamicValue: { cid: string } =
                dynamicResult.handleSignedMessageResult;
            void exactDynamicValue;
        }
    }
}

const typeAssertions: readonly [
    CallbackValueIsExact,
    PromisedHandlerValueIsAwaited,
    UndefinedValueIsExact,
] = [true, true, true];

void checkNarrowing;
void typeAssertions;
