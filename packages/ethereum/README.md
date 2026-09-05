# @oyaprotocol/ethereum

Ethereum JSON-RPC utilities for Oya kernel code. This package is a hardened kernel surface: callers provide explicit transport settings and explicit `fetch` implementations instead of relying on process-level defaults.

## Public Entrypoint

- `@oyaprotocol/ethereum`

## Current Surface

- `createHttpConfig(options)`: validate explicit HTTP transport settings, re-exported from `@oyaprotocol/utils`.
- `requestEthereumJsonRpc(options)`: send one JSON-RPC POST request with explicit config and injected `fetch`, returning the raw `result`, attempt count, id, and parsed response payload.
- `createTransactionPreparer(options)`: configure a reusable EIP-1559 preparer that fetches transaction fields and invokes a host signer, without broadcasting.
- `ethSendRawTransaction(options)`: submit a signed raw transaction and return the transaction hash with attempt metadata. Callers may pass `transactionHash` when they already know the hash, allowing the wrapper to verify duplicate-style retry errors with `eth_getTransactionByHash`.
- `ethGetTransactionReceipt(options)`: look up a transaction receipt, returning `{ receipt, attemptCount, response }`. The receipt is `null` when unavailable, including pending or unknown transactions.
- `ethWaitForTransactionReceipt(options)`: poll for a receipt with an explicit overall deadline, poll interval, and optional cancellation signal. Returns `{ receipt, pollCount, attemptCount, response }` with a non-null receipt.
- `encodeLoggerCall(cid)`: encode calldata for the Oya Logger's `log(string)` function.
- `hashLoggerCid(cid)`: validate a canonical CID and compute its Keccak-256 lookup topic.
- `decodeLoggerEvent(log, loggerContract)`: decode a `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` event from the expected Logger, returning `{ node, cidKeccak256Hash, cid, removed? }` or `null` for an unrelated log.
- `logCid(cid, options)`: prepare a Logger transaction through a host callback, submit it, await its receipt, and verify the expected event.
- `LogCidError`: reports the failed logging stage, CID, known transaction hash, receipt when available, and original cause.
- `EthereumJsonRpcError`: thrown when an HTTP-successful JSON-RPC response contains an `error` payload.
- `HttpStatusError`: thrown when the HTTP response itself is not successful, re-exported from `@oyaprotocol/utils`.
- `EthereumRawTransactionRecoveryError`: thrown when raw transaction submission may have succeeded before a retry returned a duplicate-style error, but the wrapper could not verify the supplied transaction hash.
- `EthereumTransactionReceiptTimeoutError`: thrown when the overall receipt wait expires, exposing `transactionHash`, `timeoutMs`, and `pollCount`.

## Behavior

`createHttpConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized by trimming trailing slashes before JSON-RPC requests are sent.

`requestEthereumJsonRpc(...)` owns the JSON-RPC envelope and request headers. It sends `content-type: application/json`, rejects caller-provided `content-type` config headers, enforces a request timeout, retries transient HTTP/network failures only for read-only Ethereum methods, and treats JSON-RPC error payloads as non-retryable semantic errors.

`ethSendRawTransaction(...)` does not sign transactions and does not compute transaction hashes. It expects callers to provide a signed raw transaction. If `transactionHash` is supplied and a retry of `eth_sendRawTransaction` returns duplicate-style JSON-RPC errors such as `already known` or `nonce too low`, the wrapper checks `eth_getTransactionByHash(transactionHash)` before returning a recovered result. Without `transactionHash`, those cases are surfaced as `EthereumRawTransactionRecoveryError` because this wrapper requires the host's transaction hash to verify acceptance.

Hosts own transaction signing, environment configuration, and RPC endpoint discovery. ABI support is limited to the Logger helpers described below. Callers are responsible for preparing JSON-RPC params, including converting `bigint` values to Ethereum quantity hex before calling the raw request primitive.

## Shared Transaction Types

`src/transactions.ts` defines these types, exported from `@oyaprotocol/ethereum`:

- `TransactionRequest`: readonly `to`, `data`, `value: bigint` (wei), and optional `signal`. It describes call intent; the host supplies the remaining transaction fields.
- `SignedTransaction`: readonly signed `rawTransaction` and its `transactionHash`.
- `UnsignedTransaction`: readonly `to`, `data`, `value`, `type: 2`, `chainId: bigint`, `nonce: number`, `gasLimit: bigint`, `maxFeePerGas: bigint`, and `maxPriorityFeePerGas: bigint`. The access list is empty. There is no embedded cancellation signal.
- `TransactionSigner`: a readonly `address` and `signTransaction(transaction, signal?)` method returning `SignedTransaction`, synchronously or asynchronously. The host implements signing and must preserve all supplied fields, use the advertised account, and return without broadcasting.
- `TransactionPreparer`: a callback from `TransactionRequest` to `SignedTransaction`, synchronously or asynchronously, without broadcasting.
- `TransactionStage`: `'prepare' | 'submit' | 'receipt' | 'verify'`. Verification means the operation's checks after receiving a receipt, such as execution status and expected events.

Logger uses these shared types and always requests `value: 0n`. Other callers can use the same host preparation callback with a nonzero value. These names replace `LoggerTransactionRequest`, `PreparedLoggerTransaction`, `PrepareLoggerTransaction`, and `LogCidStage`; update type imports accordingly.

## Default Transaction Preparation

`createTransactionPreparer(options)` in `src/transaction-preparer.ts` returns a `TransactionPreparer` compatible with `logCid` and the messages package's `publishAndLogSignedMessage`. The host supplies a `TransactionSigner`; no local wallet adapter, private-key handling, ethers, viem, or new dependency is included.

```ts
import { createTransactionPreparer, logCid } from '@oyaprotocol/ethereum';
import type { TransactionSigner } from '@oyaprotocol/ethereum';

