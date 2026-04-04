# Implement Deterministic Momentum Strategy For `first-proxy`

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Turn `agent-library/agents/first-proxy/` into a deterministic momentum-trading agent with no LLM dependency. Every six hours, the agent should evaluate WETH and cbBTC momentum over the preceding six-hour deployment-anchored window, buy $25 of the stronger performer, and fund that purchase from the weakest currently held eligible asset in the Safe. If both non-stablecoins are up and the Safe has USDC, the agent should spend USDC first. If the weakest asset does not have enough notional to fund the full $25 trade, the agent should consume the full available amount from that asset and continue with the next-weakest eligible funding asset until the $25 notional target is met. The cadence is four $25 trades per deployment-anchored day, which matches the commitment's $100/day limit.

## Progress

- [x] 2026-04-04 21:46Z: Re-read `PLANS.md`, `AGENTS.md`, `agent-library/AGENTS.md`, and the `add-agent-commitment` workflow before planning implementation.
- [x] 2026-04-04 21:46Z: Reviewed deterministic-agent patterns in `agent-library/agents/deterministic-dca-agent/`, swap validation in `agent-library/agents/price-race-swap/`, and the deterministic decision runtime under `agent/src/lib/decision-runtime.js`.
- [x] 2026-04-04 21:46Z: Updated `agent-library/agents/first-proxy/commitment.txt` and `agent-library/agents/first-proxy/agent.json` to drop UMA and align the module scope to USDC, WETH, and cbBTC only.
- [ ] Implement deterministic momentum strategy logic in `agent-library/agents/first-proxy/agent.js`.
- [ ] Add module-local chain config for token addresses, valuation pools, and swap routes.
- [ ] Add regression tests for epoch scheduling, ranking, split funding, and proposal suppression.
- [ ] Run module validation and record the final evidence.

## Surprises & Discoveries

- Observation: The repo already supports deterministic agents through `getDeterministicToolCalls()`, so this feature does not require any LLM dependency or shared runner changes.
  Evidence: `agent/src/lib/decision-runtime.js`.

- Observation: The built-in Uniswap V3 action shape is single-hop per swap action, but `build_og_transactions` can include multiple actions in one proposal.
  Evidence: `agent/src/lib/tx.js`.

- Observation: Existing price helpers read current Uniswap V3 `slot0`, but there is no shared helper yet for locating a historical block nearest a target timestamp.
  Evidence: `agent/src/lib/uniswapV3Price.js` and `agent/src/lib/chain-history.js`.

## Decision Log

- Decision: Keep all momentum logic local to `agent-library/agents/first-proxy/`.
  Rationale: The strategy is commitment-specific and does not justify shared runner changes.
  Date/Author: 2026-04-04 / Codex.

- Decision: Use a deterministic engine, not an LLM prompt loop.
  Rationale: The strategy is fully specified and the runtime already supports deterministic planning.
  Date/Author: 2026-04-04 / Codex.

- Decision: Simplify the trade universe to USDC, WETH, and cbBTC.
  Rationale: This reduces implementation surface and matches the latest user direction.
  Date/Author: 2026-04-04 / Codex.

- Decision: Allow one six-hour trade proposal to contain multiple swap actions when the weakest funding asset alone is insufficient to fund the full $25 target.
  Rationale: The user explicitly wants the strategy to consume the full weakest asset amount first, then continue with the next-weakest held asset.
  Date/Author: 2026-04-04 / Codex.

- Decision: Anchor both six-hour epochs and day boundaries to the commitment deployment timestamp.
  Rationale: This matches the commitment's time rules and keeps the strategy's $100/day cadence aligned with the commitment text.
  Date/Author: 2026-04-04 / Codex.

## Outcomes & Retrospective

The design has been narrowed enough to implement safely without ambiguity around asset scope, cadence, or partial funding behavior. The main remaining technical choice is how much routing flexibility to support in v1. The safe first implementation is to require configured direct single-hop routes for each funding-token to winner-token leg and skip an epoch when a needed direct route is missing.

## Context and Orientation

The affected module is `agent-library/agents/first-proxy/`. The current files are:

