export const packageInfo = Object.freeze({
    name: '@oyaprotocol/ethereum',
});

export { createEthereumRpcConfig } from './config.js';
export type { CreateEthereumRpcConfigOptions, EthereumRpcConfig } from './config.js';
export {
    EthereumJsonRpcError,
    EthereumJsonRpcHttpError,
    requestEthereumJsonRpc,
} from './request-utils.js';
export type {
    EthereumJsonRpcFetchLike,
    EthereumJsonRpcFetchOptions,
    EthereumJsonRpcResponse,
    RequestEthereumJsonRpcOptions,
    RequestEthereumJsonRpcResult,
} from './request-utils.js';
