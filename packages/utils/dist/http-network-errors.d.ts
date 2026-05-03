declare const RETRYABLE_HTTP_NETWORK_ERROR_CODES: ReadonlySet<string>;
declare function hasRetryableNetworkErrorCode(error: unknown): boolean;
export { RETRYABLE_HTTP_NETWORK_ERROR_CODES, hasRetryableNetworkErrorCode };
