import type { ReadIpfsBytesFetchLike, ReadIpfsBytesRequestOptions, ReadIpfsBytesResponse } from './read-ipfs-bytes.js';
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
declare function readIpfsText(options: ReadIpfsTextOptions): Promise<ReadIpfsTextResult>;
export { readIpfsText };
