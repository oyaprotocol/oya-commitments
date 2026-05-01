export const packageInfo = Object.freeze({
    name: '@oyaprotocol/publishing',
    status: 'partial',
});

export { createIpfsConfig } from './ipfs-config.js';
export type { CreateIpfsConfigOptions, IpfsConfig } from './ipfs-config.js';
export { publishToIpfs } from './publish-to-ipfs.js';
export type {
    FetchLike,
    FetchRequestOptions,
    FetchResponse,
    PublishToIpfsOptions,
    PublishToIpfsResult,
    PublishableContent,
} from './publish-to-ipfs.js';
export { readIpfsBytes } from './read-ipfs-bytes.js';
export type {
    ReadIpfsBytesOptions,
    ReadIpfsBytesResult,
    ReadIpfsFetchLike,
    ReadIpfsRequestOptions,
    ReadIpfsResponse,
} from './read-ipfs-bytes.js';
export { readIpfsText } from './read-ipfs-text.js';
export type { ReadIpfsTextOptions, ReadIpfsTextResult } from './read-ipfs-text.js';
