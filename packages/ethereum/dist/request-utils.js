import { isPlainObject } from '@oyaprotocol/utils';
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
class EthereumJsonRpcHttpError extends Error {
    status;
    responseText;
    constructor(message, { status, responseText }) {
        super(message);
        this.name = 'EthereumJsonRpcHttpError';
        this.status = status;
        this.responseText = responseText;
    }
}
class EthereumJsonRpcError extends Error {
    code;
    data;
    method;
    response;
    constructor(error, { method, response }) {
        const message = typeof error.message === 'string' && error.message.trim()
            ? error.message.trim()
            : `Ethereum JSON-RPC ${method} failed.`;
        super(message);
        this.name = 'EthereumJsonRpcError';
        this.code = typeof error.code === 'number' ? error.code : null;
        if ('data' in error) {
            this.data = error.data;
        }
        this.method = method;
        this.response = response;
    }
}
function isEthereumJsonRpcHttpError(error) {
    return error instanceof EthereumJsonRpcHttpError;
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
    if (isEthereumJsonRpcHttpError(error)) {
        return error.status === 429 || error.status >= 500;
    }
    if (error instanceof EthereumJsonRpcError) {
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
function normalizeJsonRpcId(id) {
    if (id === undefined) {
        return 1;
    }
    if (typeof id === 'string' && id.trim()) {
        return id;
    }
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
        return id;
    }
    throw new Error('id must be a non-empty string or safe integer.');
}
function buildJsonRpcBody({ id, method, params, }) {
    try {
        return JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params,
        });
    }
    catch (error) {
        throw new Error('Ethereum JSON-RPC params must be JSON-serializable; convert bigint values to quantity hex strings before calling requestEthereumJsonRpc.', { cause: error });
    }
}
function parseJsonRpcResponse({ text, method, id, }) {
    let response;
    try {
        response = JSON.parse(text);
    }
    catch (error) {
        throw new Error('Ethereum JSON-RPC response was not valid JSON.', { cause: error });
    }
    if (!isPlainObject(response)) {
        throw new Error('Ethereum JSON-RPC response must be an object.');
    }
    if (response.jsonrpc !== '2.0') {
        throw new Error('Ethereum JSON-RPC response must use jsonrpc "2.0".');
    }
    if ('error' in response) {
        const errorPayload = isPlainObject(response.error) ? response.error : {};
        throw new EthereumJsonRpcError(errorPayload, { method, response });
    }
    if (!('result' in response)) {
        throw new Error('Ethereum JSON-RPC response did not include a result.');
    }
    if (response.id !== id) {
        throw new Error('Ethereum JSON-RPC response id did not match request id.');
    }
    return {
        result: response.result,
        response,
    };
}
function normalizeEthereumJsonRpcError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('Ethereum JSON-RPC request failed.');
    }
    return new Error(`Ethereum JSON-RPC request failed: ${String(error)}`);
}
async function requestEthereumJsonRpc({ config, fetch, method, params = [], id, signal, }) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    if (typeof method !== 'string' || !method.trim()) {
        throw new Error('method must be a non-empty string.');
    }
    if (!Array.isArray(params)) {
        throw new Error('params must be an array.');
    }
    const normalizedMethod = method.trim();
    const normalizedId = normalizeJsonRpcId(id);
    const body = buildJsonRpcBody({
        id: normalizedId,
        method: normalizedMethod,
        params,
    });
    const abortErrorMessage = 'requestEthereumJsonRpc was aborted by the caller.';
    let lastError = null;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(() => fetch(config.rpcUrl, {
                method: 'POST',
                headers: {
                    ...config.headers,
                    'content-type': 'application/json',
                },
                body,
                signal: requestSignal.signal,
            }), requestSignal.signal);
            const responseText = await invokeWithAbort(() => response.text(), requestSignal.signal);
            if (!response.ok) {
                throw new EthereumJsonRpcHttpError(`Ethereum JSON-RPC request failed with ${response.status} ${response.statusText || 'Unknown Status'}.`, {
                    status: response.status,
                    responseText,
                });
            }
            const parsed = parseJsonRpcResponse({
                text: responseText,
                method: normalizedMethod,
                id: normalizedId,
            });
            return {
                result: parsed.result,
                attemptCount: attempt,
                id: normalizedId,
                response: parsed.response,
            };
        }
        catch (error) {
            lastError = error;
            throwIfSignalAborted(signal, abortErrorMessage, error);
            if (attempt <= config.maxRetries && shouldRetryError(error)) {
                await waitForRetryDelay({
                    retryDelayMs: config.retryDelayMs,
                    signal,
                    abortErrorMessage,
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
    throw normalizeEthereumJsonRpcError(lastError);
}
export { EthereumJsonRpcError, EthereumJsonRpcHttpError, requestEthereumJsonRpc, };
//# sourceMappingURL=request-utils.js.map