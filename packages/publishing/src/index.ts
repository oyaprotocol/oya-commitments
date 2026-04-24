export const packageInfo = Object.freeze({
    name: '@oyaprotocol/publishing',
    status: 'partial',
});

export { createIpfsPublishConfig } from './ipfs-publish-config.js';
export type {
    CreateIpfsPublishConfigOptions,
    IpfsPublishConfig,
} from './ipfs-publish-config.js';
export { publishToIpfs } from './publish-to-ipfs.js';
export type {
    FetchLike,
    FetchRequestOptions,
    FetchResponse,
    PublishToIpfsOptions,
    PublishToIpfsResult,
    PublishableContent,
} from './publish-to-ipfs.js';
