import { handleSignedMessage, publishSignedMessage } from '@oyaprotocol/messages';
import type {
    AcceptedSignedMessageHandler,
    HandleSignedMessageRequest,
    PublishSignedMessageOptions,
    SignedMessageAuthorizer,
    SignedMessageInput,
} from '@oyaprotocol/messages';
import type { PublishToIpfsResult } from '@oyaprotocol/ipfs';

declare const message: Readonly<SignedMessageInput>;
declare const options: PublishSignedMessageOptions;
declare const request: HandleSignedMessageRequest;
declare const authorize: SignedMessageAuthorizer;
declare const signal: AbortSignal;

const publisher: AcceptedSignedMessageHandler<PublishToIpfsResult> = (input) =>
    publishSignedMessage(input, options);

const directResult: Promise<PublishToIpfsResult> =
    publishSignedMessage(message, { ...options, signal });

// @ts-expect-error Publication always requires an explicit fetch implementation.
publishSignedMessage(message, { config: options.config });
// @ts-expect-error Publication always requires explicit transport configuration.
publishSignedMessage(message, { fetch: options.fetch });
// @ts-expect-error Artifact metadata is defined by the message format.
publishSignedMessage(message, { ...options, filename: 'override.json' });

const resultPromise = handleSignedMessage(request, {
    authorize,
    maxBodyBytes: 4096,
    maxTextBytes: 1024,
    onAcceptedMessage: (input) => publishSignedMessage(input, options),
});

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() =>
        Value extends Right ? 1 : 2)
        ? true
        : false;
type Expect<Value extends true> = Value;
type InferredPublicationResult = Expect<
    Equal<
        Extract<Awaited<typeof resultPromise>, { status: 202 }>['handleSignedMessageResult'],
        PublishToIpfsResult | undefined
    >
>;

async function checkPublicationResult(): Promise<void> {
    const result = await resultPromise;
    if (result.status === 202 && result.handleSignedMessageResult !== undefined) {
        const cid: string = result.handleSignedMessageResult.cid;
        const pinned: true = result.handleSignedMessageResult.pinned;
        // @ts-expect-error The callback result has already been awaited.
        result.handleSignedMessageResult.then;
        void cid;
        void pinned;
    }
}

const typeAssertion: InferredPublicationResult = true;
void publisher;
void directResult;
void checkPublicationResult;
void typeAssertion;
