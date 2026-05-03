import { hasRetryableNetworkErrorCode } from '@oyaprotocol/utils';

interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}

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

function createTimeoutSignal(timeoutMs: number): AbortSignalHandle {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignalHandle {
    const presentSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (presentSignals.length === 0) {
        return {
            signal: undefined,
            cleanup: null,
        };
    }
    if (presentSignals.length === 1) {
        return {
            signal: presentSignals[0],
            cleanup: null,
        };
    }
    if (typeof AbortSignal.any === 'function') {
        return {
            signal: AbortSignal.any(presentSignals),
            cleanup: null,
        };
    }
    const controller = new AbortController();
    const listeners: Array<{ signal: AbortSignal; listener: EventListener }> = [];
    for (const signal of presentSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            return {
                signal: controller.signal,
                cleanup: null,
            };
        }
        const listener = () => {
            controller.abort(signal.reason);
        };
        signal.addEventListener('abort', listener, { once: true });
        listeners.push({ signal, listener });
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            for (const { signal, listener } of listeners) {
                signal.removeEventListener('abort', listener);
            }
        },
    };
}

async function invokeWithAbort<T>(
    createPromise: () => Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await createPromise();
    }
    if (signal.aborted) {
        throw signal.reason ?? new Error('Operation aborted.');
    }
    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finishResolve = (value: T) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const finishReject = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        };
        const onAbort = () => {
            finishReject(signal.reason ?? new Error('Operation aborted.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        let promise: Promise<T>;
        try {
            promise = createPromise();
        } catch (error) {
            finishReject(error);
            return;
        }
        promise.then(finishResolve, finishReject);
    });
}

function throwIfSignalAborted(
    signal: AbortSignal | undefined,
    message: string,
    cause: unknown
): void {
    if (signal?.aborted) {
        throw new Error(message, { cause });
    }
}

async function waitForRetryDelay({
    retryDelayMs,
    signal,
    abortErrorMessage,
}: {
    retryDelayMs: number;
    signal: AbortSignal | undefined;
    abortErrorMessage: string;
}): Promise<void> {
    if (retryDelayMs <= 0) {
        return;
    }
    throwIfSignalAborted(signal, abortErrorMessage, signal?.reason);
    await new Promise<void>((resolve) => {
        if (!signal) {
            setTimeout(resolve, retryDelayMs);
            return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            signal.removeEventListener('abort', finish);
            resolve();
        };

        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) {
            finish();
            return;
        }
        timer = setTimeout(finish, retryDelayMs);
    });
    throwIfSignalAborted(signal, abortErrorMessage, signal?.reason);
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
