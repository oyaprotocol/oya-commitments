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

## Surprises & Discoveries

- Observation: The module has already been partly split into stage, reducer, reconciliation, history, and ledger helpers, but `agent.js` is still very large and still owns the orchestration contract for nearly every lifecycle edge.
  Evidence: `agent.js` is 2663 lines; the next-largest local helper is `polymarket-reconciliation.js` at 722 lines.
- Observation: `enrichSignals()` and `onToolOutput()` were not configuring the runtime state context before hydrating local state, so state-file selection depended on whether `getDeterministicToolCalls()` had run first.
  Evidence: `configureRuntimeStateContext()` was only called from `getDeterministicToolCalls()` before this pass; a new regression test now proves safe separation across two commitment Safes.
- Observation: reimbursement proposal recovery trusted explanation text too much and did not require the recovered proposal’s ERC20 transfer recipient to match the intent.
  Evidence: the module matched proposal signals by explanation equality and backfilled commitments by `intentKey` without binding the decoded transfer recipient to the intended reimbursement target.
- Observation: recovered ERC1155 deposits were still reconciled intent-by-intent, so one recovered transfer could satisfy multiple indistinguishable intents and the log path still used unchunked `getLogs` calls.
  Evidence: the old `reconcileRecoveredDepositSubmissions()` loop matched each intent independently via `findRecoveredDepositSignal()` / `findRecoveredDepositLog()` and the log recovery helper queried the full ambiguity window in one request per event type.

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
