import type { LogCidOptions, LogCidResult } from '@oyaprotocol/ethereum';
import type { PublishToIpfsResult } from '@oyaprotocol/ipfs';
import type { SignedMessageInput } from '../schema.js';
import type { PublishSignedMessageOptions } from './publish.js';
interface PublishAndLogSignedMessageOptions {
    ipfs: Omit<PublishSignedMessageOptions, 'signal'>;
    logger: Omit<LogCidOptions, 'signal'>;
    signal?: AbortSignal;
}
interface PublishAndLogSignedMessageResult {
    readonly publication: PublishToIpfsResult;
    readonly logging: LogCidResult;
}
declare class PublishAndLogSignedMessageError extends Error {
    readonly publication: PublishToIpfsResult;
    readonly transactionHash: string | null;
    constructor(publication: PublishToIpfsResult, cause: unknown);
}
/** Use after allowlist authorization, typically as an ingress callback. */
declare function publishAndLogSignedMessage(message: Readonly<SignedMessageInput>, { ipfs, logger, signal }: PublishAndLogSignedMessageOptions): Promise<PublishAndLogSignedMessageResult>;
export { publishAndLogSignedMessage, PublishAndLogSignedMessageError };
export type { PublishAndLogSignedMessageOptions, PublishAndLogSignedMessageResult };
