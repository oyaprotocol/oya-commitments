import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

interface CreateHttpConfigOptions {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

interface HttpConfig {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

function createHttpConfig(
    { url, headers, timeoutMs, maxRetries, retryDelayMs }: CreateHttpConfigOptions,
    normalizeConfigUrl: (url: string) => string = normalizeUrl
): HttpConfig {
    return Object.freeze({
        url: normalizeConfigUrl(assertNonEmptyString(url, 'config.url')),
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createHttpConfig };
export type { CreateHttpConfigOptions, HttpConfig };
