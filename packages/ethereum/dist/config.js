import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from '@oyaprotocol/utils';
function normalizeRpcUrl(rpcUrl) {
    return rpcUrl.replace(/\/+$/, '');
}
function createEthereumRpcConfig({ rpcUrl, headers, timeoutMs, maxRetries, retryDelayMs, }) {
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
//# sourceMappingURL=config.js.map