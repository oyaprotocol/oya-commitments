import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import {
    hasRetryableNetworkErrorCode,
    HttpStatusError,
    isPlainObject,
    readErrorStringChain,
    runWithRetry,
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

function shouldRetryError(error: unknown): boolean {
    if (!error) {
        return false;
    }
    if (error instanceof HttpStatusError) {
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
            'Ethereum JSON-RPC params must be JSON-serializable.',
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

async function requestEthereumJsonRpcWithCustomRetryPolicy<TResult = unknown>(
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

    return await runWithRetry<RequestEthereumJsonRpcResult<TResult>>({
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        timeoutMs: config.timeoutMs,
        signal,
        abortErrorMessage,
        shouldRetry: (error) =>
            shouldRetryJsonRpcMethod(normalizedMethod) && shouldRetryError(error),
        normalizeError: normalizeEthereumJsonRpcError,
        run: async ({ attempt, signal: requestSignal }) => {
            const response = await fetch(config.url, {
                method: 'POST',
                headers: {
                    ...config.headers,
                    'content-type': 'application/json',
                },
                body,
                signal: requestSignal,
            });
            const responseText = await response.text();

            if (!response.ok) {
                throw new HttpStatusError({
                    operation: 'Ethereum JSON-RPC request',
                    status: response.status,
                    statusText: response.statusText,
                    responseText,
                });
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
        },
    });
}

async function requestEthereumJsonRpc<TResult = unknown>(
    options: RequestEthereumJsonRpcOptions
): Promise<RequestEthereumJsonRpcResult<TResult>> {
    return await requestEthereumJsonRpcWithCustomRetryPolicy(options, shouldRetryMethod);
}

export {
    EthereumJsonRpcError,
    requestEthereumJsonRpc,
    requestEthereumJsonRpcWithCustomRetryPolicy,
};
