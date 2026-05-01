import { assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from './validation-utils.js';
function assertHeadersObject(headers, label) {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error(`${label} must be an object.`);
    }
    const validated = {};
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === 'content-type') {
            throw new Error(`${label} must not include content-type.`);
        }
        if (typeof value !== 'string') {
            throw new Error(`${label}.${key} must be a string.`);
        }
        validated[key] = value;
    }
    return Object.freeze(validated);
}
function normalizeApiUrl(apiUrl) {
    return apiUrl.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}
function createIpfsConfig({ apiUrl, headers, timeoutMs, maxRetries, retryDelayMs, }) {
    return Object.freeze({
        apiUrl: normalizeApiUrl(assertNonEmptyString(apiUrl, 'config.apiUrl')),
        headers: assertHeadersObject(headers, 'config.headers'),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}
export { createIpfsConfig };
//# sourceMappingURL=ipfs-config.js.map