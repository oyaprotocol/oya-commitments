import type { HttpConfig } from '@oyaprotocol/utils';
export type EthereumJsonRpcFetchLike = (url: string, options: EthereumJsonRpcFetchOptions) => Promise<EthereumJsonRpcResponse>;
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
    config: HttpConfig;
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
declare class EthereumJsonRpcHttpError extends Error {
    readonly status: number;
    readonly responseText: string | undefined;
    constructor(message: string, { status, responseText }: EthereumJsonRpcHttpErrorOptions);
}
declare class EthereumJsonRpcError extends Error {
    readonly attemptCount: number;
    readonly code: number | null;
    readonly data?: unknown;
    readonly method: string;
    readonly response: unknown;
    constructor(error: JsonRpcErrorPayload, { method, response, attemptCount }: EthereumJsonRpcErrorOptions);
}
declare function requestEthereumJsonRpcWithRetryPolicy<TResult = unknown>({ config, fetch, method, params, id, signal, }: RequestEthereumJsonRpcOptions, shouldRetryJsonRpcMethod: (method: string) => boolean): Promise<RequestEthereumJsonRpcResult<TResult>>;
declare function requestEthereumJsonRpc<TResult = unknown>(options: RequestEthereumJsonRpcOptions): Promise<RequestEthereumJsonRpcResult<TResult>>;
export { EthereumJsonRpcError, EthereumJsonRpcHttpError, requestEthereumJsonRpc, requestEthereumJsonRpcWithRetryPolicy, };
