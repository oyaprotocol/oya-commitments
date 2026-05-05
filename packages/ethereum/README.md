# @oyaprotocol/ethereum

Ethereum JSON-RPC utilities for Oya kernel code. This package is a hardened kernel surface: callers provide explicit transport settings and explicit `fetch` implementations instead of relying on process-level defaults.

## Public Entrypoint

- `@oyaprotocol/ethereum`

## Current Surface

- `createHttpConfig(options)`: validate explicit HTTP transport settings, re-exported from `@oyaprotocol/utils`.
- `requestEthereumJsonRpc(options)`: send one JSON-RPC POST request with explicit config and injected `fetch`, returning the raw `result`, attempt count, id, and parsed response payload.
- `ethSendRawTransaction(options)`: submit a signed raw transaction and return the transaction hash with attempt metadata. Callers may pass `transactionHash` when they already know the hash, allowing the wrapper to verify duplicate-style retry errors with `eth_getTransactionByHash`.
- `EthereumJsonRpcError`: thrown when an HTTP-successful JSON-RPC response contains an `error` payload.
- `EthereumJsonRpcHttpError`: thrown when the HTTP response itself is not successful.
- `EthereumRawTransactionRecoveryError`: thrown when raw transaction submission may have succeeded before a retry returned a duplicate-style error, but the wrapper could not verify the supplied transaction hash.

## Behavior

`createHttpConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized by trimming trailing slashes before JSON-RPC requests are sent.

`requestEthereumJsonRpc(...)` owns the JSON-RPC envelope and request headers. It sends `content-type: application/json`, rejects caller-provided `content-type` config headers, enforces a request timeout, retries transient HTTP/network failures only for read-only Ethereum methods, and treats JSON-RPC error payloads as non-retryable semantic errors.

`ethSendRawTransaction(...)` does not sign transactions and does not compute transaction hashes. It expects callers to provide a signed raw transaction. If `transactionHash` is supplied and a retry of `eth_sendRawTransaction` returns duplicate-style JSON-RPC errors such as `already known` or `nonce too low`, the wrapper checks `eth_getTransactionByHash(transactionHash)` before returning a recovered result. Without `transactionHash`, those cases are surfaced as `EthereumRawTransactionRecoveryError` because the package cannot verify acceptance without Keccak hashing.

This package does not sign transactions, encode ABIs, read environment variables, or own RPC endpoint discovery. Callers are responsible for preparing JSON-RPC params, including converting `bigint` values to Ethereum quantity hex before calling the raw request primitive.
