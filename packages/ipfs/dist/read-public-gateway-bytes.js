import { combineAbortSignals, createTimeoutSignal, invokeWithAbort, IpfsHttpError, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, } from './request-utils.js';
import { readBoundedBytes } from './read-bytes.js';
import { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from '@oyaprotocol/utils';
function buildGatewayReadUrl(gatewayUrl, cid) {
    const url = new URL(gatewayUrl);
    if (url.hash) {
        throw new Error('gatewayUrl must not include a fragment.');
    }
    const basePath = url.pathname.replace(/\/+$/, '').replace(/\/ipfs$/, '');
    url.pathname = `${basePath}/ipfs/${encodeURIComponent(cid)}`;
    return url.toString();
}
async function readIpfsPublicGatewayBytesWithMessages({ gatewayUrl, headers, timeoutMs, maxRetries, retryDelayMs, fetch, cid, maxBytes, signal, }, messages) {
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const gatewayReadUrl = buildGatewayReadUrl(assertNonEmptyString(gatewayUrl, 'gatewayUrl'), trimmedCid);
    const validatedHeaders = assertHeadersObject(headers, 'headers');
    const requestTimeoutMs = assertPositiveInteger(timeoutMs, 'timeoutMs');
    const retryLimit = assertNonNegativeInteger(maxRetries, 'maxRetries');
    const retryDelay = assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');
    let lastError = null;
    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(requestTimeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(() => fetch(gatewayReadUrl, {
                method: 'GET',
                headers: validatedHeaders,
                signal: requestSignal.signal,
            }), requestSignal.signal);
            if (!response.ok) {
                const httpError = new IpfsHttpError(`IPFS public gateway read failed with ${response.status} ${response.statusText || 'Unknown Status'}.`, {
                    status: response.status,
                });
                response.body?.cancel(httpError).catch(() => { });
                throw httpError;
            }
            const bytes = await readBoundedBytes({
                body: response.body,
                maxBytes: byteLimit,
                signal: requestSignal.signal,
            });
            return {
                cid: trimmedCid,
                uri: `ipfs://${trimmedCid}`,
                bytes,
                byteLength: bytes.byteLength,
                attemptCount: attempt,
            };
        }
        catch (error) {
            lastError = error;
            throwIfSignalAborted(signal, messages.abortErrorMessage, error);
            if (attempt <= retryLimit && shouldRetryError(error)) {
                await waitForRetryDelay({
                    retryDelayMs: retryDelay,
                    signal,
                    abortErrorMessage: messages.abortErrorMessage,
                });
                continue;
            }
            break;
        }
        finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }
    throw normalizeIpfsOperationError(lastError, messages);
}
async function readIpfsPublicGatewayBytes(options) {
    return await readIpfsPublicGatewayBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsPublicGatewayBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS public gateway bytes read failed',
    });
}
export { readIpfsPublicGatewayBytes, readIpfsPublicGatewayBytesWithMessages };
//# sourceMappingURL=read-public-gateway-bytes.js.map