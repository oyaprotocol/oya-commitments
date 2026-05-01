import type { IpfsConfig } from './ipfs-config.js';
import type { ReadIpfsFetchLike } from './read-ipfs-bytes.js';
export interface ReadIpfsTextOptions {
    config: IpfsConfig;
    fetch: ReadIpfsFetchLike;
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
