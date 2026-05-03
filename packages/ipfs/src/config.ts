import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from '@oyaprotocol/utils';
import type { CreateHttpConfigOptions, HttpConfig } from '@oyaprotocol/utils';

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}

function createIpfsConfig({
    url,
    headers,
    timeoutMs,
    maxRetries,
    retryDelayMs,
}: CreateHttpConfigOptions): HttpConfig {
    return Object.freeze({
        url: normalizeUrl(assertNonEmptyString(url, 'config.url')),
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createIpfsConfig };
