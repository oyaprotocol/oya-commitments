import { readIpfsBytesWithMessages } from './read-bytes.js';
import type { ReadIpfsOptions } from './read-bytes.js';
import { assertAsciiBytes } from './validation-utils.js';

export interface ReadIpfsTextResult {
    cid: string;
    uri: string;
    text: string;
    byteLength: number;
    attemptCount: number;
}

async function readIpfsText(options: ReadIpfsOptions): Promise<ReadIpfsTextResult> {
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
