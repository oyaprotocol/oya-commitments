import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from './validation-utils.js';
const RETRYABLE_HTTP_NETWORK_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);
function normalizeUrl(url) {
    return url.replace(/\/+$/, '');
}
function createHttpConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs }, normalizeConfigUrl = normalizeUrl) {
    const normalizedUrl = assertNonEmptyString(normalizeConfigUrl(assertNonEmptyString(url, 'config.url')), 'config.url');
    return Object.freeze({
        url: normalizedUrl,
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}
function readErrorCodeChain(error) {
    const values = [];
    let current = error;
    while (current && typeof current === 'object') {
        const value = current.code;
        if (typeof value === 'string' && value) {
            values.push(value);
        }
        current = current.cause;
    }
    return values;
}
function hasRetryableNetworkErrorCode(error) {
    for (const code of readErrorCodeChain(error)) {
        if (RETRYABLE_HTTP_NETWORK_ERROR_CODES.has(code.toUpperCase())) {
            return true;
        }
    }
    return false;
}
export { RETRYABLE_HTTP_NETWORK_ERROR_CODES, createHttpConfig, hasRetryableNetworkErrorCode, };
//# sourceMappingURL=http-utils.js.map