import type { CreateHttpConfigOptions, HttpConfig } from '@oyaprotocol/utils';
declare function createIpfsConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs, }: CreateHttpConfigOptions): HttpConfig;
export { createIpfsConfig };
