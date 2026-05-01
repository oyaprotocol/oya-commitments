export const packageInfo = Object.freeze({
    name: '@oyaprotocol/publishing',
    status: 'partial',
});

export { createIpfsConfig } from './ipfs-config.js';
export type { CreateIpfsConfigOptions, IpfsConfig } from './ipfs-config.js';
export { publishToIpfs } from './publish-to-ipfs.js';
export type {
    PublishIpfsFetchLike,
    PublishIpfsRequestOptions,
    PublishIpfsResponse,
    PublishToIpfsOptions,
    PublishToIpfsResult,
    PublishableContent,
} from './publish-to-ipfs.js';
export { readIpfsBytes } from './read-ipfs-bytes.js';
export type {
    ReadIpfsBytesResult,
    ReadIpfsFetchLike,
    ReadIpfsOptions,
    ReadIpfsRequestOptions,
    ReadIpfsResponse,
} from './read-ipfs-bytes.js';
export { readIpfsText } from './read-ipfs-text.js';
export type { ReadIpfsTextResult } from './read-ipfs-text.js';
