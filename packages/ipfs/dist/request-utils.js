import { combineAbortSignals, createTimeoutSignal, hasRetryableNetworkErrorCode, HttpStatusError, invokeWithAbort, readErrorStringChain, throwIfSignalAborted, waitForRetryDelay, } from '@oyaprotocol/utils';
function shouldRetryError(error) {
    if (!error) {
        return false;
    }
    if (error instanceof HttpStatusError) {
        return error.status === 429 || error.status >= 500;
    }
    const names = readErrorStringChain(error, 'name');
    if (names.includes('TimeoutError')) {
        return true;
    }
    if (hasRetryableNetworkErrorCode(error)) {
        return true;
    }
    const message = readErrorStringChain(error, 'message').join(' ').toLowerCase();
    return (message.includes('fetch failed') ||
        message.includes('failed to fetch') ||
        message.includes('network error') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('connection refused') ||
        message.includes('connection reset'));
}
function normalizeIpfsOperationError(error, messages) {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error(`${messages.fallbackErrorBaseMessage}.`);
    }
    return new Error(`${messages.fallbackErrorBaseMessage}: ${String(error)}`);
}
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
//# sourceMappingURL=request-utils.js.map