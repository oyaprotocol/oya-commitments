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
- `HttpStatusError`
- `HttpStatusErrorOptions`
- `HttpTextResponse`
- `ImmutableSetView<T>`
- `RETRYABLE_HTTP_NETWORK_ERROR_CODES` (runtime-immutable `ImmutableSetView<string>`)
- `hasRetryableNetworkErrorCode(error)`
- `readErrorStringChain(error, key)`

## Async Utilities

- `AbortSignalHandle`
- `RunWithRetryAttemptContext`
- `RunWithRetryOptions`
- `createTimeoutSignal(timeoutMs)`
- `combineAbortSignals(signals)`
- `invokeWithAbort(createPromise, signal)`
- `runWithRetry(options)`
- `throwIfSignalAborted(signal, message, cause)`
- `waitForRetryDelay(options)`
