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

## HTTP Network Retry Helpers

- `RETRYABLE_HTTP_NETWORK_ERROR_CODES`
- `hasRetryableNetworkErrorCode(error)`
