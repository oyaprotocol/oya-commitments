import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

export interface CreateEthereumRpcConfigOptions {
    rpcUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

export interface EthereumRpcConfig {
    readonly rpcUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}

function normalizeRpcUrl(rpcUrl: string): string {
    return rpcUrl.replace(/\/+$/, '');
}

function createEthereumRpcConfig({
    rpcUrl,
    headers,
    timeoutMs,
    maxRetries,
    retryDelayMs,
}: CreateEthereumRpcConfigOptions): EthereumRpcConfig {
    return Object.freeze({
        rpcUrl: normalizeRpcUrl(assertNonEmptyString(rpcUrl, 'config.rpcUrl')),
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createEthereumRpcConfig };