declare const signer: TransactionSigner; // Implemented by the host's wallet/signing service.
const transactionPreparer = createTransactionPreparer({
    config: rpcConfig,
    fetch: rpcFetch,
    chainId: 1n, // The operator's expected network.
    signer,
    gasLimitMarginPercent: 20, // Default: 20% above the estimate, rounded up.
    baseFeeMultiplier: 2, // Default: 2 * base fee + suggested priority fee.
    limits: { gasLimit: 200_000n, feePerGas: 30_000_000_000n }, // Illustrative operator-chosen caps.
    timeoutMs: 30_000, // Default: overall preparation deadline, including signing.
    id: 'prepare-42', // Optional; preparation RPCs default to ID 1.
});

const logging = await logCid(cid, {
    config: rpcConfig, fetch: rpcFetch, loggerContract,
    nodeAddress: signer.address, // Direct account call in this example.
    transactionPreparer, timeoutMs: 60_000, pollIntervalMs: 1_000, signal,
});
```

Construction validates and snapshots configuration without making RPC calls. Each invocation validates and snapshots the call, checks `eth_chainId` against the configured positive bigint chain ID, reads `eth_getTransactionCount(address, "pending")`, obtains the latest block's base fee and gas limit, and reads `eth_maxPriorityFeePerGas`. It then calls `eth_estimateGas` against pending state with the signing address, recipient, calldata, value, chain ID, nonce, and selected fees. These methods follow the [Ethereum execution API](https://github.com/ethereum/execution-apis/tree/main/src/eth); the fee fields follow [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559).

The gas limit is `ceil(estimate * (100 + gasLimitMarginPercent) / 100)`. The maximum fee per gas is `baseFee * baseFeeMultiplier + suggestedPriorityFee`; the priority fee is the RPC suggestion. The multiplier and margin are policy choices, not protocol requirements. Arithmetic uses bigint, and fee values are in wei per gas. Nonces above `Number.MAX_SAFE_INTEGER` reject before conversion for the signer. Both optional `limits` fields are ceilings: the factory rejects a selected value above a ceiling instead of reducing the gas buffer or fee suggestion. Omitting them adds no operator ceiling; the buffered gas limit must still fit the latest block's gas limit. A configured gas cap must be positive; a fee cap of zero is permitted. Networks without EIP-1559 base-fee data, unsupported RPC methods, malformed quantities, estimation errors, and out-of-range values reject before signing.

The signer receives a frozen transaction and a separate signal combining caller cancellation with the overall deadline. Each RPC read uses the existing transport timeout/retry policy. The whole preparation has no retries, and the signer is called at most once per invocation. Signer errors propagate; timeout/cancellation stops waiting even when the signer ignores its signal, and late results are discarded. The host should honor the signal where its signing API permits. Aborting cannot undo an external signing request already started.

The returned result is a frozen snapshot. The factory checks byte formatting, the type-2 prefix, and that the supplied hash equals Keccak-256 of the returned bytes, using the existing `@noble/hashes` dependency. It does not decode the transaction or recover the signing account: the host signer remains responsible for a valid signature, the advertised account, and exact transaction fields. Only ordinary type-2 calls with an empty access list are supported; contract creation, legacy transactions, blobs, and smart-wallet execution wrapping require a custom preparer. A wallet API that only signs and broadcasts together cannot implement this signing contract.

**The host coordinates nonces across the complete prepare/submit/receipt lifecycle for each account.** Serialize that lifecycle for the initial implementation, including other users of the account, and reconcile uncertain submissions before proceeding. The factory does not reserve, cache, or increment nonces and does not coordinate different processes. It refreshes chain values on every call; preparation alone cannot guarantee unique nonces before submission. Existing submission retries resend retained signed bytes rather than calling the preparer again. The factory's `id` applies to its read RPCs; Logger's optional `id` separately controls submission and receipt requests.

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

The pure, synchronous helpers in `src/logger.ts` target [`Logger.sol`](../../contracts/src/Logger.sol). They use its fixed function selector and event signature, checked with Foundry, and implement its single-string ABI layout directly. Keccak-256 uses `@noble/hashes` 2.2.0, also used by the messages package. The encoding follows the [Solidity ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html).

`encodeLoggerCall(cid)` returns the complete `0x`-prefixed calldata. Both this helper and `hashLoggerCid(cid)` require CIDv1 in lowercase unpadded Base32 with a 32-byte SHA-256 digest, using `assertCanonicalCid` from `@oyaprotocol/utils`. They preserve the CID exactly and reject alternate representations, whitespace, URIs, paths, and malformed identifiers instead of normalizing them. This is the same format enforced by `@oyaprotocol/ipfs`. The host supplies the Logger address and prepares the remaining transaction fields, signs, and submits the transaction.

`decodeLoggerEvent(log, loggerContract)` accepts `LoggerEventInput`, which selects `address`, `topics`, `data`, and optional `removed` from `EthereumReceiptLog`. Pass receipt logs directly. The expected address is required and must be 20-byte hex. Other emitter addresses or event signatures, including logs with no topics, return `null`. Malformed input or a matching event with invalid topics, address padding, data offset, length, padding, or UTF-8 throws. Decoding checks lengths before allocating from an untrusted declared length, and requires the canonical layout emitted by Solidity, without extra trailing data.

The decoded `LoggerEvent` preserves the indexed node and `cidKeccak256Hash` hex casing and exact canonical CID text. The decoder requires exactly three topics, validates the same strict CID format, and verifies that the supplied 32-byte hash equals `keccak256(bytes(cid))`. A matching event containing a noncanonical CID or a mismatched hash throws. The Solidity contract still accepts arbitrary strings, so historical or external events outside the kernel's CID policy require a separate raw ABI decoder. Address and event-signature matching is case-insensitive. Optional `removed` metadata is preserved, including `true`; decoding alone does not establish successful execution or finality. The expected node is the immediate caller of Logger, which may be a contract wallet and may differ from the signed message's signer.

To find events for a known CID, the host uses `hashLoggerCid(cid)` and supplies an `eth_getLogs` filter with the Logger address, the desired block range, and `topics: ['0xce2d845fcf02211a951a2153c1ddf64ec48ef6d54644ea188101f10018b871dc', null, hashLoggerCid(cid)]`. The `null` permits any node address. This hash is separate from the SHA-256 digest embedded in the CID. Enforcing one CID spelling gives all nodes the same lookup hash for that CID. The previous two-topic `Log(address,string)` event is unrelated to this signature and decodes to `null`.

For example, a host can prepare the call and later verify its receipt:

```ts
import { encodeLoggerCall, decodeLoggerEvent } from '@oyaprotocol/ethereum';

