import type {
    ReadIpfsBytesFetchLike,
    ReadIpfsBytesRequestOptions,
    ReadIpfsBytesResponse,
} from './read-ipfs-bytes.js';
import { readIpfsBytesWithMessages } from './read-ipfs-bytes.js';
import type { IpfsConfig } from './ipfs-config.js';

export type ReadIpfsTextFetchLike = ReadIpfsBytesFetchLike;
export type ReadIpfsTextRequestOptions = ReadIpfsBytesRequestOptions;
export type ReadIpfsTextResponse = ReadIpfsBytesResponse;

export interface ReadIpfsTextOptions {
    config: IpfsConfig;
    fetch: ReadIpfsTextFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}

export interface ReadIpfsTextResult {
    cid: string;
    uri: string;
    text: string;
    byteLength: number;
    attemptCount: number;
}

function assertAsciiBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
}

async function readIpfsText(options: ReadIpfsTextOptions): Promise<ReadIpfsTextResult> {
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
