import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from '@oyaprotocol/utils';
function normalizeUrl(url) {
    return url.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}
function createIpfsConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs, }) {
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
//# sourceMappingURL=config.js.map