- `agent-library/agents/first-proxy/agent.js`: still the copied default scaffold and will become the deterministic strategy engine.
- `agent-library/agents/first-proxy/commitment.txt`: now the approved commitment for USDC, WETH, and cbBTC.
- `agent-library/agents/first-proxy/agent.json`: module metadata; already updated to remove UMA.
- `agent-library/agents/first-proxy/test-first-proxy-agent.mjs`: current minimal smoke test; will expand into a deterministic module regression suite.
- `agent-library/agents/first-proxy/migration-notes.md`: should be updated once the config surface is settled.

Relevant reusable patterns:

- `agent-library/agents/deterministic-dca-agent/agent.js`: deterministic state reconstruction, proposal history backfill, and strict local tool-call validation.
- `agent-library/agents/price-race-swap/agent.js`: Uniswap V3 quoter usage, slippage floor derivation, and swap-action validation/normalization.
- `agent/src/lib/decision-runtime.js`: deterministic decision entrypoint wiring.
- `agent/src/lib/tx.js`: supported action kinds and how `uniswap_v3_exact_input_single` is encoded into OG proposal transactions.

## Plan of Work

First, add a module-local `config.json` that defines the chain-specific addresses and route metadata needed to value and swap USDC, WETH, and cbBTC without hardcoding them in the commitment. Second, replace the default prompt-first agent implementation with a deterministic planner that reconstructs the current six-hour epoch, compares WETH and cbBTC performance over the previous six hours, selects the winner, chooses one or more funding assets in weakest-to-strongest order, and emits one `build_og_transactions` call containing the required swap actions for that epoch. Third, add strict validation so the module only allows the intended swap shapes and sizes, then expand the local test suite to cover ranking, split funding, slippage quoting, and duplicate suppression.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Create `agent-library/agents/first-proxy/config.json`.
   Include top-level policy values such as `pollIntervalMs`, `firstProxy.tradeAmountUsd`, `firstProxy.epochSeconds`, `firstProxy.daySeconds`, `firstProxy.slippageBps`, a deterministic tie-break order, and any default fee-tier preferences.
   Under `byChain.<chainId>`, add token addresses for USDC, WETH, and cbBTC, the Safe/OG addresses when known, `watchAssets`, USDC valuation pool metadata for WETH and cbBTC, and direct single-hop route definitions for each supported funding-token to winner-token leg.

2. Rewrite `agent-library/agents/first-proxy/agent.js`.
   Export `getDeterministicToolCalls()`.
   Keep `getSystemPrompt()` minimal or remove its importance; the runtime should rely on deterministic planning.

3. Implement deployment-anchored epoch reconstruction.
   Resolve the commitment deployment timestamp from `config.startBlock` when present; otherwise auto-discover the OG deployment block and read its timestamp.
   Compute the closed epoch index as `floor((nowSeconds - deploymentTimestamp) / 21600)`.
   Skip until at least one full six-hour epoch has elapsed.

4. Implement historical momentum reads.
   Add a module-local helper that finds the highest block with timestamp less than or equal to a target timestamp.
   For WETH and cbBTC, read their configured USDC valuation pools at the previous epoch boundary block and at the latest block, then compute percentage change over the epoch.

5. Implement winner and funding selection.
   Winner: whichever of WETH or cbBTC has the larger six-hour percentage gain; deterministic tie-break from config if equal.
   Funding preference:
   - If both non-stablecoins are up and Safe USDC balance can contribute, rank USDC ahead of non-stable funding assets.
   - Otherwise rank eligible non-winner assets by lowest six-hour return first.
   - If the weakest asset has less than the needed remaining notional, consume its full available notional and continue to the next-ranked asset until the $25 target is fully funded or eligible balances are exhausted.
   Skip the epoch if the total eligible funding notional is still below $25.

6. Emit one OG proposal per epoch with one or more swap actions.
   Build a single `build_og_transactions` call whose `actions` array contains one `uniswap_v3_exact_input_single` action per funding leg.
   Each action should swap from one funding token directly into the winner token, route output to the commitment Safe, and use a quoted `amountOutMinWei` with a fixed slippage guard.
   Include a structured explanation containing at least `strategy=first-proxy-momentum`, `epoch=<n>`, `winner=<symbol>`, `funding=<comma-separated symbols>`, and the valuation snapshot used for ranking.

7. Prevent duplicate or conflicting proposals.
   Reconstruct prior momentum proposals from OG history starting at `config.startBlock` or the auto-discovered deployment block.
   If the current epoch already has a live, executed, or otherwise still-pending first-proxy momentum proposal, emit no new tool calls.
   Also emit no new proposal when `onchainPendingProposal` is true.

