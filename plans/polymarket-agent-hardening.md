# Polymarket Agent Hardening And Review Loop

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Harden `agent-library/agents/polymarket-intent-trader/` so the Polymarket agent can survive restarts, ambiguous tool results, state rebuilds, and external activity without silently overcommitting depositor credit or getting stuck in unrecoverable lifecycle states. After this work, the module should be easier to audit, safer under long-running autonomous execution, and supported by regression tests that cover the highest-risk failure modes.

The user-visible outcome is a Polymarket agent that can be run for long periods with less babysitting: when validation passes, the remaining known issues should be minor rather than obvious lifecycle or accounting hazards.

## Progress

- [x] 2026-03-23 23:28Z: Read repo instructions in `AGENTS.md`, `agent-library/AGENTS.md`, and `PLANS.md`.
- [x] 2026-03-23 23:29Z: Mapped the module structure and identified `agent.js`, `polymarket-reconciliation.js`, `history-backfill.js`, `planner.js`, `lifecycle-reducers.js`, and the large module test as the main review surfaces.
- [x] 2026-03-23 23:33Z: Ran the baseline validation commands; all existing tests and module validation passed before changes.
- [x] 2026-03-23 23:58Z: Completed a fresh review pass focused on persistence, restart recovery, proposal matching, and state-context handling.
- [x] 2026-03-24 00:24Z: Fixed confirmed major issues in state-context loading, persisted state scoping, reimbursement proposal matching, and legacy backfill migration; added regression coverage.
- [x] 2026-03-24 00:31Z: Re-ran module tests and validation after the hardening pass.
- [x] 2026-03-24 00:37Z: Performed a second review pass on the updated code and reduced remaining concerns to minor/residual operational assumptions.
- [x] 2026-03-24 01:08Z: Re-opened the hardening pass after later review findings in recovered ERC1155 deposit attribution and long-range deposit log scanning.
- [x] 2026-03-24 01:26Z: Refactored recovered deposit reconciliation into evidence collection plus one-time assignment, added chunked ERC1155 recovery scans, and added regression coverage for duplicate-attribution and long-range scan recovery.
- [x] 2026-03-24 01:30Z: Re-ran module tests and validation after the deposit-recovery hardening pass.
- [x] 2026-03-24 01:34Z: Performed another targeted review pass on the updated deposit-recovery code; remaining concerns are again residual rather than concrete major bugs.
- [x] 2026-03-24 02:04Z: Re-opened the hardening pass after a fresh review found dispatch-window expiry release, actual Safe-balance drift at intent acceptance/reimbursement time, and the remaining duplicate recovered-deposit wedge.
- [x] 2026-03-24 02:22Z: Fixed dispatch-window expiry handling, added actual Safe collateral headroom gating plus collateral summary signals, and tightened recovered ERC1155 assignment to full-group one-to-one recovery with new regressions.
- [x] 2026-03-24 02:36Z: Fixed planner throughput bugs where deposited intents could still re-emit BUY orders or block later intents behind stale `orderId` activity; added regressions and re-ran module tests and validation.
- [x] 2026-03-24 02:43Z: Completed clean review pass 1 on stage/recovery code after the latest fixes; no new issues found.
- [x] 2026-03-24 02:48Z: Completed clean review pass 2 on credit, actual-balance gating, and backfill accounting after the latest fixes; no new issues found.
- [x] 2026-03-24 02:52Z: Completed clean review pass 3 on the final diff and regression suite after the latest fixes; no new issues found.
- [x] 2026-03-24 03:08Z: Re-opened the hardening pass after later review feedback on lossy intent acceptance during Safe-balance read failures and malformed reimbursement backfill records.
- [x] 2026-03-24 03:25Z: Fixed lossy acceptance, order/deposit pre-dispatch RPC failure handling, released-intent commitment accounting, receipt-timeout handling for generic RPC errors, and archive-signal enrichment for malformed legacy intents; added regression coverage and re-ran module validation.
- [x] 2026-03-24 03:34Z: Completed three consecutive clean review passes over the updated branch without finding a new concrete issue.
- [x] 2026-03-24 13:18Z: Re-opened the hardening pass for another deep review cycle focused on planner, reducer, and restart recovery edges that were still likely to hide brittle behavior.
- [x] 2026-03-24 13:52Z: Fixed recovered-deposit evidence deduplication, hardened live/backfilled proposal address matching, preserved valid intents across latest-block RPC failures, and added regressions for malformed signals, malformed persisted amounts, and duplicate recovery evidence.
- [x] 2026-03-24 14:04Z: Fixed reverted-receipt retry loops for deposit and reimbursement stages by applying explicit lifecycle backoff after onchain reverts; added regressions and re-ran the full module validation suite.
- [x] 2026-03-24 14:04Z: Completed two additional clean review passes after the latest fixes without finding another concrete issue.
- [x] 2026-03-24 14:39Z: Re-opened the hardening pass after another review found that completed ERC1155 deposits were only recoverable when pending deposit markers survived restart/state loss.
- [x] 2026-03-24 14:48Z: Added order-dispatch provenance for deposit recovery, widened recovered-deposit reconciliation to rediscover already-completed deposits after state loss, added regression coverage, and re-ran the module validation suite.
- [x] 2026-03-24 14:52Z: Completed another clean review pass over the new deposit-recovery path without finding an adjacent regression.
- [x] 2026-03-24 14:59Z: Found and fixed a silent-stall case where malformed-but-non-throwing CLOB order-status payloads could leave submitted orders active forever without surfacing a refresh failure; added regression coverage and re-ran validation.
- [x] 2026-03-24 15:08Z: Tightened live proposal-hash recovery to require an authorized proposer on proposal signals instead of treating proposer as optional; added regression coverage and re-ran validation.
- [x] 2026-03-24 15:22Z: Fixed order-call chainId fallback so CLOB order payloads reuse the already-resolved runtime/config chain ID when direct RPC chain-id lookup is unavailable; added regression coverage and re-ran validation.
- [x] 2026-03-24 15:33Z: Hardened deposit tool-output reduction so hashless `confirmed` ERC1155 deposit results fail closed as ambiguous instead of marking `tokenDeposited=true`; added regression coverage and re-ran validation.

