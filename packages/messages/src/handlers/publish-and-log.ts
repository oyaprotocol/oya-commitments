import { logCid, LogCidError } from '@oyaprotocol/ethereum';
import type { LogCidOptions, LogCidResult } from '@oyaprotocol/ethereum';
import type { PublishToIpfsResult } from '@oyaprotocol/ipfs';

import type { SignedMessageInput } from '../schema.js';
import { publishSignedMessage } from './publish.js';
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

class PublishAndLogSignedMessageError extends Error {
    readonly publication: PublishToIpfsResult;
    readonly transactionHash: string | null;

    constructor(publication: PublishToIpfsResult, cause: unknown) {
        super('Message was published to IPFS, but CID logging did not complete.', { cause });
        this.name = 'PublishAndLogSignedMessageError';
        this.publication = publication;
        this.transactionHash = cause instanceof LogCidError ? cause.transactionHash : null;
    }
}

/** Use after allowlist authorization, typically as an ingress callback. */
async function publishAndLogSignedMessage(
    message: Readonly<SignedMessageInput>,
    { ipfs, logger, signal }: PublishAndLogSignedMessageOptions
): Promise<PublishAndLogSignedMessageResult> {
    const ipfsOptions: PublishSignedMessageOptions = { ...ipfs };
    const loggerOptions: LogCidOptions = { ...logger };
    // Omit only narrows types; reused stage options may still contain signals.
    delete ipfsOptions.signal;
    delete loggerOptions.signal;
    if (signal !== undefined) {
        ipfsOptions.signal = signal;
        loggerOptions.signal = signal;
    }
    const publication = await publishSignedMessage(message, ipfsOptions);
    try {
        const logging = await logCid(publication.cid, loggerOptions);
        return { publication, logging };
    } catch (cause) {
        throw new PublishAndLogSignedMessageError(publication, cause);
    }
}

export { publishAndLogSignedMessage, PublishAndLogSignedMessageError };
export type { PublishAndLogSignedMessageOptions, PublishAndLogSignedMessageResult };
