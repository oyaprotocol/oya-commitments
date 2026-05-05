import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
export type PublishableContent = string | Uint8Array | ArrayBuffer | Blob;
export interface PublishToIpfsOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<FormData>;
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
