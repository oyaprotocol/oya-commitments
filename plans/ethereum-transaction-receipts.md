# Ethereum transaction receipt lookup and waiting

This ExecPlan follows `PLANS.md` and completes the receipt portion of
`plans/ethereum-json-rpc-primitives.md`. The other method wrappers in that plan remain separate work.

## Purpose / Big Picture

Let a host observe a submitted Ethereum transaction through `@oyaprotocol/ethereum`.
It can look up a receipt once or wait for one with explicit polling, a deadline, and
cancellation. The result identifies execution success or failure and includes
validated block, gas, and event-log data for later Logger integration.

## Progress

- [x] 2026-09-04: Reviewed package guidance, RPC transport, async utilities, existing tests, and Ethereum receipt specifications.
- [x] 2026-09-04: Implemented receipt normalization, lookup, polling, and package-root exports.
- [x] 2026-09-04: Added 21 offline behavioral tests for transport, validation, timeout, cancellation, and cleanup, plus TypeScript consumer checks.
- [x] 2026-09-04: Documented host usage, rebuilt tracked output, and validated the package surface. All 145 kernel runtime tests passed, along with the build, receipt type checks, and package-name smoke import.

## Surprises & Discoveries

- `runWithRetry` gives each HTTP attempt its own timeout. Receipt waiting needs an
  additional outer deadline, shared by requests, retry backoff, and poll delays.
- A `null` RPC receipt is an ordinary successful lookup, not a retryable error.
- Historical pre-Byzantium receipts contain a state root instead of an execution
  status. Preserve that distinction rather than claiming execution succeeded.
- Shared hex-data validation rejects empty bytes; log data legitimately accepts `0x`.
- Signal composition can throw for invalid JavaScript input. Keep composition
  inside the deadline's cleanup scope so even initialization failures release it.

## Decision Log

- 2026-09-04: Keep receipt code in `packages/ethereum/src/receipts.ts`, with
  package-local normalization in `receipt-utils.ts`. Use only the existing utils
  dependency and injected fetch. No host startup, signing, or ABI work is needed.
- 2026-09-04: Normalize Ethereum quantities to `bigint`, preserve hex casing, and
  correlate returned transaction/log identities with the requested transaction.
  Return status `success`, `reverted`, or `null` (historical root-only receipt).
  Optional fee/type/blob fields are validated when present; provider extensions
  remain accessible only through the original response, typed as `unknown`.
- 2026-09-04: Lookup returns `{ receipt, attemptCount, response }`, with nullable
  receipt. Waiting returns the non-null receipt, poll count, total HTTP attempt
  count across completed lookups, and the final raw response. Pending polls do
  not consume a global retry budget; each lookup uses existing RPC retry policy.
- 2026-09-04: Require positive `timeoutMs` and `pollIntervalMs` in the wait options,
  both within the platform timer range (2,147,483,647 ms). Use shared timeout,
  signal composition, abort invocation, and cancellable delay helpers. A named
  receipt timeout error includes the transaction hash, deadline, and poll count.
  Caller cancellation takes precedence if both signals have aborted.
- 2026-09-04: Return the first mined receipt, including reverted transactions.
  Confirmation depth, reorganization tracking, replacement detection, and Logger
  event decoding are future host/package features, not part of this wait primitive.

## Outcomes & Retrospective

Receipt lookup and waiting are complete, with no additional runtime dependency
and no shared utility changes. All 145 kernel runtime tests passed (41 Ethereum,
including 21 new receipt tests; 104 existing utils/IPFS/messages tests). The build,
TypeScript consumer checks, package-name import, and diff whitespace check passed.
Tests ran inside the sandbox using fake transports; no external RPC or contract
deployment was needed. Host signing, Logger integration, confirmation policy,
and the other Ethereum method wrappers remain separate tasks.

## Context and Orientation

`packages/ethereum/src/request-utils.ts` owns JSON-RPC envelopes, HTTP errors,
per-attempt timeouts, and bounded retries for read methods including
`eth_getTransactionReceipt`. `packages/utils/src/async-utils.ts` exports
`createTimeoutSignal`, `combineAbortSignals`, `invokeWithAbort`, and
`waitForRetryDelay`. New code must use their package-root exports. Source and
compiled `dist` artifacts are tracked. Tests import the built package with
Node's test runner and inject fake HTTP transports.

## Plan of Work

First add receipt/log types and field validation. Implement one lookup by calling
the existing RPC primitive, then a loop that observes `null` and delays before
the next lookup. Keep the overall abort signal active throughout every request
and delay, translate deadline expiration to a receipt-specific error, and clean
up timers/listeners in `finally`. Add public exports, behavioral tests, docs, and
regenerated artifacts. Update this plan and the umbrella plan after validation.

## Concrete Steps

From the repository root:

    npm --prefix packages run build
    node --test packages/ethereum/test/*.test.js
    node --test packages/utils/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    cd packages && node --input-type=module -e "import { ethGetTransactionReceipt, ethWaitForTransactionReceipt, EthereumTransactionReceiptTimeoutError } from '@oyaprotocol/ethereum'; if ([ethGetTransactionReceipt, ethWaitForTransactionReceipt, EthereumTransactionReceiptTimeoutError].some(value => typeof value !== 'function')) process.exit(1);"
    git diff --check

## Validation and Acceptance

Lookup must encode the right method/hash, return null or validated data, preserve
large quantities without precision loss, reject malformed or mismatched receipts,
and expose existing retry metadata. Waiting must stop on success or revert, count
polls separately from retries, and respect cancellation/deadline during pending
delays, stalled transports/body reads, and retry backoff. Invalid arguments and
pre-aborted signals must not invoke fetch. Successful and failed operations must
release their timers and fallback abort listeners. All tests use fake fetch and
require no external network or sandbox escalation.

## Idempotence and Recovery

Builds and tests are safe to repeat. Receipt RPC calls are read-only. Do not alter
unrelated worktree files or regenerate contract artifacts. If a check fails,
correct the implementation or fixture and rerun the affected checks before the
full validation pass. Keep other umbrella-plan milestones unfinished.

## Artifacts and Notes

Protocol references reviewed on 2026-09-04:

- [Ethereum execution API receipt schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/receipt.yaml)
- [EIP-658 execution status](https://eips.ethereum.org/EIPS/eip-658)

## Interfaces and Dependencies

Export `ethGetTransactionReceipt`, `ethWaitForTransactionReceipt`,
`EthereumTransactionReceiptTimeoutError`, their option/result types, and
`EthereumTransactionReceipt` / `EthereumReceiptLog` from the package root.
Lookup accepts explicit `config`, `fetch`, `transactionHash`, optional JSON-RPC
`id`, and optional `signal`. Wait adds required `timeoutMs` and `pollIntervalMs`.
No new dependencies or shared utils changes are planned.
