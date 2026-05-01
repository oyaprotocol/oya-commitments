import { readIpfsBytesWithMessages } from './read-ipfs-bytes.js';
import type { ReadIpfsOptions } from './read-ipfs-bytes.js';

export interface ReadIpfsTextResult {
    cid: string;
    uri: string;
    text: string;
    byteLength: number;
    attemptCount: number;
}

const READ_TEXT_ERROR_MESSAGES = Object.freeze({
    abortErrorMessage: 'readIpfsText was aborted by the caller.',
    fallbackErrorMessage: 'IPFS text read failed.',
    fallbackErrorPrefix: 'IPFS text read failed',
});

function assertAsciiBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
}

async function readIpfsText(options: ReadIpfsOptions): Promise<ReadIpfsTextResult> {
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
