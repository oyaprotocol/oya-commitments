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
- `encodeLoggerCall(cid)`: encode calldata for the Oya Logger's `log(string)` function.
- `decodeLoggerEvent(log, loggerAddress)`: decode a `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` event from the expected Logger, returning `{ node, cidKeccak256Hash, cid, removed? }` or `null` for an unrelated log.
- `EthereumJsonRpcError`: thrown when an HTTP-successful JSON-RPC response contains an `error` payload.
- `HttpStatusError`: thrown when the HTTP response itself is not successful, re-exported from `@oyaprotocol/utils`.
- `EthereumRawTransactionRecoveryError`: thrown when raw transaction submission may have succeeded before a retry returned a duplicate-style error, but the wrapper could not verify the supplied transaction hash.
- `EthereumTransactionReceiptTimeoutError`: thrown when the overall receipt wait expires, exposing `transactionHash`, `timeoutMs`, and `pollCount`.

## Behavior

`createHttpConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized by trimming trailing slashes before JSON-RPC requests are sent.

`requestEthereumJsonRpc(...)` owns the JSON-RPC envelope and request headers. It sends `content-type: application/json`, rejects caller-provided `content-type` config headers, enforces a request timeout, retries transient HTTP/network failures only for read-only Ethereum methods, and treats JSON-RPC error payloads as non-retryable semantic errors.

`ethSendRawTransaction(...)` does not sign transactions and does not compute transaction hashes. It expects callers to provide a signed raw transaction. If `transactionHash` is supplied and a retry of `eth_sendRawTransaction` returns duplicate-style JSON-RPC errors such as `already known` or `nonce too low`, the wrapper checks `eth_getTransactionByHash(transactionHash)` before returning a recovered result. Without `transactionHash`, those cases are surfaced as `EthereumRawTransactionRecoveryError` because the package cannot verify acceptance without Keccak hashing.

Hosts own transaction signing, environment configuration, and RPC endpoint discovery. ABI support is limited to the Logger helpers described below. Callers are responsible for preparing JSON-RPC params, including converting `bigint` values to Ethereum quantity hex before calling the raw request primitive.

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

The wait returns the first mined receipt reported by the RPC endpoint. It does not track confirmation depth, chain reorganizations, or replacement transactions, and a timeout does not establish that a transaction failed. Hosts can use the Logger helper below to inspect receipt events.

## Logger ABI Helpers

The pure, synchronous helpers in `src/logger.ts` target [`Logger.sol`](../../contracts/src/Logger.sol). They use its fixed function selector and event signature, checked with Foundry, and implement its single-string ABI layout without additional dependencies. The encoding follows the [Solidity ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html).

`encodeLoggerCall(cid)` returns the complete `0x`-prefixed calldata. It preserves empty strings, whitespace, Unicode, and embedded null characters, using UTF-8 byte lengths and ABI padding. It imposes no CID syntax policy. JavaScript strings containing unpaired surrogates throw because encoding them would silently change the text. The host supplies the Logger address and prepares the remaining transaction fields, signs, and submits the transaction.

`decodeLoggerEvent(log, loggerAddress)` accepts `LoggerEventInput`, which selects `address`, `topics`, `data`, and optional `removed` from `EthereumReceiptLog`. Pass receipt logs directly. The expected address is required and must be 20-byte hex. Other emitter addresses or event signatures, including logs with no topics, return `null`. Malformed input or a matching event with invalid topics, address padding, data offset, length, padding, or UTF-8 throws. Decoding checks lengths before allocating from an untrusted declared length, and requires the canonical layout emitted by Solidity, without extra trailing data.

The decoded `LoggerEvent` preserves the indexed node and `cidKeccak256Hash` hex casing and exact CID text, including a leading Unicode BOM. The decoder requires exactly three topics and validates the hash as 32-byte hex. It returns the supplied hash without recomputing it; the Logger contract computes `keccak256(bytes(cid))` when emitting the event. Address and event-signature matching is case-insensitive. Optional `removed` metadata is preserved, including `true`; decoding alone does not establish successful execution or finality. The expected node is the immediate caller of Logger, which may be a contract wallet and may differ from the signed message's signer.

To find events for a known CID, the host computes Keccak-256 of its exact UTF-8 bytes and supplies an `eth_getLogs` filter with the Logger address, the desired block range, and `topics: ['0xce2d845fcf02211a951a2153c1ddf64ec48ef6d54644ea188101f10018b871dc', null, cidKeccak256Hash]`. The `null` permits any node address. This hash is separate from the content hash embedded in the CID; different text representations of equivalent CIDs produce different lookup hashes. The host supplies the hashing implementation. The previous two-topic `Log(address,string)` event is unrelated to this new signature and decodes to `null`.

For example, a host can prepare the call and later verify its receipt:

```ts
import { encodeLoggerCall, decodeLoggerEvent } from '@oyaprotocol/ethereum';

const transaction = {
    to: loggerAddress,
    data: encodeLoggerCall(publication.cid),
    value: 0n,
};
// The host prepares, signs, and submits transaction, then obtains its receipt.

if (receipt.status !== 'success') {
    throw new Error('Logger transaction did not succeed.');
}
const event = receipt.logs
    .map((log) => decodeLoggerEvent(log, loggerAddress))
    .find((entry) => entry !== null && entry.removed !== true &&
        entry.node.toLowerCase() === expectedNode.toLowerCase() &&
        entry.cid === publication.cid);
if (!event) {
    throw new Error('Receipt did not contain the expected Logger event.');
}
```

These helpers require standard `TextEncoder`, `TextDecoder`, and `String.prototype.isWellFormed`, consistent with the package's ECMAScript 2025 target. Hosts choose confirmation policy and compose publication with transaction submission; the helpers perform no network calls.

## Validation

Run from the repository root; tests use injected transports and require no live RPC:

```sh
npm --prefix packages run build
node --test packages/ethereum/test/*.test.js
packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
```

`test/fixtures/logger-abi.json` contains independent Foundry-generated ABI vectors. Its exact UTF-8 bytes were encoded with `cast abi-encode 'f(bytes)' <hexBytes>` because ABI `bytes` and `string` share the same layout and the CLI's string parser strips trailing newlines. Calldata prefixes the selector obtained from `forge inspect --root contracts --offline Logger methodIdentifiers --json`; ordinary string cases were also checked with `cast calldata 'log(string)' <cid>`. The shared signature and node topics were generated with `cast keccak 'Log(address,bytes32,string)'` and `cast abi-encode 'f(address)' <node>`. Each case adds its own `cidKeccak256Hash`, generated with `cast keccak <hexBytes>` over the exact UTF-8 CID bytes.
