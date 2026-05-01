import { readIpfsBytesWithMessages } from './read-ipfs-bytes.js';
const READ_TEXT_ERROR_MESSAGES = Object.freeze({
    abortErrorMessage: 'readIpfsText was aborted by the caller.',
    fallbackErrorBaseMessage: 'IPFS text read failed',
});
function assertAsciiBytes(bytes) {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
}
async function readIpfsText(options) {
    const result = await readIpfsBytesWithMessages(options, READ_TEXT_ERROR_MESSAGES);
    assertAsciiBytes(result.bytes);
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