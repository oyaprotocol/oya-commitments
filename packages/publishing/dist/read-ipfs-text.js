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
function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}
function assertPositiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
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
function normalizeReadError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('IPFS text read failed.');
    }
    return new Error(`IPFS text read failed: ${String(error)}`);
}
function isHttpReadError(error) {
    return error instanceof Error && typeof error.status === 'number';
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
function cancelReader(reader, reason) {
    reader.cancel(reason).catch(() => { });
}
function assertAsciiChunk(chunk) {
    for (const byte of chunk) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
}
function combineChunks(chunks, byteLength) {
    const combined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}
async function readBoundedAsciiText({ body, maxBytes, signal, }) {
    if (!body || typeof body.getReader !== 'function') {
        throw new Error('IPFS cat response body must be a ReadableStream.');
    }
    const reader = body.getReader();
    const chunks = [];
    let byteLength = 0;
    let completed = false;
    try {
        while (true) {
            const readResult = await invokeWithAbort(() => reader.read(), signal);
            if (readResult.done) {
                completed = true;
                break;
            }
            const chunk = readResult.value;
            if (!(chunk instanceof Uint8Array)) {
                throw new Error('IPFS cat response body chunks must be Uint8Array values.');
            }
            byteLength += chunk.byteLength;
            if (byteLength > maxBytes) {
                throw new Error(`IPFS cat response exceeded maxBytes (${maxBytes}).`);
            }
            assertAsciiChunk(chunk);
            chunks.push(chunk);
        }
    }
    catch (error) {
        cancelReader(reader, error);
        throw error;
    }
    finally {
        if (completed) {
            reader.releaseLock();
        }
    }
    const bytes = combineChunks(chunks, byteLength);
    return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        byteLength,
    };
}
async function readIpfsText({ config, fetch, cid, maxBytes, signal, }) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');
    const throwIfCallerAborted = (cause) => {
        if (signal?.aborted) {
            throw new Error('readIpfsText was aborted by the caller.', { cause });
        }
    };
    const waitForRetryDelay = async () => {
        if (config.retryDelayMs <= 0) {
            return;
        }
        throwIfCallerAborted(signal?.reason);
        await new Promise((resolve) => {
            if (!signal) {
                setTimeout(resolve, config.retryDelayMs);
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
            timer = setTimeout(finish, config.retryDelayMs);
        });
        throwIfCallerAborted(signal?.reason);
    };
    let lastError = null;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(() => fetch(`${config.apiUrl}/api/v0/cat?arg=${encodeURIComponent(trimmedCid)}`, {
                method: 'POST',
                headers: config.headers,
                signal: requestSignal.signal,
            }), requestSignal.signal);
            if (!response.ok) {
                const httpError = Object.assign(new Error(`IPFS cat failed with ${response.status} ${response.statusText || 'Unknown Status'}.`), {
                    status: response.status,
                });
                if (attempt <= config.maxRetries &&
                    (response.status === 429 || response.status >= 500)) {
                    await waitForRetryDelay();
                    continue;
                }
                throw httpError;
            }
            const { text, byteLength } = await readBoundedAsciiText({
                body: response.body,
                maxBytes: byteLimit,
                signal: requestSignal.signal,
            });
            return {
                cid: trimmedCid,
                uri: `ipfs://${trimmedCid}`,
                text,
                byteLength,
                attemptCount: attempt,
            };
        }
        catch (error) {
            lastError = error;
            throwIfCallerAborted(error);
            if (attempt <= config.maxRetries &&
                !isHttpReadError(error) &&
                shouldRetryError(error)) {
                await waitForRetryDelay();
                continue;
            }
            break;
        }
        finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }
    throw normalizeReadError(lastError);
}
export { readIpfsText };
//# sourceMappingURL=read-ipfs-text.js.map