import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
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
declare class EthereumJsonRpcError extends Error {
    readonly attemptCount: number;
    readonly code: number | null;
    readonly data?: unknown;
    readonly method: string;
    readonly response: unknown;
    constructor(error: JsonRpcErrorPayload, { method, response, attemptCount }: EthereumJsonRpcErrorOptions);
}
declare function requestEthereumJsonRpcWithCustomRetryPolicy<TResult = unknown>({ config, fetch, method, params, id, signal, }: RequestEthereumJsonRpcOptions, shouldRetryJsonRpcMethod: (method: string) => boolean): Promise<RequestEthereumJsonRpcResult<TResult>>;
declare function requestEthereumJsonRpc<TResult = unknown>(options: RequestEthereumJsonRpcOptions): Promise<RequestEthereumJsonRpcResult<TResult>>;
export { EthereumJsonRpcError, requestEthereumJsonRpc, requestEthereumJsonRpcWithCustomRetryPolicy, };
