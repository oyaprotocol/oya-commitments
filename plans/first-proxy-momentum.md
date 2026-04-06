# Implement Deterministic Momentum Strategy For `first-proxy`

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Turn `agent-library/agents/first-proxy/` into a deterministic `Agent Proxy` strategy with no LLM dependency. Every six hours, the agent evaluates WETH and cbBTC momentum over the preceding six-hour deployment-anchored window using Alchemy Prices API USD prices, deposits the stronger performer into the Safe from the agent wallet, and proposes reimbursement out of the weakest eligible Safe assets. If both non-stablecoins are up and the Safe holds USDC, USDC is used first. The cadence is four $25 trades per deployment-anchored day, matching the commitment’s $100/day limit.

## Progress

- [x] 2026-04-04 21:46Z: Re-read `PLANS.md`, `AGENTS.md`, `agent-library/AGENTS.md`, and the `add-agent-commitment` workflow.
- [x] 2026-04-04 21:46Z: Reviewed deterministic agent patterns and the decision runtime.
- [x] 2026-04-04 21:46Z: Updated `agent-library/agents/first-proxy/commitment.txt` and `agent-library/agents/first-proxy/agent.json` to scope the commitment to USDC, WETH, and cbBTC only.
- [x] 2026-04-04 22:38Z: Replaced the default scaffold in `agent-library/agents/first-proxy/agent.js` with a deterministic momentum engine that emits `make_deposit`, `build_og_transactions`, and `post_bond_and_propose`.
- [x] 2026-04-04 22:38Z: Added `agent-library/agents/first-proxy/config.json` for non-secret module policy defaults.
- [x] 2026-04-04 22:38Z: Expanded `agent-library/agents/first-proxy/test-first-proxy-agent.mjs` into a regression suite covering epoch scheduling, split reimbursement, USDC preference, pending-plan replay, and proposal suppression.
- [x] 2026-04-04 22:38Z: Updated `agent-library/agents/first-proxy/migration-notes.md` to document the final config surface and proxy-flow behavior.
- [x] 2026-04-04 22:39Z: Ran `node agent/scripts/validate-agent.mjs --module=first-proxy`.
- [x] 2026-04-04 22:39Z: Ran `node agent-library/agents/first-proxy/test-first-proxy-agent.mjs`.
- [x] 2026-04-06 18:02Z: Replaced onchain AMM valuation with CoinGecko current and historical USD prices, added always-on balance snapshot polling for deterministic reevaluation, and reran module validation.
- [x] 2026-04-06 23:20Z: Replaced CoinGecko with Alchemy Prices API, derived price auth from Alchemy env/RPC configuration, fixed stale current-price caching, and reran module validation.

## Surprises & Discoveries

- Observation: The first implementation direction was wrong for this commitment.
  Evidence: the commitment uses the `Agent Proxy` rule, which authorizes agent-funded deposits plus reimbursement withdrawals, not Safe-side DEX swaps.

- Observation: The deterministic runtime already passes `agentAddress` into both `getDeterministicToolCalls()` and `validateToolCalls()`.
  Evidence: `agent/src/lib/decision-runtime.js`.

- Observation: Deposit-success / proposal-failure needs explicit local recovery state to avoid repeated deposits.
  Evidence: once `make_deposit` succeeds, recomputing the strategy on the next tick would otherwise deposit again before reimbursement is proposed.

- Observation: Once valuation moved offchain, AMM-backed price triggers were no longer the right heartbeat mechanism.
  Evidence: the module now relies on always-emitted balance snapshots plus deterministic enrichment instead of onchain pool trigger collection.

## Decision Log

- Decision: Keep all momentum logic local to `agent-library/agents/first-proxy/`.
  Rationale: The strategy is commitment-specific and does not justify shared runner changes.
  Date/Author: 2026-04-04 / Codex.

- Decision: Use a deterministic engine, not an LLM prompt loop.
  Rationale: The strategy is fully specified and the runtime already supports deterministic planning.
  Date/Author: 2026-04-04 / Codex.

- Decision: Simplify the trade universe to USDC, WETH, and cbBTC.
  Rationale: This matches the approved commitment scope and reduces agent surface area.
  Date/Author: 2026-04-04 / Codex.

- Decision: Implement the strategy as proxy deposits plus reimbursement transfers, not Safe-side swaps.
  Rationale: That matches the actual `Agent Proxy` commitment semantics and the user’s “agent has enough tokens on hand” clarification.
  Date/Author: 2026-04-04 / Codex.

- Decision: Persist a pending epoch plan after deposit success and replay only the reimbursement proposal until it is submitted.
  Rationale: This prevents duplicate deposits if proposal submission fails after the deposit is already onchain.
  Date/Author: 2026-04-04 / Codex.

- Decision: Value both the winner deposit and the reimbursement legs using the same deposit-time fair-price snapshot encoded into the proposal explanation.
  Rationale: The commitment states that token prices are based on the prices at the time of the deposit.
  Date/Author: 2026-04-04 / Codex.

- Decision: Source current and historical prices from Alchemy Prices API instead of CoinGecko or onchain AMM pools.
  Rationale: The user explicitly requested Alchemy for simpler operational setup alongside the Alchemy node provider.
  Date/Author: 2026-04-06 / Codex.

## Outcomes & Retrospective

