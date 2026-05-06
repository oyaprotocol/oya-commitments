import { assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, } from './validation-utils.js';
function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}
function combineAbortSignals(signals) {
    const presentSignals = signals.filter((signal) => signal !== undefined);
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
    const listeners = [];
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
async function invokeWithAbort(createPromise, signal) {
    if (!signal) {
        return await createPromise();
    }
    if (signal.aborted) {
        throw signal.reason ?? new Error('Operation aborted.');
    }
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finishResolve = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const finishReject = (error) => {
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
        let promise;
        try {
            promise = createPromise();
        }
        catch (error) {
            finishReject(error);
            return;
        }
        promise.then(finishResolve, finishReject);
    });
}
function throwIfSignalAborted(signal, message, cause) {
    if (signal?.aborted) {
        throw new Error(message, { cause });
    }
}
async function waitForRetryDelay({ retryDelayMs, signal, abortErrorMessage, }) {
    if (retryDelayMs <= 0) {
        return;
    }
    throwIfSignalAborted(signal, abortErrorMessage, signal?.reason);
    await new Promise((resolve) => {
        if (!signal) {
            setTimeout(resolve, retryDelayMs);
            return;
        }
        let settled = false;
        let timer = null;
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
async function runWithRetry({ maxRetries, retryDelayMs, timeoutMs, signal, abortErrorMessage, shouldRetry, normalizeError, run, }) {
    const retryLimit = assertNonNegativeInteger(maxRetries, 'maxRetries');
    const retryDelay = assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');
    const requestTimeoutMs = assertPositiveInteger(timeoutMs, 'timeoutMs');
    const callerAbortErrorMessage = assertNonEmptyString(abortErrorMessage, 'abortErrorMessage');
    if (typeof shouldRetry !== 'function') {
        throw new Error('shouldRetry must be provided as a function.');
    }
    if (typeof normalizeError !== 'function') {
        throw new Error('normalizeError must be provided as a function.');
    }
    if (typeof run !== 'function') {
        throw new Error('run must be provided as a function.');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(requestTimeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            return await invokeWithAbort(() => run({
                attempt,
                signal: requestSignal.signal,
            }), requestSignal.signal);
        }
        catch (error) {
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
        }
        finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }
    throw normalizeError(lastError);
}
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, runWithRetry, throwIfSignalAborted, waitForRetryDelay, };
//# sourceMappingURL=async-utils.js.map