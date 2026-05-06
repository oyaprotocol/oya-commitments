interface CreateHttpConfigOptions {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}
interface HttpConfig {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}
interface HttpPostFetchOptions<TBody> {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: TBody;
    signal?: AbortSignal | undefined;
}
interface HttpTextResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}
interface HttpStatusErrorOptions {
    operation: string;
    status: number;
    statusText?: string;
    responseText?: string;
}
type HttpFetchLike<TOptions, TResponse> = (url: string, options: TOptions) => Promise<TResponse>;
type HttpPostFetchLike<TBody, TResponse = HttpTextResponse> = HttpFetchLike<HttpPostFetchOptions<TBody>, TResponse>;
declare const RETRYABLE_HTTP_NETWORK_ERROR_CODES: ReadonlySet<string>;
declare class HttpStatusError extends Error {
    readonly operation: string;
    readonly status: number;
    readonly statusText: string;
    readonly responseText: string | undefined;
    constructor({ operation, status, statusText, responseText }: HttpStatusErrorOptions);
}
declare function createHttpConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs }: CreateHttpConfigOptions, normalizeConfigUrl?: (url: string) => string): HttpConfig;
declare function hasRetryableNetworkErrorCode(error: unknown): boolean;
export { HttpStatusError, RETRYABLE_HTTP_NETWORK_ERROR_CODES, createHttpConfig, hasRetryableNetworkErrorCode, };
export type { CreateHttpConfigOptions, HttpConfig, HttpFetchLike, HttpPostFetchLike, HttpPostFetchOptions, HttpStatusErrorOptions, HttpTextResponse, };
