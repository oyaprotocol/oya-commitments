import type { IpfsPublishConfig } from './ipfs-publish-config.js';
export type PublishableContent = string | Uint8Array | ArrayBuffer | Blob;
export interface FetchRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: FormData;
    signal?: AbortSignal | undefined;
}
export interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}
export interface FetchLike {
    (url: string, options: FetchRequestOptions): Promise<FetchResponse>;
}
export interface PublishToIpfsOptions {
    config: IpfsPublishConfig;
    fetch: FetchLike;
    content: PublishableContent;
    filename: string;
    mediaType: string;
    signal?: AbortSignal;
}
export interface PublishToIpfsResult {
    cid: string;
    uri: string;
    filename: string;
    mediaType: string;
    contentByteLength: number;
    providerSize: number | null;
    attemptCount: number;
    providerResponse: unknown;
}
declare function publishToIpfs({ config, fetch, content, filename, mediaType, signal, }?: Partial<PublishToIpfsOptions>): Promise<PublishToIpfsResult>;
export { publishToIpfs };
