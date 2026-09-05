# @oyaprotocol/utils

Small shared utilities for hardened Oya kernel packages.

## Public Entrypoint

- `@oyaprotocol/utils`

## Validation Helpers

- `assertAsciiBytes(bytes, message)`
- `assertBytes32HexString(value, label)`
- `assertCanonicalCid(value, label)`: requires CIDv1, lowercase unpadded Base32, and a SHA-256 multihash with a 32-byte digest. Returns the original string; rejects whitespace, paths, URIs, CIDv0, alternate bases, nonminimal integer encodings, and invalid Base32 padding bits. Checks codec encoding without maintaining a codec registry allowlist. This validates identifier structure, not content or availability.
- `assertNonEmptyString(value, label)`
- `assertHexData(value, label)`
- `assertHexString(value, label)`
- `assertPositiveInteger(value, label)`
- `assertNonNegativeInteger(value, label)`
- `assertHeadersObject(headers, label, options)`
- `isPlainObject(value)`
- `parseBytes(value, name, size?)`: validates `0x`-prefixed, byte-aligned hex, optionally requiring an exact byte count. Returns the original string without trimming; accepts `0x` when no size is required.

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
- `RETRYABLE_HTTP_NETWORK_ERROR_CODES` (runtime-immutable `ReadonlySet<string>` with the full ES2025 Set algebra API)
- `hasRetryableNetworkErrorCode(error)`
- `readErrorStringChain(error, key)`

## Async Utilities

- `assertTimerMs(value, name)`: validates a positive integer duration up to 2,147,483,647 ms, avoiding timer overflow.
- `AbortSignalHandle`
- `RunWithRetryAttemptContext`
- `RunWithRetryOptions`
- `createTimeoutSignal(timeoutMs)`
- `combineAbortSignals(signals)`
- `invokeWithAbort(createPromise, signal)`
- `runWithRetry(options)`
- `throwIfSignalAborted(signal, message, cause)`
- `waitForRetryDelay(options)`
