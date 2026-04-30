import type { IpfsPublishConfig } from './ipfs-publish-config.js';
export type ReadIpfsTextFetchLike = (url: string, options: ReadIpfsTextRequestOptions) => Promise<ReadIpfsTextResponse>;
export interface ReadIpfsTextRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}
export interface ReadIpfsTextResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}
export interface ReadIpfsTextOptions {
    config: IpfsPublishConfig;
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
declare function readIpfsText({ config, fetch, cid, maxBytes, signal, }: ReadIpfsTextOptions): Promise<ReadIpfsTextResult>;
export { readIpfsText };
