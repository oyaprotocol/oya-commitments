import { readIpfsBytesWithMessages } from './read-ipfs-bytes.js';
import { assertAsciiBytes } from './validation-utils.js';
async function readIpfsText(options) {
    const result = await readIpfsBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsText was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS text read failed',
    });
    assertAsciiBytes(result.bytes, 'IPFS cat response contained non-ASCII bytes.');
    return {
        cid: result.cid,
        uri: result.uri,
        text: new TextDecoder('utf-8').decode(result.bytes),
        byteLength: result.byteLength,
        attemptCount: result.attemptCount,
    };
}
export { readIpfsText };
//# sourceMappingURL=read-ipfs-text.js.map