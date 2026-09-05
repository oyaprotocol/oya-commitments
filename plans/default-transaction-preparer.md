# Add a default transaction preparer with an injected signer

This ExecPlan is maintained according to `PLANS.md`.

## Purpose / Big Picture

Nodes will be able to configure a reusable Ethereum transaction preparer once, provide their own signing implementation, and pass the returned callback to `logCid` or the existing publish-and-log handler. The package will obtain chain-dependent transaction fields without adding ethers, viem, a wallet adapter, private-key handling, or any new dependency. Mock RPC and signer tests will demonstrate preparation followed by existing Logger submission and receipt verification without using a real network or key.

## Progress

- [x] 2026-09-05 20:38Z: Read repository instructions and audited transaction, RPC, validation, cancellation, and Logger code. Checked Ethereum execution API and EIP-1559 specifications.
- [x] 2026-09-05 20:40Z: Implemented public types and the factory; reused quantity parsing, shared timer validation, RPC retries, and bounded async invocation. Initial build passed.
- [x] 2026-09-05 20:41Z: Added 14 passing runtime tests including Logger integration and uncooperative signer cancellation. Ethereum type tests passed.
- [x] 2026-09-05 20:44Z: Updated Ethereum/utils documentation, rebuilt tracked output, reviewed the implementation/declarations, and passed all 201 package runtime tests, Ethereum/messages type checks, package imports, and whitespace checks. Dependency metadata is unchanged.

## Surprises & Discoveries

- `requestEthereumJsonRpc` already supports retries for all five required read methods; no new transport or retry implementation is needed.
- Canonical RPC quantity parsing currently lives in `receipt-utils.ts`; bounded timer validation currently lives in `receipts.ts` despite also being used by Logger. Move those existing implementations to RPC utilities and shared validation utilities respectively so preparation can reuse them.
- A preparer cannot coordinate nonce reuse through submission because its callback finishes before broadcasting starts. An internal queue would not solve this lifecycle constraint.

## Decision Log

- 2026-09-05 / Codex: Support type-2 (EIP-1559) transactions to an explicit address, with empty access list, initially. This matches the discussed default and avoids inventing support for wallet-specific execution, contract creation, blobs, or legacy fees.
- 2026-09-05 / Codex: Require an expected positive bigint chain ID and a signer with an address and `signTransaction` method. Reuse existing `TransactionRequest`, `SignedTransaction`, and `TransactionPreparer`. Keep the new factory in `packages/ethereum/src/transaction-preparer.ts` and shared signing types in `transactions.ts`.
- 2026-09-05 / Codex: Read chain ID, pending nonce, latest block base fee/gas limit, suggested priority fee, then estimate gas against pending state with the completed call/fee fields. Check chain ID on every invocation. Default maximum fee is twice the current base fee plus the suggested priority fee. Default gas margin is 20%, rounded up. Configurable integer base-fee multiplier and margin, optional gas/fee ceilings, and block gas limit checks reject before signing rather than silently reducing values.
- 2026-09-05 / Codex: A configurable 30-second overall preparation deadline and the per-call abort signal cover RPC work and signing. Reuse `runWithRetry` with zero outer retries; individual RPC reads retain their existing retry policy. Sign only once and discard late results after cancellation. The signer is trusted to preserve the requested transaction and account; validate returned byte shapes, type-2 prefix, and hash correspondence with existing noble Keccak, without adding transaction decoding or key recovery.
- 2026-09-05 / Codex: Do not reserve or increment nonces locally. Document serialization of the complete transaction lifecycle per account, including reconciliation of uncertain submissions, and the lack of coordination across processes. RPC IDs default to 1 and are configurable at factory creation; they are not signed fields.

## Outcomes & Retrospective

The factory and signer interface are implemented with no new dependencies or concrete wallet adapter. All 201 runtime tests across utils, IPFS, Ethereum, and messages pass, including 14 new factory tests. Both Ethereum/messages type suites, package-root imports, the build, and `git diff --check` pass. The Logger integration test demonstrates preparation followed by one submission and the expected receipt/event verification. No live RPC, production key, deployment, or wallet adapter was used. The remaining operational responsibility is intentionally the host's signer implementation and coordination of the complete transaction lifecycle per account; no implementation work remains for this task.

## Context and Orientation

