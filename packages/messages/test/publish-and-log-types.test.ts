import { handleSignedMessage, publishAndLogSignedMessage, PublishAndLogSignedMessageError } from '@oyaprotocol/messages';
import type {
    AcceptedSignedMessageHandler, HandleSignedMessageRequest, SignedMessageAuthorizer, SignedMessageInput,
    PublishAndLogSignedMessageOptions, PublishAndLogSignedMessageResult,
} from '@oyaprotocol/messages';

declare const options: PublishAndLogSignedMessageOptions;
declare const request: HandleSignedMessageRequest;
declare const message: Readonly<SignedMessageInput>;
declare const authorize: SignedMessageAuthorizer;
declare const error: PublishAndLogSignedMessageError;

const callback: AcceptedSignedMessageHandler<PublishAndLogSignedMessageResult> = (accepted) =>
    publishAndLogSignedMessage(accepted, options);
const direct: Promise<PublishAndLogSignedMessageResult> = publishAndLogSignedMessage(message, options);
const result = await handleSignedMessage(request, {
    authorize, maxBodyBytes: 4096, maxTextBytes: 1024,
    onAcceptedMessage: (accepted) => publishAndLogSignedMessage(accepted, options),
});
if (result.status === 202 && result.handleSignedMessageResult !== undefined) {
    const publicationCid: string = result.handleSignedMessageResult.publication.cid;
    const transactionHash: string = result.handleSignedMessageResult.logging.transactionHash;
    const blockNumber: bigint = result.handleSignedMessageResult.logging.receipt.blockNumber;
    const loggedCid: string = result.handleSignedMessageResult.logging.event.cid;
    void [publicationCid, transactionHash, blockNumber, loggedCid];
}
const partialCid: string = error.publication.cid;
const partialHash: string | null = error.transactionHash;
// @ts-expect-error Both stages require explicit host dependencies.
publishAndLogSignedMessage(message, { ipfs: options.ipfs });
// @ts-expect-error The message payload determines the published bytes.
publishAndLogSignedMessage(message, { ...options, content: 'replacement' });
void [callback, direct, partialCid, partialHash];
