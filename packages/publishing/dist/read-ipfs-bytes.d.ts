import type { IpfsConfig } from './ipfs-config.js';
export type ReadIpfsFetchLike = (url: string, options: ReadIpfsRequestOptions) => Promise<ReadIpfsResponse>;
export interface ReadIpfsRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}
export interface ReadIpfsResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}
export interface ReadIpfsOptions {
    config: IpfsConfig;
    fetch: ReadIpfsFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}
export interface ReadIpfsBytesResult {
    cid: string;
    uri: string;
    bytes: Uint8Array;
    byteLength: number;
    attemptCount: number;
}
interface ReadIpfsErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}
declare function readBoundedBytes({ body, maxBytes, signal, }: {
    body: ReadableStream<Uint8Array> | null;
    maxBytes: number;
    signal: AbortSignal | undefined;
}): Promise<Uint8Array>;
declare function readIpfsBytesWithMessages({ config, fetch, cid, maxBytes, signal, }: ReadIpfsOptions, messages: ReadIpfsErrorMessages): Promise<ReadIpfsBytesResult>;
declare function readIpfsBytes(options: ReadIpfsOptions): Promise<ReadIpfsBytesResult>;
export { readBoundedBytes, readIpfsBytes, readIpfsBytesWithMessages };
