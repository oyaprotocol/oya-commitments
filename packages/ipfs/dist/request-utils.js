import { combineAbortSignals, createTimeoutSignal, hasRetryableNetworkErrorCode, invokeWithAbort, throwIfSignalAborted, waitForRetryDelay, } from '@oyaprotocol/utils';
class IpfsHttpError extends Error {
    status;
    responseText;
    constructor(message, { status, responseText }) {
        super(message);
        this.name = 'IpfsHttpError';
        this.status = status;
        this.responseText = responseText;
    }
}
function isIpfsHttpError(error) {
    return error instanceof IpfsHttpError;
}
function readErrorStringChain(error, key) {
    const values = [];
    let current = error;
    while (current && typeof current === 'object') {
        const value = current[key];
        if (typeof value === 'string' && value) {
            values.push(value);
        }
        current = current.cause;
    }
    return values;
}
function shouldRetryError(error) {
    if (!error) {
        return false;
    }
    if (isIpfsHttpError(error)) {
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
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, IpfsHttpError, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
//# sourceMappingURL=request-utils.js.map