8. Validate and normalize tool calls locally.
   Allow only `build_og_transactions` for this module in the first implementation.
   Require each action to be `uniswap_v3_exact_input_single` with an allowlisted direct route, recipient equal to `commitmentSafe`, `operation=0`, positive `amountInWei`, and a quoted `amountOutMinWei`.
   Reject any action whose input token equals the selected winner token or whose total input notional exceeds the intended $25 target.

9. Expand `agent-library/agents/first-proxy/test-first-proxy-agent.mjs`.
   Cover:
   - no action before the first epoch closes
   - WETH wins / cbBTC funded
   - cbBTC wins / WETH funded
   - all-up epoch with USDC used first
   - weakest asset partially funds and next-weakest completes the trade
   - total eligible balance below $25 causes a skip
   - direct route missing causes a skip
   - duplicate epoch proposal suppression
   - onchain pending proposal suppression
   - tie-break behavior
   - slippage and quoted minimum-output normalization

10. Refresh module metadata and notes.
    Update `agent-library/agents/first-proxy/agent.json` description if implementation wording shifts.
    Update `agent-library/agents/first-proxy/migration-notes.md` so the new config surface is documented.

## Validation and Acceptance

Required commands from `/Users/johnshutt/Code/oya-commitments`:

    node agent/scripts/validate-agent.mjs --module=first-proxy
    node agent-library/agents/first-proxy/test-first-proxy-agent.mjs

Acceptance criteria:

- `first-proxy` runs without any OpenAI configuration.
- The module emits at most one proposal per closed six-hour epoch.
- The strategy universe is limited to USDC, WETH, and cbBTC in both config and implementation.
- The agent buys exactly $25 notional of the winner when sufficient eligible funding exists.
- When the weakest eligible funding asset is insufficient, the agent consumes it fully and continues with the next-ranked asset.
- The agent never proposes when the current epoch already has a live/executed proposal or when there is any onchain pending proposal.
- All emitted swap actions are direct, allowlisted, Safe-recipient swaps with quoted slippage floors.

If live chain config is not yet available, mocked-public-client tests are sufficient for the first implementation pass.

## Idempotence and Recovery

This work is safe to retry because it stays within `agent-library/agents/first-proxy/` plus this plan file. If interrupted, resume by reading this ExecPlan first, then inspect the current `git diff` for `agent-library/agents/first-proxy/` and re-run the module validation commands. If a target chain lacks a needed direct funding-token to winner-token route, the safe fallback is to skip that epoch rather than silently change the routing model.

## Artifacts and Notes

Current approved strategy summary:

- Assets: USDC, WETH, cbBTC.
- Momentum universe: WETH and cbBTC only.
- Epoch length: 6 hours = 21,600 seconds.
- Trade size: $25 per closed epoch.
- Max day cadence: 4 trades = $100 per deployment-anchored day.
- Funding behavior: use USDC first only when both non-stablecoins are up and USDC is available; otherwise consume eligible held assets from weakest to strongest until $25 is reached.
- Testing simplification: assume enough total eligible balance exists across held assets to fund a trade when tests intend a tradeable scenario.

Known implementation constraint:

- Because swap encoding is single-hop per action, the first implementation should require configured direct routes for each funding-token -> winner-token leg and may need multiple actions inside one proposal when funding is split across assets.

## Interfaces and Dependencies

Primary files expected to change:

- `agent-library/agents/first-proxy/agent.js`
- `agent-library/agents/first-proxy/config.json`
- `agent-library/agents/first-proxy/test-first-proxy-agent.mjs`
- `agent-library/agents/first-proxy/agent.json`
- `agent-library/agents/first-proxy/migration-notes.md`
- `plans/first-proxy-momentum.md`

Primary repo interfaces:

- `agent/src/lib/decision-runtime.js`
- `agent/src/lib/tx.js`
- `agent/src/lib/chain-history.js`
- `agent/src/lib/uniswapV3Price.js`

External/runtime dependencies:

- viem `publicClient`
- Uniswap V3 valuation pools for WETH/USDC and cbBTC/USDC
- Uniswap V3 quoter and router on the configured chain
- OG proposal history for duplicate suppression