## Surprises & Discoveries

- Observation: The module has already been partly split into stage, reducer, reconciliation, history, and ledger helpers, but `agent.js` is still very large and still owns the orchestration contract for nearly every lifecycle edge.
  Evidence: `agent.js` is 2663 lines; the next-largest local helper is `polymarket-reconciliation.js` at 722 lines.
- Observation: `enrichSignals()` and `onToolOutput()` were not configuring the runtime state context before hydrating local state, so state-file selection depended on whether `getDeterministicToolCalls()` had run first.
  Evidence: `configureRuntimeStateContext()` was only called from `getDeterministicToolCalls()` before this pass; a new regression test now proves safe separation across two commitment Safes.
- Observation: reimbursement proposal recovery trusted explanation text too much and did not require the recovered proposal’s ERC20 transfer recipient to match the intent.
  Evidence: the module matched proposal signals by explanation equality and backfilled commitments by `intentKey` without binding the decoded transfer recipient to the intended reimbursement target.
- Observation: recovered ERC1155 deposits were still reconciled intent-by-intent, so one recovered transfer could satisfy multiple indistinguishable intents and the log path still used unchunked `getLogs` calls.
  Evidence: the old `reconcileRecoveredDepositSubmissions()` loop matched each intent independently via `findRecoveredDepositSignal()` / `findRecoveredDepositLog()` and the log recovery helper queried the full ambiguity window in one request per event type.
- Observation: weak ERC1155 recovery signals can overlap the same onchain transfer later seen through log recovery, so recovery evidence needs cross-source deduplication rather than treating signal and log channels as independent sources of truth.
  Evidence: a signal-only `erc1155Deposit` without tx/log identifiers can describe the same transfer later observed in chunked CTF logs, and without identity dedupe both pieces of evidence can be consumed by two otherwise identical unresolved intents.
- Observation: reverted deposit and reimbursement receipts were clearing lifecycle tracking without any backoff, which made deterministic onchain failures immediately retry every poll.
  Evidence: the old `reduceDepositSubmissionRevertedReceipt()` and `reduceReimbursementSubmissionRevertedReceipt()` removed submission markers but did not set `nextDepositAttemptAtMs` / `nextReimbursementAttemptAtMs`, so planner eligibility resumed on the next loop.
