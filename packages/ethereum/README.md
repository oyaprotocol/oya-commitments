# @oyaprotocol/ethereum

Ethereum JSON-RPC utilities for Oya kernel code. This package is a hardened kernel surface: callers provide explicit transport settings and explicit `fetch` implementations instead of relying on process-level defaults.

## Public Entrypoint

- `@oyaprotocol/ethereum`

## Current Surface

- `createEthereumRpcConfig(options)`: validate explicit JSON-RPC transport settings.
- `requestEthereumJsonRpc(options)`: send one JSON-RPC POST request with explicit config and injected `fetch`, returning the raw `result`, attempt count, id, and parsed response payload.
- `EthereumJsonRpcError`: thrown when an HTTP-successful JSON-RPC response contains an `error` payload.
- `EthereumJsonRpcHttpError`: thrown when the HTTP response itself is not successful.

## Behavior

`requestEthereumJsonRpc(...)` owns the JSON-RPC envelope and request headers. It sends `content-type: application/json`, rejects caller-provided `content-type` config headers, enforces a request timeout, retries transient HTTP/network failures, and treats JSON-RPC error payloads as non-retryable semantic errors.

This package does not sign transactions, encode ABIs, read environment variables, or own RPC endpoint discovery. Callers are responsible for preparing JSON-RPC params, including converting `bigint` values to Ethereum quantity hex before calling the raw request primitive.
