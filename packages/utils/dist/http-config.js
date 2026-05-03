import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from './validation-utils.js';
function normalizeUrl(url) {
    return url.replace(/\/+$/, '');
}
function createHttpConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs }, normalizeConfigUrl = normalizeUrl) {
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
//# sourceMappingURL=http-config.js.map