- Observation: completed ERC1155 deposits were only rediscoverable when `depositDispatchAtMs` / `depositSubmittedAtMs` survived in state, so losing local state after a successful deposit could strand a filled intent even though the Safe already held the shares.
  Evidence: recovered-deposit candidates were filtered by pending deposit markers only, and log scans started strictly from `depositDispatchBlockNumber`, which does not exist after a state rebuild that retained order settlement but not deposit-stage tracking.
- Observation: the order-refresh path treated any object-shaped CLOB response as a valid order summary, so an empty/malformed payload could bypass the error path and spin forever with no visible reconciliation error.
  Evidence: `extractOrderSummary()` returned an object full of nulls for arbitrary objects, and `refreshOrderStatus()` only treated thrown fetch errors or explicit terminal statuses as exceptional.
- Observation: live proposal-hash recovery still treated `signal.proposer` as optional even though the shared polling path emits proposer on proposal signals.
  Evidence: `matchesReimbursementProposalSignal()` only rejected mismatched proposers when the field was present, which meant a malformed proposer-less proposal signal with matching explanation and transfer semantics could still attach a proposal hash.

## Decision Log

- Decision: Use a task-specific ExecPlan under `plans/` rather than keeping the plan inline in chat.
  Rationale: The requested work is explicitly a long-run review/fix loop that should survive interruption and be recoverable from the repo alone.
  Date/Author: 2026-03-23 / Codex.
- Decision: Persist a runtime state scope descriptor and validate it on hydrate, rather than only relying on the safe-derived file path.
  Rationale: the module can be run with explicit `statePath` overrides or with unchanged safe/path but different market configuration; state recovery needed an explicit fail-closed compatibility check.
  Date/Author: 2026-03-24 / Codex.
- Decision: Require reimbursement proposal recovery to match actual transfer semantics, not just explanation text.
  Rationale: explanation-only matching could attach the wrong authorized proposal or backfilled commitment to an intent even if the ERC20 transfer paid a different recipient.
  Date/Author: 2026-03-24 / Codex.
- Decision: Recovered ERC1155 deposits should be assigned evidence-first and fail closed on ambiguous attribution, rather than being greedily matched per intent.
  Rationale: if multiple unresolved intents are compatible with the same recovered transfer, auto-assigning that transfer to any one of them is not trustworthy enough to unlock reimbursement.
  Date/Author: 2026-03-24 / Codex.
- Decision: New intent acceptance and reimbursement proposal planning must be capped by the Safe's actual current collateral balance, not just the module's reconstructed deposit ledger.
  Rationale: external Safe outflows cannot be attributed to a specific signer from this module alone, so the safe option is to block new reservations or reimbursements once actual unreserved collateral falls below modeled headroom.
  Date/Author: 2026-03-24 / Codex.
- Decision: Recovered ERC1155 deposit evidence should only be auto-assigned when the module can satisfy an entire compatible intent group one-to-one.
  Rationale: partial assignment inside a duplicate group can choose the wrong economic intent when multiple orders share the same token/source/amount signature; requiring full-group matching avoids that unsafe guess while still resolving non-ambiguous duplicates.
  Date/Author: 2026-03-24 / Codex.
- Decision: Deposited or filled intents must not count as active order execution for later archive/order scheduling.
  Rationale: treating any open intent with an `orderId` as globally active serialized the whole agent behind long reimbursement windows and could block later depositors from progressing even after the prior trade had already settled.
  Date/Author: 2026-03-24 / Codex.
- Decision: Valid signed intents should be persisted even when the Safe collateral balance cannot be read at acceptance time; actual Safe headroom must instead gate order placement.
  Rationale: message-driven signed intents are otherwise lossy under transient RPC failures, while order-stage gating still prevents overcommit against actual Safe collateral.
  Date/Author: 2026-03-24 / Codex.
