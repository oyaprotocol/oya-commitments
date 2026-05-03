import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from '@oyaprotocol/utils';
function normalizeApiUrl(apiUrl) {
    return apiUrl.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}
function createIpfsConfig({ apiUrl, headers, timeoutMs, maxRetries, retryDelayMs, }) {
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
//# sourceMappingURL=config.js.map