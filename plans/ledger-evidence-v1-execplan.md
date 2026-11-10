# Read-only Ledger evidence for saved inbox jobs

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator can run the inbox client's `evidence` command with a saved signed job and independently supplied Ledger identity and read endpoints. It reports verified snapshot consistency, contradictory evidence, or unavailable evidence without a signing key. A verified report binds the expected signed message to a logged CID and the expected publishing node at an observed block.

## Progress

- [x] 2026-11-10: Read repository guidance, Q001, inbox protocol/status/client, receipt parser and Ledger decoder; installed pinned production dependencies with scripts disabled.
- [x] 2026-11-10 18:49Z: Implemented bounded read-only evidence module and client command.
- [x] 2026-11-10 18:49Z: Added adversarial and real-loopback CLI tests, a signing/file/environment access guard, and operator docs.
- [x] 2026-11-10 18:51Z: Focused tests passed (93/93) and full production suites passed (402/402) on both Node 24.22.2 and Node 26.12.1.
- [x] 2026-11-10 18:51Z: Reviewed the complete diff and recorded the final code budget; implementation is ready for local handoff.

## Surprises & Discoveries

The current public status has no target field: it is scoped by the original signed envelope sent to the operator-approved inbox origin. It includes a request ID and independent checkpoint/result CID and transaction hash. The existing kernel exports a read-only receipt reader and Ledger decoder; its receipt parser checks receipt/log block and transaction identity. No kernel changes are needed.

The first success test failed at receipt parsing because the kernel reader expects complete retry/deadline settings. Explicit `maxRetries: 0`, `retryDelayMs: 0` and a bounded timeout fixed it; the adapter parses the already bounded RPC result without further network access. CLI tests also revealed that Node's loader uses public filesystem reads: the preload guard permits runtime module loading while denying private file reads, file mutations, signing and OYA environment access. All guarded CLI exit-code cases now pass.

The existing `.dockerignore` already includes `src/inbox/*.mjs`, and the release bundle already includes `README.md` and `inbox-api.md`. No packaging changes are required; the full suite includes packaging/upgrade regressions.

## Decision Log

- 2026-11-10 / Hermes: Use the existing read-only receipt kernel with a bounded transport, no retry, and decodeLedgerEvent. Reuse validateJob with checkExpiry false. Avoid importing the processor or worker.
- 2026-11-10 / Hermes: Supply trusted identity and endpoints through a strict separate JSON settings file, never status-derived URLs or environment credentials. Require independent target, chain, Ledger and node values. This keeps the command usable and dependency surface small, following dialogue Q001's accessibility/security emphasis.
- 2026-11-10 / Hermes: Implement snapshot consistency rather than peer availability. Trust the chosen RPC/Kubo; do not claim finality, trustless UnixFS CID verification, or causal proof that this request caused the transaction. Peer directory, fanout and authorization policy remain separate work.

## Outcomes & Retrospective

The command now produces working JSON reports and distinct exit codes, exercised through real loopback HTTP servers and child-process CLI runs. Both signed envelope layers are checked, including historical expiry; independent chain/Ledger/node identity, receipt/log location and exact retrieved fields are enforced. Request and body limits, deadlines, redirect refusal, credential isolation and sanitized errors have permanent failure coverage. Existing client APIs remain intact; no dependencies, kernel, contract, deployment or authorization policy changed.

Validation uses local simulated RPC/Kubo/status responses with real cryptographic signatures and the published receipt/event parsers. No live-chain, actual Kubo/PostgreSQL container integration or Docker image build was run for this feature; production ESM has no build step. The trust/availability limitations are explicit in the operator guide. Publication remains the parent task's responsibility.

## Context and Orientation

Production ESM code lives in `node/production/src/inbox/`. `client.mjs` already creates signed jobs and calls status. `protocol.mjs` verifies the message signature and enclosing request signature. `store.mjs` returns public status for the exact signed job, even after expiry. `@oyaprotocol/ethereum` exports receipt parsing through ethGetTransactionReceipt and validates Ledger Log events through decodeLedgerEvent. The receipt is a transaction's mined result; its logs carry the emitting contract, node address and CID (IPFS content identifier).

## Plan of Work

Add `evidence.mjs` for strict input validation, bounded HTTP reads, RPC/status/content checks, and sanitized reports. Add an `evidence JOB_FILE SETTINGS_FILE` branch to the existing client while preserving its APIs. Add `test/ledger-evidence.test.mjs` using real signatures, adversarial responses and local HTTP servers. Document the command in the existing packaged inbox API guide and task index.

## Concrete Steps

From the repository root run `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`, then `node --test node/production/test/ledger-evidence.test.mjs`, then `npm --prefix node/production test`. No build script exists for this ESM runtime. Use Node 24 if installed. Run `git diff --check` and inspect all changed/new files before local commit. Tests must use disposable fixtures and loopback servers, never production endpoints.

## Validation and Acceptance

Valid and historically expired envelopes verify. Invalid inner/outer signatures fail before HTTP. Wrong target/request/chain/node/contract/hash/CID/content, malformed/removed logs and inconsistent block data report mismatch. Missing receipts/content, pending/publication-only states, transport failure/timeouts/oversize report unavailable. Real CLI tests assert JSON output and distinct exit codes, no raw payloads/errors/credentials, and exact read-only routes/methods with no retries. Body/file caps and deadlines include body streaming; redirects are rejected.

## Idempotence and Recovery

The command only reads saved files and performs status, receipt, block and Kubo cat reads. Repeating it obtains a new snapshot and cannot submit jobs, upload content, sign, or broadcast. A failed check requires operator inspection rather than automatic retries. Remove these feature files and the client/docs additions to revert; no persisted state migration is required.

## Artifacts and Notes

Pinned install completed: 30 packages added with `npm ci --ignore-scripts --no-audit --no-fund` in `node/production`. Focused command `node --test node/production/test/ledger-evidence.test.mjs` passed 93 tests on each of Node 24.22.2 and 26.12.1. Full command `npm --prefix node/production test` passed 402 tests on each version, with zero failures or skips. After the final test-guard tightening, the focused suite passed again on both versions. `git diff --check` passed. Code/test churn is 599 added-plus-deleted lines, below the 3,000-line limit.

## Interfaces and Dependencies

Keep existing pinned dependencies. Export `verifyLedgerEvidence(job, settings)` and a bounded JSON file reader for the client. Reports carry schema version, status/reason/stage, observation time and checked block identity, plus only validated public identifiers. Exit codes: 0 verified, 2 mismatch, 3 unavailable. Settings contain target, inboxUrl, chainId, ledgerContract, nodeAddress, rpcUrl, ipfsUrl, optional endpoint authorization and bounded timeout settings. No signer configuration is accepted.