- Decision: Stage-prep reads such as fee-rate lookup, ERC1155 balance checks, and receipt polling must fail into persisted retryable or ambiguous lifecycle state rather than throwing out of the deterministic loop.
  Rationale: long-running agents need transient RPC/API failures to preserve intent state and retry/back off safely instead of dropping work or spinning indefinitely.
  Date/Author: 2026-03-24 / Codex.
- Decision: Recovery evidence from signals and CTF logs should be deduplicated by strong onchain identity first, then by weaker block/source/token/amount identity.
  Rationale: the same real ERC1155 transfer can be observed through multiple recovery channels, and failing to collapse those views reintroduces double-attribution bugs across otherwise identical intents.
  Date/Author: 2026-03-24 / Codex.
- Decision: Mined-but-reverted deposit and reimbursement transactions should use retry backoff instead of becoming instantly eligible again.
  Rationale: reverted receipts prove the previous submission reached chain, so retrying on every poll is both noisy and unsafe under deterministic onchain failures.
  Date/Author: 2026-03-24 / Codex.
- Decision: Persist `orderDispatchBlockNumber` and allow recovered-deposit reconciliation to use it when deposit-stage markers are missing.
  Rationale: a filled intent still needs a deterministic lower bound for scanning Safe ERC1155 transfer logs after restart/state loss, and order dispatch is the earliest durable point that is both available locally and safely before any deposit could occur.
  Date/Author: 2026-03-24 / Codex.
- Decision: Treat empty/malformed CLOB order-status payloads as reconciliation failures after timeout rather than silently continuing.
  Rationale: once a submitted order times out, the safe behavior is to surface manual-recovery state explicitly instead of leaving the order indefinitely active with no error signal.
  Date/Author: 2026-03-24 / Codex.
- Decision: Require `proposer` on live proposal signals before recovering a reimbursement proposal hash.
  Rationale: proposer is available from the shared polling layer, so allowing proposer-less live signals to recover hashes weakens the trust boundary for no upside.
  Date/Author: 2026-03-24 / Codex.
- Decision: Order payload construction should reuse the module's already-resolved runtime/config chain ID instead of re-querying `publicClient.getChainId()` ad hoc.
  Rationale: intermittent chain-id RPC failures should not prevent CLOB order signing when the runtime chain was already resolved earlier in the same loop or provided by config.
  Date/Author: 2026-03-24 / Codex.
- Decision: A deposit stage may only advance to `tokenDeposited=true` when the tool output includes a durable transaction hash or later onchain reconciliation provides equivalent evidence.
  Rationale: allowing a hashless `confirmed` tool result to unlock reimbursement weakens the audit trail and can let the module reimburse without a verifiable deposit transaction identifier.
  Date/Author: 2026-03-24 / Codex.

## Outcomes & Retrospective

The hardening pass fixed the largest remaining concrete issues I found:

