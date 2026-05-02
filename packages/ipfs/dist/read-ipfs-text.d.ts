import type { ReadIpfsOptions } from './read-ipfs-bytes.js';
export interface ReadIpfsTextResult {
    cid: string;
    uri: string;
    text: string;
    byteLength: number;
    attemptCount: number;
}
declare function readIpfsText(options: ReadIpfsOptions): Promise<ReadIpfsTextResult>;
export { readIpfsText };
