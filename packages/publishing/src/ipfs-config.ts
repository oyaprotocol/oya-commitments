import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

export interface CreateIpfsConfigOptions {
    apiUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

export interface IpfsConfig {
    readonly apiUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}

function normalizeApiUrl(apiUrl: string): string {
    return apiUrl.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}

function createIpfsConfig({
    apiUrl,
    headers,
    timeoutMs,
    maxRetries,
    retryDelayMs,
}: CreateIpfsConfigOptions): IpfsConfig {
    return Object.freeze({
        apiUrl: normalizeApiUrl(assertNonEmptyString(apiUrl, 'config.apiUrl')),
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createIpfsConfig };
