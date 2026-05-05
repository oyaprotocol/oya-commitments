import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import {
    combineAbortSignals,
    createTimeoutSignal,
    hasRetryableNetworkErrorCode,
    invokeWithAbort,
    isPlainObject,
    throwIfSignalAborted,
    waitForRetryDelay,
} from '@oyaprotocol/utils';

const RETRYABLE_JSON_RPC_METHODS = new Set([
    'eth_accounts',
    'eth_blobBaseFee',
    'eth_blockNumber',
    'eth_call',
    'eth_chainId',
    'eth_coinbase',
    'eth_createAccessList',
    'eth_estimateGas',
    'eth_feeHistory',
    'eth_gasPrice',
    'eth_getBalance',
    'eth_getBlockByHash',
    'eth_getBlockByNumber',
    'eth_getBlockReceipts',
    'eth_getBlockTransactionCountByHash',
    'eth_getBlockTransactionCountByNumber',
    'eth_getCode',
    'eth_getLogs',
    'eth_getProof',
    'eth_getStorageAt',
    'eth_getTransactionByBlockHashAndIndex',
    'eth_getTransactionByBlockNumberAndIndex',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_getUncleByBlockHashAndIndex',
    'eth_getUncleByBlockNumberAndIndex',
    'eth_getUncleCountByBlockHash',
    'eth_getUncleCountByBlockNumber',
    'eth_hashrate',
    'eth_maxPriorityFeePerGas',
    'eth_mining',
    'eth_protocolVersion',
    'eth_syncing',
    'net_listening',
    'net_peerCount',
    'net_version',
    'web3_clientVersion',
    'web3_sha3',
]);

export interface RequestEthereumJsonRpcOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
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

interface EthereumJsonRpcHttpErrorOptions {
    status: number;
    responseText?: string;
}

interface EthereumJsonRpcErrorOptions {
    method: string;
    response: unknown;
    attemptCount?: number;
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
    readonly attemptCount: number;
    readonly code: number | null;
    readonly data?: unknown;
    readonly method: string;
    readonly response: unknown;

    constructor(
        error: JsonRpcErrorPayload,
        { method, response, attemptCount = 1 }: EthereumJsonRpcErrorOptions
    ) {
        const message =
            typeof error.message === 'string' && error.message.trim()
                ? error.message.trim()
                : `Ethereum JSON-RPC ${method} failed.`;
        super(message);
        this.name = 'EthereumJsonRpcError';
        this.attemptCount = attemptCount;
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

function shouldRetryMethod(method: string): boolean {
    return RETRYABLE_JSON_RPC_METHODS.has(method);
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
    attemptCount,
}: {
    text: string;
    method: string;
    id: string | number;
    attemptCount: number;
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
    if (response.id !== id) {
        throw new Error('Ethereum JSON-RPC response id did not match request id.');
    }
    if ('error' in response) {
        const errorPayload = isPlainObject(response.error) ? response.error : {};
        throw new EthereumJsonRpcError(errorPayload, {
            method,
            response,
            attemptCount,
        });
    }
    if (!('result' in response)) {
        throw new Error('Ethereum JSON-RPC response did not include a result.');
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

async function requestEthereumJsonRpcWithRetryPolicy<TResult = unknown>(
    {
        config,
        fetch,
        method,
        params = [],
        id,
        signal,
    }: RequestEthereumJsonRpcOptions,
    shouldRetryJsonRpcMethod: (method: string) => boolean
): Promise<RequestEthereumJsonRpcResult<TResult>> {
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
                    fetch(config.url, {
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
                attemptCount: attempt,
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
            if (
                attempt <= config.maxRetries &&
                shouldRetryJsonRpcMethod(normalizedMethod) &&
                shouldRetryError(error)
            ) {
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

async function requestEthereumJsonRpc<TResult = unknown>(
    options: RequestEthereumJsonRpcOptions
): Promise<RequestEthereumJsonRpcResult<TResult>> {
    return await requestEthereumJsonRpcWithRetryPolicy(options, shouldRetryMethod);
}

export {
    EthereumJsonRpcError,
    EthereumJsonRpcHttpError,
    requestEthereumJsonRpc,
    requestEthereumJsonRpcWithRetryPolicy,
};
