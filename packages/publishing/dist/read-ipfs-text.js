import { readIpfsBytesWithMessages } from './read-ipfs-bytes.js';
function assertAsciiBytes(bytes) {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
}
async function readIpfsText(options) {
    const result = await readIpfsBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsText was aborted by the caller.',
        fallbackErrorMessage: 'IPFS text read failed.',
        fallbackErrorPrefix: 'IPFS text read failed',
    });
    assertAsciiBytes(result.bytes);
    return {
        cid: result.cid,
        uri: result.uri,
        text: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes),
        byteLength: result.byteLength,
        attemptCount: result.attemptCount,
    };
}
export { readIpfsText };
//# sourceMappingURL=read-ipfs-text.js.map