# @oyaprotocol/utils

Small shared utilities for hardened Oya kernel packages.

## Public Entrypoint

- `@oyaprotocol/utils`

## Validation Helpers

- `assertAsciiBytes(bytes, message)`
- `assertBytes32HexString(value, label)`
- `assertNonEmptyString(value, label)`
- `assertHexData(value, label)`
- `assertHexString(value, label)`
- `assertPositiveInteger(value, label)`
- `assertNonNegativeInteger(value, label)`
- `assertHeadersObject(headers, label, options)`
- `isPlainObject(value)`

## HTTP Utilities

- `CreateHttpConfigOptions`
- `HttpConfig`
- `createHttpConfig(options, normalizeUrl?)`
- `HttpFetchLike<TOptions, TResponse>`
- `HttpPostFetchLike<TBody, TResponse>`
- `HttpPostFetchOptions<TBody>`
- `HttpTextResponse`
- `RETRYABLE_HTTP_NETWORK_ERROR_CODES`
- `hasRetryableNetworkErrorCode(error)`

## Async Utilities

- `AbortSignalHandle`
- `createTimeoutSignal(timeoutMs)`
- `combineAbortSignals(signals)`
- `invokeWithAbort(createPromise, signal)`
- `throwIfSignalAborted(signal, message, cause)`
- `waitForRetryDelay(options)`
