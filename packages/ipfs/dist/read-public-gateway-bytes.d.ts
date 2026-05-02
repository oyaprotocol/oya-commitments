import type { IpfsOperationErrorMessages } from './request-utils.js';
import { type ReadIpfsBytesResult } from './read-bytes.js';
export type ReadIpfsPublicGatewayFetchLike = (url: string, options: ReadIpfsPublicGatewayFetchOptions) => Promise<ReadIpfsPublicGatewayResponse>;
export interface ReadIpfsPublicGatewayFetchOptions {
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
declare function readIpfsPublicGatewayBytesWithMessages({ gatewayUrl, headers, timeoutMs, maxRetries, retryDelayMs, fetch, cid, maxBytes, signal, }: ReadIpfsPublicGatewayOptions, messages: IpfsOperationErrorMessages): Promise<ReadIpfsBytesResult>;
declare function readIpfsPublicGatewayBytes(options: ReadIpfsPublicGatewayOptions): Promise<ReadIpfsBytesResult>;
export { readIpfsPublicGatewayBytes, readIpfsPublicGatewayBytesWithMessages };
