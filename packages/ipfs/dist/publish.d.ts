import type { IpfsConfig } from './config.js';
export type PublishIpfsFetchLike = (url: string, options: PublishIpfsRequestOptions) => Promise<PublishIpfsResponse>;
export type PublishableContent = string | Uint8Array | ArrayBuffer | Blob;
export interface PublishIpfsRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: FormData;
    signal?: AbortSignal | undefined;
}
export interface PublishIpfsResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}
export interface PublishToIpfsOptions {
    config: IpfsConfig;
    fetch: PublishIpfsFetchLike;
    content: PublishableContent;
    filename: string;
    mediaType: string;
    signal?: AbortSignal;
}
export interface PublishToIpfsResult {
    cid: string;
    uri: string;
    pinned: true;
    filename: string;
    mediaType: string;
    contentByteLength: number;
    providerSize: number | null;
    attemptCount: number;
    providerResponse: unknown;
}
declare function publishToIpfs({ config, fetch, content, filename, mediaType, signal, }: PublishToIpfsOptions): Promise<PublishToIpfsResult>;
export { publishToIpfs };