`packages/ethereum/src/transactions.ts` defines call intent (`to`, `data`, `value`, optional signal), a prepared signed result, and the existing callback accepted by Logger. `logger.ts` invokes that callback, submits bytes, waits for a receipt, and verifies an event. `request-utils.ts` performs JSON-RPC reads with bounded retries and response-envelope checks. `packages/utils/src/async-utils.ts` provides cancellation, deadlines, and retry composition. `packages/messages` composes IPFS publication with Logger; its API requires no change. Tracked `dist` files are rebuilt with TypeScript. Root and package `AGENTS.md` apply.

An Ethereum nonce is an account's transaction sequence number. A gas limit bounds execution units, while fees are prices per unit in wei (integer native currency units). EIP-1559 transactions contain a maximum priority fee and maximum total fee per gas. The factory computes a policy suggestion and never broadcasts it.

## Plan of Work

First add `UnsignedTransaction`, `TransactionSigner`, and `CreateTransactionPreparerOptions` through the Ethereum package root. Move existing generic validation implementations without changing their behavior. Implement strict factory/request/RPC validation, snapshots of configuration and request fields, integer arithmetic, immutable signing input/output, and a single bounded signer invocation. Then test the new factory with injected RPC responses, synchronous/asynchronous fake signers, cancellation, mutated objects, and existing Logger orchestration. Finally explain configuration defaults, limits, supported wallet/transaction scope, and nonce ownership in the READMEs.

## Concrete Steps

All commands run from the repository root unless indicated:

    npm --prefix packages run build
    node --test packages/ethereum/test/transaction-preparer.test.js
    node --test --test-reporter=dot packages/utils/test/*.test.js packages/ipfs/test/*.test.js packages/ethereum/test/*.test.js packages/messages/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    git diff --check

Smoke-import changed package roots with Node from `packages/`. Expect no missing exports, no TypeScript errors, and all mock tests passing. Inspect dependency metadata diff to verify no dependencies were added.

## Validation and Acceptance

Tests must prove exact default fields and RPC parameters (including pending nonce/state, request ID, fee fields and rounding), refreshed values across calls, configured overrides/caps, early rejection of invalid configuration, malformed or oversized quantities, unsupported fee data, chain mismatch and gas estimation errors. Cancellation before RPC, during RPC, and during an uncooperative signer must settle promptly, prevent later signing/submission, and preserve original objects. Retryable reads may retry, but signer failures never retry. Returned hashes must match signed bytes. A Logger integration test must show a completed signing request followed by one submission and the correct event verification. Type tests must establish public imports, callback compatibility, bigint fields, immutability, and required signer methods.

## Idempotence and Recovery

Build and mock tests are repeatable and do not contact external services. Factory construction performs no RPC calls or signing. Each invocation reads current state and can request another signature, so the host should reuse retained signed bytes for submission retries rather than invoke the factory again. The factory has no nonce reservation, broadcast, persistence, wallet approval, or deployment side effects. Aborting a wait cannot undo a signer operation already started; late completion is ignored. Hosts must coordinate all users of the signing account and reconcile ambiguous submissions.

## Artifacts and Notes

Protocol references checked: https://eips.ethereum.org/EIPS/eip-1559 and the Ethereum execution API `src/eth/execute.yaml` / `src/eth/fee_market.yaml`. The relevant facts and chosen defaults are recorded above; external sources are not required to resume implementation. Runtime tests use opaque type-2 bytes and a matching hash to exercise orchestration, not real cryptographic signing.

Independent fixture check: `cast keccak 0x02abcd` returned `0xe3607eedbe2ea88ad1994e3ef901f3c7ed167a59ebb5ffe5e40321e468f49eb1`. The full runtime command printed 201 passing test dots and exited zero; builds, both type-check commands, smoke imports, and whitespace checks also exited zero. New files are `transaction-preparer.ts`, its generated dist artifacts, the corresponding runtime/type tests, and this plan. Existing quantity parsing moved to `request-utils.ts`; existing timer validation moved to `@oyaprotocol/utils` and all callers use the shared definition.

## Interfaces and Dependencies

`createTransactionPreparer(options)` returns the existing `TransactionPreparer`. Options include `config`, `fetch`, `chainId: bigint`, `signer`, optional `gasLimitMarginPercent` (20), `baseFeeMultiplier` (2), `limits: { gasLimit?: bigint; feePerGas?: bigint }`, `timeoutMs` (30000), and JSON-RPC `id` (1). `UnsignedTransaction` adds type 2, chain ID, a safe-integer nonce, gas limit and both fee fields to the existing call intent without its signal. `TransactionSigner` exposes an address and a signing method accepting the unsigned transaction and optional abort signal, returning `SignedTransaction` synchronously or asynchronously. Existing `@noble/hashes` and `@oyaprotocol/utils` are sufficient; package metadata remains unchanged.
