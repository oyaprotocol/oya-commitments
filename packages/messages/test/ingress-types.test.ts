import { handleSignedMessage } from '../dist/index.js';
import type {
    AcceptedSignedMessageHandler,
    HandleSignedMessageOptions,
    HandleSignedMessageOptionsWithHandler,
    HandleSignedMessageOptionsWithOptionalHandler,
    HandleSignedMessageRequest,
    SignedMessageAuthorizer,
} from '../dist/index.js';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() =>
        Value extends Right ? 1 : 2)
        ? true
        : false;
type Expect<Value extends true> = Value;
type IsRequired<Value, Key extends keyof Value> = {} extends Pick<Value, Key>
    ? false
    : true;

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
type CallbackAcceptedResult = Extract<CallbackResult, { status: 202 }>;
type CallbackValueIsExact = Expect<
    Equal<
        CallbackAcceptedResult['handleSignedMessageResult'],
        { cid: string }
    >
>;
type CallbackPropertyIsRequired = Expect<
    IsRequired<CallbackAcceptedResult, 'handleSignedMessageResult'>
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
type PromisedHandlerAcceptedResult = Extract<
    PromisedHandlerResult,
    { status: 202 }
>;
type PromisedHandlerValueIsAwaited = Expect<
    Equal<
        PromisedHandlerAcceptedResult['handleSignedMessageResult'],
        { cid: string }
    >
>;
type PromisedHandlerPropertyIsRequired = Expect<
    IsRequired<PromisedHandlerAcceptedResult, 'handleSignedMessageResult'>
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
type UndefinedAcceptedResult = Extract<UndefinedResult, { status: 202 }>;
type UndefinedValueIsExact = Expect<
    Equal<UndefinedAcceptedResult['handleSignedMessageResult'], undefined>
>;
type UndefinedPropertyIsRequired = Expect<
    IsRequired<UndefinedAcceptedResult, 'handleSignedMessageResult'>
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
const dynamicOptions: HandleSignedMessageOptionsWithOptionalHandler<{
    cid: string;
}> = {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage: dynamicHandler,
};
const dynamicResultPromise = handleSignedMessage(request, dynamicOptions);

declare const unionOptions:
    | HandleSignedMessageOptions
    | HandleSignedMessageOptionsWithHandler<{ cid: string }>;
const unionResultPromise = handleSignedMessage(request, unionOptions);

async function checkNarrowing(): Promise<void> {
    const callbackAbsentResult = await callbackAbsentPromise;
    if (callbackAbsentResult.status === 202) {
        // @ts-expect-error Callback-absent results do not expose this property.
        callbackAbsentResult.handleSignedMessageResult;
    } else {
        // @ts-expect-error Rejections do not expose this property.
        callbackAbsentResult.handleSignedMessageResult;
    }

    const explicitlyUndefinedResult = await explicitlyUndefinedPromise;
    if (explicitlyUndefinedResult.status === 202) {
        // @ts-expect-error Explicit undefined selects the callback-absent overload.
        explicitlyUndefinedResult.handleSignedMessageResult;
    }

    const callbackResult = await callbackResultPromise;
    if (callbackResult.status === 202) {
        const exactCallbackValue: { cid: string } =
            callbackResult.handleSignedMessageResult;
        void exactCallbackValue;
    } else {
        // @ts-expect-error Rejections from callback-present calls have no result value.
        callbackResult.handleSignedMessageResult;
    }

    const promisedHandlerResult = await promisedHandlerResultPromise;
    if (promisedHandlerResult.status === 202) {
        const exactPromisedHandlerValue: { cid: string } =
            promisedHandlerResult.handleSignedMessageResult;
        // @ts-expect-error Runtime await removes Promise methods from the value.
        promisedHandlerResult.handleSignedMessageResult.then;
        void exactPromisedHandlerValue;
    }

    const dynamicResult = await dynamicResultPromise;
    if (dynamicResult.status === 202) {
        // @ts-expect-error Dynamic options require property-presence narrowing.
        dynamicResult.handleSignedMessageResult;
        if ('handleSignedMessageResult' in dynamicResult) {
            const exactDynamicValue: { cid: string } =
                dynamicResult.handleSignedMessageResult;
            void exactDynamicValue;
        }
    } else {
        // @ts-expect-error Rejections from dynamic calls have no result value.
        dynamicResult.handleSignedMessageResult;
    }

    const unionResult = await unionResultPromise;
    if (
        unionResult.status === 202 &&
        'handleSignedMessageResult' in unionResult
    ) {
        const exactUnionValue: { cid: string } =
            unionResult.handleSignedMessageResult;
        void exactUnionValue;
    }
}

const typeAssertions: readonly [
    CallbackValueIsExact,
    CallbackPropertyIsRequired,
    PromisedHandlerValueIsAwaited,
    PromisedHandlerPropertyIsRequired,
    UndefinedValueIsExact,
    UndefinedPropertyIsRequired,
] = [true, true, true, true, true, true];

void checkNarrowing;
void typeAssertions;
