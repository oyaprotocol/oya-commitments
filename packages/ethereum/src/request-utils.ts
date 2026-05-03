import type { EthereumRpcConfig } from './config.js';
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

export type EthereumJsonRpcFetchLike = (
    url: string,
    options: EthereumJsonRpcFetchOptions
) => Promise<EthereumJsonRpcResponse>;

export interface EthereumJsonRpcFetchOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal | undefined;
}

export interface EthereumJsonRpcResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

export interface RequestEthereumJsonRpcOptions {
    config: EthereumRpcConfig;
    fetch: EthereumJsonRpcFetchLike;
    method: string;
    params?: readonly unknown[];
    id?: string | number;
    signal?: AbortSignal;
}

export interface RequestEthereumJsonRpcResult<TResult = unknown> {
    result: TResult;
    attemptCount: number;
    id: string | number;
    response: unknown;
}

interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}

interface EthereumJsonRpcHttpErrorOptions {
    status: number;
    responseText?: string;
}

interface EthereumJsonRpcErrorOptions {
    method: string;
    response: unknown;
}

interface JsonRpcErrorPayload {
    code?: unknown;
    message?: unknown;
    data?: unknown;
}

class EthereumJsonRpcHttpError extends Error {
    readonly status: number;
    readonly responseText: string | undefined;

    constructor(message: string, { status, responseText }: EthereumJsonRpcHttpErrorOptions) {
        super(message);
        this.name = 'EthereumJsonRpcHttpError';
        this.status = status;
        this.responseText = responseText;
    }
}

class EthereumJsonRpcError extends Error {
    readonly code: number | null;
    readonly data?: unknown;
    readonly method: string;
    readonly response: unknown;

    constructor(error: JsonRpcErrorPayload, { method, response }: EthereumJsonRpcErrorOptions) {
        const message =
            typeof error.message === 'string' && error.message.trim()
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

function isEthereumJsonRpcHttpError(error: unknown): error is EthereumJsonRpcHttpError {
    return error instanceof EthereumJsonRpcHttpError;
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

function normalizeJsonRpcId(id: unknown): string | number {
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

function buildJsonRpcBody({
    id,
    method,
    params,
}: {
    id: string | number;
    method: string;
    params: readonly unknown[];
}): string {
    try {
        return JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params,
        });
    } catch (error) {
        throw new Error(
            'Ethereum JSON-RPC params must be JSON-serializable; convert bigint values to quantity hex strings before calling requestEthereumJsonRpc.',
            { cause: error }
        );
    }
}

function parseJsonRpcResponse({
    text,
    method,
    id,
}: {
    text: string;
    method: string;
    id: string | number;
}): { result: unknown; response: unknown } {
    let response: unknown;
    try {
        response = JSON.parse(text) as unknown;
    } catch (error) {
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

function normalizeEthereumJsonRpcError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('Ethereum JSON-RPC request failed.');
    }
    return new Error(`Ethereum JSON-RPC request failed: ${String(error)}`);
}

async function requestEthereumJsonRpc<TResult = unknown>({
    config,
    fetch,
    method,
    params = [],
    id,
    signal,
}: RequestEthereumJsonRpcOptions): Promise<RequestEthereumJsonRpcResult<TResult>> {
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
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(
                () =>
                    fetch(config.rpcUrl, {
                        method: 'POST',
                        headers: {
                            ...config.headers,
                            'content-type': 'application/json',
                        },
                        body,
                        signal: requestSignal.signal,
                    }),
                requestSignal.signal
            );
            const responseText = await invokeWithAbort(() => response.text(), requestSignal.signal);

            if (!response.ok) {
                throw new EthereumJsonRpcHttpError(
                    `Ethereum JSON-RPC request failed with ${response.status} ${
                        response.statusText || 'Unknown Status'
                    }.`,
                    {
                        status: response.status,
                        responseText,
                    }
                );
            }

            const parsed = parseJsonRpcResponse({
                text: responseText,
                method: normalizedMethod,
                id: normalizedId,
            });

            return {
                result: parsed.result as TResult,
                attemptCount: attempt,
                id: normalizedId,
                response: parsed.response,
            };
        } catch (error) {
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
        } finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }

    throw normalizeEthereumJsonRpcError(lastError);
}

export {
    EthereumJsonRpcError,
    EthereumJsonRpcHttpError,
    requestEthereumJsonRpc,
};