- state hydration is now scoped and validated across entry points, instead of depending on call order
- persisted state now records a scope descriptor and rejects mismatched runtime re-use
- reimbursement proposal recovery now requires the decoded USDC transfer recipient and amount to match the intent
- reimbursement backfill records now carry recipient information, and legacy cached backfill data is rebuilt before being trusted
- new regressions cover wrong-recipient proposal recovery, state-context isolation across Safes, and scope mismatch detection
- recovered ERC1155 deposits are now reconciled through canonical recovery evidence, each recovered transfer can satisfy at most one intent, and ambiguous multi-match evidence is left unresolved rather than assigned unsafely
- recovered ERC1155 log scans now use chunked history queries and warn/continue on scan failures instead of risking a full-loop wedge from a long ambiguity window
- dispatched orders no longer expire and release credit during the pre-output grace window
- new intent acceptance and reimbursement proposal emission are now capped by actual Safe collateral headroom, not just reconstructed historical deposits
- state signals now include a collateral summary with modeled vs actual availability and shortfall
- recovered duplicate ERC1155 deposits now resolve full compatible groups one-to-one when enough evidence exists, while insufficient evidence remains fail-closed
- deposited intents no longer block unrelated later intents from reaching archive/order stages just because they still carry a historical `orderId`
- valid signed intents are no longer dropped when Safe collateral reads fail; they persist and retry once actual Safe balance reads recover
- malformed historical reimbursement proposals no longer abort the full reimbursement backfill pass
- order placement now treats the current intent's own reservation as usable headroom instead of subtracting it away
- fee-rate fetch failures, ERC1155 balance-read failures, and generic post-submit receipt RPC failures now persist retryable or ambiguous stage state rather than aborting the loop
- archive-signal enrichment now tolerates malformed legacy persisted intents instead of crashing `enrichSignals()`
- recovered ERC1155 evidence is now deduplicated across weak signal and strong log sources before intent assignment, so one real transfer cannot be counted twice through different recovery channels
- malformed proposal-signal / backfill addresses no longer crash proposal recovery, and hashless matching proposal signals no longer mask later valid hashed ones
- reverted ERC1155 deposit receipts and reverted reimbursement proposal receipts now back off before retrying instead of spinning every poll on deterministic onchain failures
- already-completed ERC1155 deposits can now be rediscovered after restart/state loss even when no deposit submission marker survives, because the module reuses persisted order dispatch provenance during recovery scans
- malformed-but-non-throwing CLOB order-status payloads now transition into explicit manual-recovery refresh error state instead of silently spinning forever
- live reimbursement proposal recovery now requires an authorized proposer on proposal signals instead of treating proposer as optional
- reimbursement proposal-hash recovery now requires exact signer/recipient/amount matches for both live signals and backfilled proposal commitments, instead of trusting intentKey/recipient alone
- duplicate live or backfilled reimbursement proposals now fail closed during hash recovery instead of silently attaching the first matching hash
- duplicate executed reimbursement proposals found during restart backfill now settle the intent as reimbursed instead of leaving it open forever
- the credit ledger no longer suppresses malformed or cross-signer backfilled reimbursement commitments just because they reuse an intent key; unmatched commitments continue to reserve the appropriate signer’s credit
- new regressions cover wrong-signer reimbursement backfills, duplicate live proposal recovery ambiguity, and duplicate executed reimbursement backfills

Remaining concerns after the second review are operational rather than obviously broken code paths. The main one is that the `token_balance` order-settlement fallback is safest when the trading wallet is dedicated to this agent, because unrelated same-token wallet inflows could otherwise confuse attribution. That is a narrower residual assumption than the concrete lifecycle and state bugs fixed in this run.

## Context and Orientation

The affected module is `agent-library/agents/polymarket-intent-trader/`. The current code is split across:

- `agent.js`: module entry points, parsing, orchestration, state hydration/persistence, action planning integration, and tool output handling.
- `planner.js`: chooses the next lifecycle action candidate.
- `lifecycle-stage.js`: shared stage field metadata.
- `lifecycle-reducers.js`: common lifecycle state transition helpers.
- `credit-ledger.js`: credit and reimbursement commitment accounting.
- `history-backfill.js`: Safe deposit and reimbursement history reconstruction.
- `polymarket-reconciliation.js`: Polymarket order/trade interpretation and runtime market constraints.
- `test-polymarket-intent-trader-agent.mjs`: large module regression suite.

The highest-risk behaviors are:

- accepting intents against collateral that is not actually free
- duplicating orders, deposits, or reimbursement proposals across restarts
- losing track of already-submitted side effects
- falsely marking intents complete from unrelated external events
- getting stuck forever when a side effect succeeded but direct confirmation was lost

## Plan of Work

First establish a clean baseline by running the module test suite and validator. Then perform a code review centered on state persistence, restart recovery, lifecycle stage transitions, on-chain/off-chain reconciliation, and credit conservation. Convert confirmed findings into targeted fixes with regression tests. After the first fix pass, re-run validation and perform a second review pass from the new code state rather than relying on the first set of findings. Stop when the remaining issues are minor, speculative, or blocked on runtime integrations outside this repository.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Baseline validation:
   `node agent-library/agents/polymarket-intent-trader/test-polymarket-intent-trader-agent.mjs`
   `node agent-library/agents/polymarket-intent-trader/test-start-with-preflight.mjs`
   `node agent/scripts/validate-agent.mjs --module=polymarket-intent-trader`
