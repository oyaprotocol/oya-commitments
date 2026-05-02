export declare const packageInfo: Readonly<{
    name: "@oyaprotocol/ipfs";
    status: "partial";
}>;
export { createIpfsConfig } from './ipfs-config.js';
export type { CreateIpfsConfigOptions, IpfsConfig } from './ipfs-config.js';
export { publishToIpfs } from './publish-to-ipfs.js';
export type { PublishIpfsFetchLike, PublishIpfsRequestOptions, PublishIpfsResponse, PublishToIpfsOptions, PublishToIpfsResult, PublishableContent, } from './publish-to-ipfs.js';
export { readIpfsBytes } from './read-ipfs-bytes.js';
export type { ReadIpfsBytesResult, ReadIpfsFetchOptions, ReadIpfsFetchLike, ReadIpfsOptions, ReadIpfsResponse, } from './read-ipfs-bytes.js';
export { readIpfsPublicGatewayBytes } from './read-ipfs-public-gateway-bytes.js';
export type { ReadIpfsPublicGatewayFetchOptions, ReadIpfsPublicGatewayFetchLike, ReadIpfsPublicGatewayOptions, ReadIpfsPublicGatewayResponse, } from './read-ipfs-public-gateway-bytes.js';
export { readIpfsPublicGatewayText } from './read-ipfs-public-gateway-text.js';
export { readIpfsText } from './read-ipfs-text.js';
export type { ReadIpfsTextResult } from './read-ipfs-text.js';
