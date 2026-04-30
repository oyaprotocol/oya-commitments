const RETRYABLE_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);
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
    const names = readErrorStringChain(error, 'name');
    if (names.includes('TimeoutError')) {
        return true;
    }
    const codes = readErrorStringChain(error, 'code');
    for (const code of codes) {
        if (RETRYABLE_ERROR_CODES.has(code.toUpperCase())) {
            return true;
        }
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
    const listeners = [];
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
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
//# sourceMappingURL=ipfs-request-utils.js.map