`first-proxy` now runs as a deterministic proxy-trading module with no OpenAI dependency. The agent reconstructs six-hour deployment-anchored epochs, ranks WETH versus cbBTC by historical performance, deposits the winning asset from the agent wallet, and proposes one or more ERC20 reimbursement transfers back to the agent. The module also persists pending deposit state so a successful deposit is not repeated if proposal submission has to be retried later.

## Context and Orientation

The implemented module lives entirely under `agent-library/agents/first-proxy/`:

- `agent.js`: deterministic proxy-trade planner, validation, and recovery state handling
- `config.json`: non-secret policy defaults
- `commitment.txt`: approved commitment text for USDC/WETH/cbBTC proxy trading
- `test-first-proxy-agent.mjs`: module regression tests
- `migration-notes.md`: runtime config notes

Shared runtime touchpoints used by the module:

- `agent/src/lib/decision-runtime.js`
- `agent/src/lib/tx.js`
- `agent/src/lib/chain-history.js`

## Plan of Work

The implementation is complete for the first deterministic pass. Remaining future work, if desired, would be operational rather than architectural: populate real chain-specific addresses under `byChain`, run the module against a live test chain, and add broader recovery/backfill from historical deposit logs if the module needs to survive restarts without relying on its local state file.

## Concrete Steps

Completed implementation steps:

1. Added `agent-library/agents/first-proxy/config.json`.
   It defines `tradeAmountUsd`, `epochSeconds`, `daySeconds`, `pendingEpochTtlMs`, and the tie-break order while leaving `byChain` open for chain-specific addresses.

2. Rewrote `agent-library/agents/first-proxy/agent.js`.
   The module now exports deterministic planning, heartbeat triggers, strict tool-call validation, and output hooks for pending-plan persistence.

3. Implemented deployment-anchored epoch reconstruction and historical price lookup.
   The module resolves the deployment block, computes closed six-hour epochs, and fetches Alchemy historical USD prices for WETH and cbBTC at both epoch boundaries.

4. Implemented winner selection and reimbursement allocation.
   The winner is whichever of WETH or cbBTC performed better over the last closed epoch.
   Reimbursement is sourced from USDC first only when both momentum assets are up; otherwise the Safe reimburses from the weakest eligible assets first, spilling into the next asset when needed.

5. Implemented true `Agent Proxy` execution.
   Fresh runs emit `make_deposit` for the winner token followed by `build_og_transactions` and `post_bond_and_propose` for the reimbursement transfers.
   Replay runs emit only `build_og_transactions` and `post_bond_and_propose` using the persisted deposit-time plan.

6. Added regression tests and validation evidence.

## Validation and Acceptance

Commands run from `/Users/johnshutt/Code/oya-commitments`:

    node agent/scripts/validate-agent.mjs --module=first-proxy
    node agent-library/agents/first-proxy/test-first-proxy-agent.mjs

Observed results:

- `node agent/scripts/validate-agent.mjs --module=first-proxy`
  Result: `[agent] Agent module OK: /Users/johnshutt/Code/oya-commitments/agent-library/agents/first-proxy/agent.js`

- `node agent-library/agents/first-proxy/test-first-proxy-agent.mjs`
  Result: `[test] first-proxy deterministic momentum agent OK`

Acceptance status:

- `first-proxy` runs without OpenAI configuration: complete.
- The strategy universe is limited to USDC, WETH, and cbBTC: complete.
- The agent emits at most one proposal flow per closed six-hour epoch: complete.
- The agent deposits the winner token and reimburses from the weakest eligible Safe assets: complete.
- Split reimbursement across multiple tokens works: complete.
- Deposit-success / proposal-retry recovery is covered: complete.

## Idempotence and Recovery

This implementation is safe to retry because it is confined to `agent-library/agents/first-proxy/` plus this plan file. The module persists two pieces of local state in its module state file:

- submitted epochs waiting for chain reconciliation
- a pending deposit-time proposal plan that should be replayed without re-depositing

If work is resumed later, start by reading this ExecPlan, inspecting `agent-library/agents/first-proxy/agent.js`, and re-running the two validation commands above.

## Artifacts and Notes

Current strategy summary:

- Assets: USDC, WETH, cbBTC
- Momentum universe: WETH and cbBTC only
- Epoch length: 21,600 seconds
- Trade budget: deposit up to $25 notional of the winner each closed epoch
- Day budget: 4 epochs = $100 per deployment-anchored day
- Reimbursement rule:
  - If both WETH and cbBTC are up and the Safe has USDC, reimburse from USDC first.
  - Otherwise reimburse from the weakest eligible Safe assets first.
  - If the weakest asset is insufficient, consume it fully and continue with the next one.

Known limitation in v1:

- Recovery across machines still depends on the local state file for pending deposits. A future hardening pass could backfill agent deposit history from chain events instead.

## Interfaces and Dependencies

Files changed:

- `agent-library/agents/first-proxy/agent.js`
- `agent-library/agents/first-proxy/config.json`
- `agent-library/agents/first-proxy/test-first-proxy-agent.mjs`
- `agent-library/agents/first-proxy/agent.json`
- `agent-library/agents/first-proxy/migration-notes.md`
- `plans/first-proxy-momentum.md`

Primary runtime dependencies:

- viem `publicClient`
- Alchemy Prices API by-symbol and historical-price endpoints
- OG proposal history for duplicate suppression
