import {
    combineAbortSignals,
    createTimeoutSignal,
    hasRetryableNetworkErrorCode,
    invokeWithAbort,
    throwIfSignalAborted,
    waitForRetryDelay,
} from '@oyaprotocol/utils';
import type { AbortSignalHandle } from '@oyaprotocol/utils';

interface IpfsHttpErrorOptions {
    status: number;
    responseText?: string;
}

interface IpfsOperationErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}

class IpfsHttpError extends Error {
    readonly status: number;
    readonly responseText: string | undefined;

    constructor(message: string, { status, responseText }: IpfsHttpErrorOptions) {
        super(message);
        this.name = 'IpfsHttpError';
        this.status = status;
        this.responseText = responseText;
    }
}

function isIpfsHttpError(error: unknown): error is IpfsHttpError {
    return error instanceof IpfsHttpError;
}

function readErrorStringChain(error: unknown, key: string): string[] {
    const values: string[] = [];
    let current: unknown = error;
    while (current && typeof current === 'object') {
        const value = (current as Record<string, unknown>)[key];
        if (typeof value === 'string' && value) {
            values.push(value);
        }
        current = (current as Record<string, unknown>).cause;
    }
    return values;
}

function shouldRetryError(error: unknown): boolean {
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
    return (
        message.includes('fetch failed') ||
        message.includes('failed to fetch') ||
        message.includes('network error') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('connection refused') ||
        message.includes('connection reset')
    );
}

function normalizeIpfsOperationError(
    error: unknown,
    messages: IpfsOperationErrorMessages
): Error {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error(`${messages.fallbackErrorBaseMessage}.`);
    }
    return new Error(`${messages.fallbackErrorBaseMessage}: ${String(error)}`);
}

export {
    combineAbortSignals,
    createTimeoutSignal,
    invokeWithAbort,
    IpfsHttpError,
    normalizeIpfsOperationError,
    shouldRetryError,
    throwIfSignalAborted,
    waitForRetryDelay,
};
export type { AbortSignalHandle, IpfsOperationErrorMessages };
