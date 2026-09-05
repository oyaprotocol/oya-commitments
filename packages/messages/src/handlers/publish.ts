import { publishToIpfs } from '@oyaprotocol/ipfs';
import type {
    PublishToIpfsOptions,
    PublishToIpfsResult,
} from '@oyaprotocol/ipfs';

import { verifySignedMessage } from '../ethereum-signature.js';
import type { SignedMessageInput } from '../schema.js';

type PublishSignedMessageOptions = Pick<
    PublishToIpfsOptions,
    'config' | 'fetch' | 'signal'
>;

async function publishSignedMessage(
    input: Readonly<SignedMessageInput>,
    options: PublishSignedMessageOptions
): Promise<PublishToIpfsResult> {
    // Direct callers also receive signature verification; the host owns authorization.
    const message = verifySignedMessage(input);
    const content = JSON.stringify({
        text: message.text,
        signer: message.signer,
        signature: message.signature,
    });

    return await publishToIpfs({
        ...options,
        content,
        filename: 'message.json',
        mediaType: 'application/json',
    });
}

export { publishSignedMessage };
export type { PublishSignedMessageOptions };
