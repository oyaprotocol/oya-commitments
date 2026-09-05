# @oyaprotocol/ethereum

Ethereum JSON-RPC utilities for Oya kernel code. This package is a hardened kernel surface: callers provide explicit transport settings and explicit `fetch` implementations instead of relying on process-level defaults.

## Public Entrypoint

- `@oyaprotocol/ethereum`

## Current Surface

- `createHttpConfig(options)`: validate explicit HTTP transport settings, re-exported from `@oyaprotocol/utils`.
- `requestEthereumJsonRpc(options)`: send one JSON-RPC POST request with explicit config and injected `fetch`, returning the raw `result`, attempt count, id, and parsed response payload.
- `ethSendRawTransaction(options)`: submit a signed raw transaction and return the transaction hash with attempt metadata. Callers may pass `transactionHash` when they already know the hash, allowing the wrapper to verify duplicate-style retry errors with `eth_getTransactionByHash`.
- `ethGetTransactionReceipt(options)`: look up a transaction receipt, returning `{ receipt, attemptCount, response }`. The receipt is `null` when unavailable, including pending or unknown transactions.
- `ethWaitForTransactionReceipt(options)`: poll for a receipt with an explicit overall deadline, poll interval, and optional cancellation signal. Returns `{ receipt, pollCount, attemptCount, response }` with a non-null receipt.
- `EthereumJsonRpcError`: thrown when an HTTP-successful JSON-RPC response contains an `error` payload.
- `HttpStatusError`: thrown when the HTTP response itself is not successful, re-exported from `@oyaprotocol/utils`.
- `EthereumRawTransactionRecoveryError`: thrown when raw transaction submission may have succeeded before a retry returned a duplicate-style error, but the wrapper could not verify the supplied transaction hash.
- `EthereumTransactionReceiptTimeoutError`: thrown when the overall receipt wait expires, exposing `transactionHash`, `timeoutMs`, and `pollCount`.

## Behavior

`createHttpConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized by trimming trailing slashes before JSON-RPC requests are sent.

`requestEthereumJsonRpc(...)` owns the JSON-RPC envelope and request headers. It sends `content-type: application/json`, rejects caller-provided `content-type` config headers, enforces a request timeout, retries transient HTTP/network failures only for read-only Ethereum methods, and treats JSON-RPC error payloads as non-retryable semantic errors.

`ethSendRawTransaction(...)` does not sign transactions and does not compute transaction hashes. It expects callers to provide a signed raw transaction. If `transactionHash` is supplied and a retry of `eth_sendRawTransaction` returns duplicate-style JSON-RPC errors such as `already known` or `nonce too low`, the wrapper checks `eth_getTransactionByHash(transactionHash)` before returning a recovered result. Without `transactionHash`, those cases are surfaced as `EthereumRawTransactionRecoveryError` because the package cannot verify acceptance without Keccak hashing.

This package does not sign transactions, encode ABIs, read environment variables, or own RPC endpoint discovery. Callers are responsible for preparing JSON-RPC params, including converting `bigint` values to Ethereum quantity hex before calling the raw request primitive.

## Transaction Receipts

The host passes the hash returned by `ethSendRawTransaction(...)` to either receipt function, with the same explicit RPC config and injected fetch:

```ts
import {
    ethWaitForTransactionReceipt,
    EthereumTransactionReceiptTimeoutError,
} from '@oyaprotocol/ethereum';
import type { EthGetTransactionReceiptOptions } from '@oyaprotocol/ethereum';

async function observeTransaction(options: EthGetTransactionReceiptOptions) {
    try {
        const { receipt } = await ethWaitForTransactionReceipt({
            ...options, // config, fetch, transactionHash, optional signal/id
            timeoutMs: 60_000,
            pollIntervalMs: 1_000,
        });
        if (receipt.status !== 'success') {
            throw new Error(`Transaction execution status: ${receipt.status ?? 'unknown'}`);
        }
        return receipt;
    } catch (error) {
        if (error instanceof EthereumTransactionReceiptTimeoutError) {
            // The host can retain error.transactionHash and resume observation later.
        }
        throw error;
    }
}
```

Both functions return an `EthereumTransactionReceipt` whose quantities (block number, gas, fees, transaction/log indexes, and transaction type) are `bigint`. Hashes, addresses, topics, and data preserve RPC hex casing. Hash comparison is case-insensitive. Receipts and their `EthereumReceiptLog` entries are validated, including log block/transaction identity, byte lengths, and canonical quantity encoding. `to` and `contractAddress` are nullable; `type`, `effectiveGasPrice`, blob fees/gas, log `removed`, and log `blockTimestamp` are optional and validated when present. The original JSON-RPC envelope remains available as `response: unknown`; provider-specific fields are not copied into normalized receipts. Normalized quantities need explicit conversion before JSON serialization.

The normalized `status` is `'success'` or `'reverted'`. Historical receipts containing a state `root` instead of an execution status return `status: null` and preserve the root; the wrapper does not infer whether those transactions succeeded. These status distinctions follow [EIP-658](https://eips.ethereum.org/EIPS/eip-658) and the [Ethereum receipt schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/receipt.yaml).

Waiting performs the first lookup immediately and pauses for `pollIntervalMs` after each `null` result. Each lookup uses the existing bounded RPC retry policy for transient failures. `pollCount` counts logical lookups, while `attemptCount` totals their HTTP attempts; `response` is the final lookup's envelope. A reverted receipt ends the wait normally, letting the host choose its failure policy. Malformed receipts, JSON-RPC errors, and exhausted transport retries reject the wait immediately.

The wait's `timeoutMs` covers all lookups, request retries, and intervening delays. `config.timeoutMs` still limits each individual HTTP attempt. Both wait durations must be positive integers no greater than 2,147,483,647 ms. Caller cancellation interrupts requests and delays; its error preserves `signal.reason` as `cause` and takes precedence if the caller and deadline have both aborted. Timers and signal listeners are cleaned up on completion or failure, including when an injected transport ignores its signal.

The wait returns the first mined receipt reported by the RPC endpoint. It does not track confirmation depth, chain reorganizations, or replacement transactions, and a timeout does not establish that a transaction failed. Logger event decoding and verification belong to a later integration step.

## Validation

Run from the repository root; tests use injected transports and require no live RPC:

```sh
npm --prefix packages run build
node --test packages/ethereum/test/*.test.js
packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
```
