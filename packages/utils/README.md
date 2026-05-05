# @oyaprotocol/utils

Small shared utilities for hardened Oya kernel packages.

## Public Entrypoint

- `@oyaprotocol/utils`

## Validation Helpers

- `assertNonEmptyString(value, label)`
- `assertPositiveInteger(value, label)`
- `assertNonNegativeInteger(value, label)`
- `assertHeadersObject(headers, label, options)`
- `isPlainObject(value)`

## HTTP Config Types

- `CreateHttpConfigOptions`
- `HttpConfig`

## HTTP Config Helpers

- `createHttpConfig(options, normalizeUrl?)`

## HTTP Fetch Types

- `HttpFetchLike<TOptions, TResponse>`
- `HttpPostFetchLike<TBody, TResponse>`
- `HttpPostFetchOptions<TBody>`
- `HttpTextResponse`

## HTTP Network Retry Helpers

- `RETRYABLE_HTTP_NETWORK_ERROR_CODES`
- `hasRetryableNetworkErrorCode(error)`

## Abort Helpers

- `AbortSignalHandle`
- `createTimeoutSignal(timeoutMs)`
- `combineAbortSignals(signals)`
- `invokeWithAbort(createPromise, signal)`
- `throwIfSignalAborted(signal, message, cause)`

## Retry Helpers

- `waitForRetryDelay(options)`