const transaction = {
    to: loggerContract,
    data: encodeLoggerCall(publication.cid),
    value: 0n,
};
// The host prepares, signs, and submits transaction, then obtains its receipt.

if (receipt.status !== 'success') {
    throw new Error('Logger transaction did not succeed.');
}
const event = receipt.logs
    .map((log) => decodeLoggerEvent(log, loggerContract))
    .find((entry) => entry !== null && entry.removed !== true &&
        entry.node.toLowerCase() === nodeAddress.toLowerCase() &&
        entry.cid === publication.cid);
if (!event) {
    throw new Error('Receipt did not contain the expected Logger event.');
}
```

These helpers require standard `TextEncoder` and `TextDecoder`, consistent with the package's ECMAScript 2025 target. Hosts choose confirmation policy and compose publication with transaction submission; the helpers perform no network calls.

## Logging a CID

`logCid(cid, options)` in `src/logger.ts` composes the existing ABI, raw submission, and receipt helpers. It validates the canonical CID, Logger address, expected node, HTTP config, and polling durations before asking the host to prepare a transaction:

```ts
import { logCid } from '@oyaprotocol/ethereum';

const logging = await logCid(publication.cid, {
    config: rpcConfig,
    fetch: rpcFetch,
    loggerContract,
    nodeAddress,
    transactionPreparer,
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    id: 'message-42', // Optional JSON-RPC request ID.
    signal,
});
// logging: { cid, transactionHash, receipt, event }
```

`transactionPreparer` is a host-supplied `TransactionPreparer` function, which can be created with `createTransactionPreparer` above. It receives a frozen `{ to, data, value: 0n, signal? }` request describing the Logger call and returns `{ rawTransaction, transactionHash }`, synchronously or asynchronously. It must prepare and sign without broadcasting. The host selects the chain and preparation policy, supplies wallet access, and coordinates nonces across concurrent messages. It must return the correct hash for the signed transaction and preserve the requested call, including when routing through a contract wallet. The Logger helper validates the returned hex shapes and checks the RPC's returned hash; it does not parse or independently verify the signed transaction.

The optional `id` accepts a nonempty string or a safe integer, including zero. It uses the existing RPC validation and defaults to `1` when omitted. The same ID is forwarded to submission, retries and recovery lookups, and every receipt poll. Invalid IDs reject before transaction preparation. This identifier is RPC metadata and is separate from the signed transaction's hash.

The helper snapshots the signed bytes and hash, submits through `ethSendRawTransaction`, then polls through `ethWaitForTransactionReceipt`. It prepares only once and adds no outer retry loop; submission retries reuse the exact signed bytes. `nodeAddress` is Logger's immediate caller, not necessarily the message signer or the outer transaction sender. A successful result requires receipt status `success` and a matching event from `loggerContract`, with the expected node and exact CID, valid CID/hash correspondence, and `removed !== true`.

`timeoutMs` bounds receipt observation after submission; `config.timeoutMs` bounds each RPC request. The host bounds transaction preparation/signing. The optional signal covers preparation, submission, and polling through the existing async utilities. Cancellation stops subsequent stages even if preparation ignores its signal and eventually returns signed bytes. It cannot undo a submitted transaction. The returned receipt establishes mined execution as reported by the RPC, with confirmation depth and reorganization policy left to the host.

Invalid configuration rejects before preparation. Once preparation begins, failures throw `LogCidError` with the original `cause`, `cid`, `transactionHash` (or `null` before a valid hash is known), `receipt` (or `null`), and one of these stages:

| Stage | Operation that failed |
| --- | --- |
| `prepare` | Host preparation/signing, returned-value validation, or cancellation before submission |
| `submit` | Signed transaction submission or its response/recovery checks |
| `receipt` | Receipt lookup, parsing, cancellation, or deadline |
| `verify` | Receipt execution status or expected Logger event checks |

The hash is retained before broadcasting, including when submission fails ambiguously. Its presence does not prove that the transaction was accepted. A receipt timeout is available as `error.cause instanceof EthereumTransactionReceiptTimeoutError`; it does not imply transaction failure. Resume observation using the retained hash and `ethWaitForTransactionReceipt`, then apply the status/event checks shown above. Calling `logCid` again prepares a new transaction and can create another event. Hosts must persist progress themselves if recovery must survive a process crash.

## Validation

Run from the repository root; tests use injected transports and require no live RPC:

```sh
npm --prefix packages run build
node --test packages/ethereum/test/*.test.js
packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
```

`test/fixtures/logger-abi.json` contains nine independent Foundry-generated ABI vectors for the canonical CIDs in `packages/test/fixtures/cids.json`. Exact CID bytes were encoded with `cast abi-encode 'f(bytes)' <hexBytes>`; ABI `bytes` and `string` share the same layout. Calldata prefixes the selector obtained from `forge inspect --root contracts --offline Logger methodIdentifiers --json`. The shared signature and node topics were generated with `cast keccak 'Log(address,bytes32,string)'` and `cast abi-encode 'f(address)' <node>`. Each case adds its own `cidKeccak256Hash`, generated with `cast keccak <hexBytes>` over the exact CID bytes. Runtime tests use the committed fixtures and require no Foundry installation.
