import { publishToIpfs } from '@oyaprotocol/ipfs';
import { verifySignedMessage } from '../ethereum-signature.js';
async function publishSignedMessage(input, options) {
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
//# sourceMappingURL=publish.js.map