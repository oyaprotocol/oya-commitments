import type { IpfsConfig } from './ipfs-config.js';
export type ReadIpfsBytesFetchLike = (url: string, options: ReadIpfsBytesRequestOptions) => Promise<ReadIpfsBytesResponse>;
export interface ReadIpfsBytesRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}
export interface ReadIpfsBytesResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}
export interface ReadIpfsBytesOptions {
    config: IpfsConfig;
    fetch: ReadIpfsBytesFetchLike;
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
interface ReadIpfsBytesErrorMessages {
    abortErrorMessage: string;
    fallbackErrorMessage: string;
    fallbackErrorPrefix: string;
}
declare function readIpfsBytesWithMessages({ config, fetch, cid, maxBytes, signal, }: ReadIpfsBytesOptions, messages: ReadIpfsBytesErrorMessages): Promise<ReadIpfsBytesResult>;
declare function readIpfsBytes(options: ReadIpfsBytesOptions): Promise<ReadIpfsBytesResult>;
export { readIpfsBytes, readIpfsBytesWithMessages };
