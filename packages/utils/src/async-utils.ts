import {
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}

interface RunWithRetryAttemptContext {
    attempt: number;
    signal: AbortSignal | undefined;
}

interface RunWithRetryOptions<TResult> {
    maxRetries: number;
    retryDelayMs: number;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    abortErrorMessage: string;
    shouldRetry(error: unknown): boolean;
    normalizeError(error: unknown): Error;
    run(context: RunWithRetryAttemptContext): Promise<TResult>;
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
    const abortedSignal = presentSignals.find((signal) => signal.aborted);
    if (abortedSignal) {
        controller.abort(abortedSignal.reason);
        return {
            signal: controller.signal,
            cleanup: null,
        };
    }

    const listeners: Array<{ signal: AbortSignal; listener: EventListener }> = [];
    for (const signal of presentSignals) {
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

async function runWithRetry<TResult>({
    maxRetries,
    retryDelayMs,
    timeoutMs,
    signal,
    abortErrorMessage,
    shouldRetry,
    normalizeError,
    run,
}: RunWithRetryOptions<TResult>): Promise<TResult> {
    const retryLimit = assertNonNegativeInteger(maxRetries, 'maxRetries');
    const retryDelay = assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');
    const requestTimeoutMs = assertPositiveInteger(timeoutMs, 'timeoutMs');
    const callerAbortErrorMessage = assertNonEmptyString(
        abortErrorMessage,
        'abortErrorMessage'
    );
    if (typeof shouldRetry !== 'function') {
        throw new Error('shouldRetry must be provided as a function.');
    }
    if (typeof normalizeError !== 'function') {
        throw new Error('normalizeError must be provided as a function.');
    }
    if (typeof run !== 'function') {
        throw new Error('run must be provided as a function.');
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(requestTimeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            return await invokeWithAbort(
                () =>
                    run({
                        attempt,
                        signal: requestSignal.signal,
                    }),
                requestSignal.signal
            );
        } catch (error) {
            lastError = error;
            throwIfSignalAborted(signal, callerAbortErrorMessage, error);
            if (attempt <= retryLimit && shouldRetry(error)) {
                await waitForRetryDelay({
                    retryDelayMs: retryDelay,
                    signal,
                    abortErrorMessage: callerAbortErrorMessage,
                });
                continue;
            }
            break;
        } finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }

    throw normalizeError(lastError);
}

export {
    combineAbortSignals,
    createTimeoutSignal,
    invokeWithAbort,
    runWithRetry,
    throwIfSignalAborted,
    waitForRetryDelay,
};
export type {
    AbortSignalHandle,
    RunWithRetryAttemptContext,
    RunWithRetryOptions,
};