2. Inspect the main module and helper boundaries with `rg`, `sed`, and targeted file reads.
3. Patch only module-local files under `agent-library/agents/polymarket-intent-trader/` unless a confirmed shared-infrastructure bug forces a broader change.
4. Add or tighten module-local regression tests for every confirmed major issue.
5. Re-run the validation commands after each meaningful batch of fixes.
6. Perform at least one additional code review pass after tests are green.

## Validation and Acceptance

Required commands:

- `node agent-library/agents/polymarket-intent-trader/test-polymarket-intent-trader-agent.mjs`
- `node agent-library/agents/polymarket-intent-trader/test-start-with-preflight.mjs`
- `node agent/scripts/validate-agent.mjs --module=polymarket-intent-trader`

Acceptance requires:

- the module tests pass
- module validation passes
- confirmed major lifecycle/accounting/recovery issues found during this run are fixed with regression coverage
- a final review pass does not surface additional major issues

## Idempotence and Recovery

The review process is safe to retry because the work is confined to repo files and module-local tests. The main implementation risk is introducing new lifecycle regressions while fixing restart or reconciliation paths; mitigate that by keeping the plan current, expanding regression coverage before broader refactors, and re-running validation after each significant patch.

If interrupted, resume by reading this file first, then inspect the latest diffs under `agent-library/agents/polymarket-intent-trader/`, then re-run the baseline validation commands to confirm the current state.

## Artifacts and Notes

Initial module size snapshot:

- `agent.js`: 2663 lines
- `polymarket-reconciliation.js`: 722 lines
- `test-polymarket-intent-trader-agent.mjs`: 3518 lines

Validation transcript:

- Baseline before changes:
  `node agent-library/agents/polymarket-intent-trader/test-polymarket-intent-trader-agent.mjs`
  `node agent-library/agents/polymarket-intent-trader/test-start-with-preflight.mjs`
  `node agent/scripts/validate-agent.mjs --module=polymarket-intent-trader`
- Final after changes:
  `node agent-library/agents/polymarket-intent-trader/test-polymarket-intent-trader-agent.mjs`
  `node agent-library/agents/polymarket-intent-trader/test-start-with-preflight.mjs`
  `node agent/scripts/validate-agent.mjs --module=polymarket-intent-trader`

Latest hardening additions:

- signed intents now require their signed `chainId` to match the runtime chain before the module will accept or even enrich them as candidate trades
- if the runtime cannot determine its own chain id from RPC or config, signed-intent processing now fails retryably instead of silently becoming cross-chain permissive
- already-persisted open intents now also require a known runtime chain before execution resumes, instead of only guarding newly arrived signed messages
- expiry can now be inferred from signed UTC time text as well as the signed envelope, matching the commitment instead of rejecting text-only expiries
- conflicting signed expiry sources now fail closed as `ambiguous_expiry` instead of silently preferring `deadline`
- new intent admission now uses actual Safe USDC headroom when that balance read succeeds, so over-budget intents are ignored up front instead of being accepted and wedged later
- ERC1155 deposit submissions that return `submitted` without a transaction hash now fail closed as ambiguous instead of becoming retryable duplicate deposits after timeout
- Polymarket order submissions that are already manual-recovery-only (`missing_order_id` or side-effects-likely-committed without an order id) now stop globally blocking later archive/order work immediately instead of for the full pending-tx timeout
- regressions were added for wrong-chain signed messages, unknown runtime chain handling, text-only expiry parsing, conflicting expiry rejection, actual-balance admission blocking, missing ERC1155 tx hashes, immediate unblocking after `missing_order_id`, and immediate unblocking after ambiguous committed order submissions

## Interfaces and Dependencies

Key local interfaces:

- `getDeterministicToolCalls`, `enrichSignals`, `onToolOutput` in `agent.js`
- stage helpers in `lifecycle-stage.js`
- reducer helpers in `lifecycle-reducers.js`
- planning in `planner.js`
- credit accounting in `credit-ledger.js`
- history reconstruction in `history-backfill.js`
- Polymarket settlement and market constraints in `polymarket-reconciliation.js`

Runtime dependencies:

- Polymarket CLOB API and fee/tick-size data
- Safe/OG proposal signals and proposal event arrays
- local state file persistence
- module-local test harnesses and `agent/scripts/validate-agent.mjs`
