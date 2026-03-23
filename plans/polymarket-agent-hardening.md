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

## Surprises & Discoveries

- Observation: The module has already been partly split into stage, reducer, reconciliation, history, and ledger helpers, but `agent.js` is still very large and still owns the orchestration contract for nearly every lifecycle edge.
  Evidence: `agent.js` is 2663 lines; the next-largest local helper is `polymarket-reconciliation.js` at 722 lines.
- Observation: `enrichSignals()` and `onToolOutput()` were not configuring the runtime state context before hydrating local state, so state-file selection depended on whether `getDeterministicToolCalls()` had run first.
  Evidence: `configureRuntimeStateContext()` was only called from `getDeterministicToolCalls()` before this pass; a new regression test now proves safe separation across two commitment Safes.
- Observation: reimbursement proposal recovery trusted explanation text too much and did not require the recovered proposal’s ERC20 transfer recipient to match the intent.
  Evidence: the module matched proposal signals by explanation equality and backfilled commitments by `intentKey` without binding the decoded transfer recipient to the intended reimbursement target.

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

## Outcomes & Retrospective

The hardening pass fixed the largest remaining concrete issues I found:

- state hydration is now scoped and validated across entry points, instead of depending on call order
- persisted state now records a scope descriptor and rejects mismatched runtime re-use
- reimbursement proposal recovery now requires the decoded USDC transfer recipient and amount to match the intent
- reimbursement backfill records now carry recipient information, and legacy cached backfill data is rebuilt before being trusted
- new regressions cover wrong-recipient proposal recovery, state-context isolation across Safes, and scope mismatch detection

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
