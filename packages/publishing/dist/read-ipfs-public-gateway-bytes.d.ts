import { type ReadIpfsBytesResult } from './read-ipfs-bytes.js';
export type ReadIpfsPublicGatewayFetchLike = (url: string, options: ReadIpfsPublicGatewayRequestOptions) => Promise<ReadIpfsPublicGatewayResponse>;
export interface ReadIpfsPublicGatewayRequestOptions {
    method: 'GET';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}
export interface ReadIpfsPublicGatewayResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}
export interface ReadIpfsPublicGatewayOptions {
    gatewayUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
    fetch: ReadIpfsPublicGatewayFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}
interface ReadIpfsPublicGatewayErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}
declare function readIpfsPublicGatewayBytesWithMessages({ gatewayUrl, headers, timeoutMs, maxRetries, retryDelayMs, fetch, cid, maxBytes, signal, }: ReadIpfsPublicGatewayOptions, messages: ReadIpfsPublicGatewayErrorMessages): Promise<ReadIpfsBytesResult>;
declare function readIpfsPublicGatewayBytes(options: ReadIpfsPublicGatewayOptions): Promise<ReadIpfsBytesResult>;
export { readIpfsPublicGatewayBytes, readIpfsPublicGatewayBytesWithMessages };
