import type { CreateHttpConfigOptions, HttpConfig } from '@oyaprotocol/utils';
declare function createEthereumRpcConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs, }: CreateHttpConfigOptions): HttpConfig;
export { createEthereumRpcConfig };
