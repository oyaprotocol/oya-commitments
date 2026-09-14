import { logCid, LogCidError } from '@oyaprotocol/ethereum';
import { publishSignedMessage } from './publish.js';
class PublishAndLogSignedMessageError extends Error {
    publication;
    transactionHash;
    constructor(publication, cause) {
        super('Message was published to IPFS, but CID logging did not complete.', { cause });
        this.name = 'PublishAndLogSignedMessageError';
        this.publication = publication;
        this.transactionHash = cause instanceof LogCidError ? cause.transactionHash : null;
    }
}
/** Use after allowlist authorization, typically as an ingress callback. */
async function publishAndLogSignedMessage(message, { ipfs, ledger, signal }) {
    const ipfsOptions = { ...ipfs };
    const ledgerOptions = { ...ledger };
    // Omit only narrows types; reused stage options may still contain signals.
    delete ipfsOptions.signal;
    delete ledgerOptions.signal;
    if (signal !== undefined) {
        ipfsOptions.signal = signal;
        ledgerOptions.signal = signal;
    }
    const publication = await publishSignedMessage(message, ipfsOptions);
    try {
        const logging = await logCid(publication.cid, ledgerOptions);
        return { publication, logging };
    }
    catch (cause) {
        throw new PublishAndLogSignedMessageError(publication, cause);
    }
}
export { publishAndLogSignedMessage, PublishAndLogSignedMessageError };
//# sourceMappingURL=publish-and-log.js.map