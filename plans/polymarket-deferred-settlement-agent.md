# Deferred Settlement Polymarket Agent And Oya Trade Log Node

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build a new example agent that trades on Polymarket with the agent's own wallet and funds, keeps the user's capital parked in the commitment Safe as reimbursement collateral, and settles the net result only when the market stream is over. In this design, the agent can change positions quickly offchain and off-Safe, but every material trade state change is recorded in a signed trade log that an Oya node archives to IPFS and co-signs. When the position is finally closed or the market resolves, the agent deposits the user's gross proceeds into the commitment and then claims reimbursement only for the still-outstanding agent-funded principal.

After this work, a reviewer or operator should be able to:

- run a standalone Oya trade-log publication node for a selected agent module
- run a new agent module under `agent-library/agents/` that executes external Polymarket trades and maintains a durable liability ledger
- inspect IPFS-published trade-log artifacts that show what the agent says it did, what the node attested to, and what settlement is now owed
- observe that the agent only proposes reimbursement after depositing the corresponding proceeds into the Safe
- observe that the agent disputes user withdrawals that would break outstanding reimbursement coverage

This plan intentionally treats the result as an example module, not a general-purpose production trading product. The goal is to prove the external-settlement pattern cleanly inside this repo.

## Progress

- [x] 2026-04-09 17:09Z: Re-read `AGENTS.md`, `agent-library/AGENTS.md`, `agent/AGENTS.md`, and `PLANS.md`.
- [x] 2026-04-09 17:09Z: Reviewed `skills/add-agent-commitment/SKILL.md` and `agent-library/RULE_TEMPLATES.md` to ground the commitment and locality rules.
- [x] 2026-04-09 17:10Z: Audited existing Polymarket-related modules, especially `agent-library/agents/copy-trading/` and `agent-library/agents/polymarket-intent-trader/`, plus shared Oya node surfaces under `agent/src/lib/`.
- [x] 2026-04-09 17:11Z: Confirmed from current Polymarket docs that positions can be sold before resolution, but redemption into USDC only happens after resolution; "market close" and "market resolution" are not the same event.
- [x] 2026-04-09 17:12Z: Wrote this initial ExecPlan in `plans/polymarket-deferred-settlement-agent.md`.
- [ ] Prototype the node-side trade-verification path against Polymarket APIs and decide whether the node is a verifier or only a notary in v1.
- [ ] Implement the Oya trade-log publication surface and its durable store.
- [ ] Create the new deferred-settlement Polymarket agent module and its commitment text.
- [ ] Add tests, smoke harness coverage, and documentation updates.

## Surprises & Discoveries

- Observation: The repo already has the two halves this design needs, but not yet the combined flow.
  Evidence: `agent-library/agents/copy-trading/agent.js` already does external Polymarket execution with agent funds, while `agent-library/agents/polymarket-intent-trader/agent.js` already does durable IPFS archival and actual-spend reimbursement accounting.

- Observation: The Oya node is currently split into a signed message inbox hosted by the main agent process and a separate standalone proposal-publication node.
  Evidence: `agent/src/lib/message-api.js` is started from `agent/src/lib/runtime-loop.js`, while proposal publication runs from `agent/scripts/start-proposal-publish-node.mjs` and `agent/src/lib/proposal-publication-api.js`.

- Observation: The existing `Staked External Polymarket Execution` rule template is directionally right but incomplete for repeated flips and net settlement.
  Evidence: `agent-library/RULE_TEMPLATES.md` defines stake, logging, and post-resolution settlement, but it does not define netted reimbursement across multiple buys and sells, dynamic stake sizing, or how user withdrawals are limited while offchain liabilities are open.

- Observation: Public IPFS publication of live trade details is itself a product tradeoff.
  Evidence: The user asked for trade details to be published on IPFS. That gives auditability, but it also leaks the agent's current position and timing while the market is still live.

- Observation: "Wait until markets close" is not precise enough for a settlement rule.
  Evidence: Current Polymarket docs distinguish market close from resolution, and redemption is only available after resolution. An agent can also exit earlier by selling before resolution. The commitment must key settlement deadlines to resolution or earlier flat exit, not to close time alone.

## Decision Log

- Decision: Scope v1 to one commitment, one primary user, and one configured Polymarket market stream per module instance.
  Rationale: Multi-user or multi-market netting makes the liability and withdrawal-reserve logic much harder. The repo's example agents are deliberately narrow, and the new node/ledger pattern is the real feature under test.
  Date/Author: 2026-04-09 / Codex.

- Decision: Build the new example by borrowing trading mechanics from `copy-trading` and accounting/archival patterns from `polymarket-intent-trader`, rather than starting from the generic `default` agent alone.
  Rationale: This reduces risk and keeps the new module local while reusing already-proven Polymarket execution and reimbursement logic.
  Date/Author: 2026-04-09 / Codex.

- Decision: Add a new standalone Oya trade-log publication surface instead of overloading the existing message API or proposal-publication API.
  Rationale: Trade-log publication has different request shape, persistence, and duplicate semantics. A sibling service keeps the current node behavior stable and avoids turning one endpoint into a multi-purpose protocol parser.
  Date/Author: 2026-04-09 / Codex.

- Decision: Use cumulative, hash-chained trade-log snapshots keyed by `(agent signer, chainId, commitmentSafe, user, marketId)` instead of fire-and-forget per-trade messages.
  Rationale: The existing rule template already describes "an updated log documenting all trades." A cumulative stream with `sequence` and `previousCid` is easier to replay, verify, dedupe, and reason about during slashing or settlement.
  Date/Author: 2026-04-09 / Codex.

- Decision: Settle on market resolution or earlier full exit, not strictly "after market close."
  Rationale: This matches Polymarket mechanics and the existing rule template better than a vague close-based deadline, while still avoiding proposals on every trade or flip.
  Date/Author: 2026-04-09 / Codex.

- Decision: Treat fixed stake alone as insufficient. The v1 agent must compute a required stake from outstanding upside exposure and refuse trades when the active stake is too small.
  Rationale: A binary market can produce gains larger than principal. The user's own example (`100 -> 250`) already shows that a flat "stake equals principal" assumption is unsafe.
  Date/Author: 2026-04-09 / Codex.

- Decision: Keep v1 IPFS trade logs public and plaintext, but document the strategy-leakage tradeoff explicitly.
  Rationale: This keeps the example auditable and simple. If the example graduates toward production use, the next version should replace this with delayed reveal or hash commitments.
  Date/Author: 2026-04-09 / Codex.

## Outcomes & Retrospective

Initial outcome: the repo already contains most of the reusable building blocks, but the user's proposed flow only works cleanly if the implementation adds three things that do not exist yet:

1. A netted external-trade liability ledger rather than one-off "buy then reimburse" accounting.
2. A dedicated Oya node publication surface for signed trade logs, not just signed proposals.
3. A clearer commitment rule set covering dynamic stake coverage and withdrawal limits during unsettled offchain exposure.

No implementation has started yet. This section must be updated after each milestone with the actual files changed, validation evidence, and any scope corrections.

## Context and Orientation

The relevant current code paths are:

- `agent-library/agents/copy-trading/`
  - external Polymarket execution from the agent's wallet
  - source-trade observation and order placement
  - current settlement model is immediate ERC1155 token deposit plus reimbursement proposal

- `agent-library/agents/polymarket-intent-trader/`
  - IPFS archival of signed trade intents
  - durable local state, reimbursement accounting, and restart recovery
  - useful local helpers to borrow conceptually for ledgering and proposal matching

- `agent/src/lib/message-api.js` and `agent/src/lib/runtime-loop.js`
  - signed message ingestion for the main agent process

- `agent/src/lib/proposal-publication-api.js`
  - standalone node pattern for signed request verification, IPFS publication, and durable dedupe

- `agent/src/lib/proposal-publication-store.js`
  - crash-safe durable JSON store pattern that can be mirrored for trade logs

- `agent/src/lib/polymarket.js` and `agent/src/lib/polymarket-relayer.js`
  - shared Polymarket execution helpers
  - currently focused on CLOB orders, trades, and relayer wallet resolution, not on market-resolution or trade-log verification flows

The commitment side remains rule-driven rather than contract-driven. This means no new Solidity code should be assumed unless implementation proves a contract gap. The expected enforcement model is:

- the agent deposits stake into the commitment
- the agent publishes signed trade-log snapshots to the Oya node
- the agent deposits net proceeds into the Safe before claiming reimbursement
- the agent disputes user withdrawals that violate outstanding reimbursement coverage
- the user or another watcher can slash the agent's stake if the published log and market outcome show non-settlement

This plan assumes v1 remains an offchain-enforced commitment served by the current Oya runner and Optimistic Governor patterns.

## Plan of Work

Milestone 0 freezes the accounting model before code spreads. The first task is to define the ledger fields the module and node both agree on. The core values are:

- `grossBuyCostWei`: total USDC the agent spent opening or adding to positions
- `grossSellProceedsWei`: total USDC the agent received from offchain sales before resolution
- `grossRedeemProceedsWei`: total USDC the agent received from onchain redemption after resolution
- `feesWei`: total trading or redemption fees charged to the agent wallet
- `netAgentAdvanceWei`: the still-unreimbursed external capital fronted by the agent after netting realized proceeds
- `maxPotentialPayoutWei`: the maximum total payout still owed to the user from open positions if they all resolve favorably
- `requiredStakeWei`: the minimum active stake needed so the agent cannot rationally default on upside owed to the user
- `freeWithdrawalHeadroomWei`: Safe USDC not reserved for open reimbursement claims

The reimbursement formula must be netted, not summed per buy. If the agent buys for 100, sells for 120, and later buys again for 110, the second buy should consume prior proceeds before creating a fresh reimbursement claim. Otherwise the agent can over-claim principal for the same economic stream.

Milestone 1 adds a trade-log publication protocol to the Oya node. This should parallel the proposal-publication node but not replace it. Add a new config block such as `tradeLogPublishApi`, a canonical signed payload builder, a durable store, and a standalone startup helper. The node endpoint should accept a cumulative trade-log snapshot, authenticate the agent signature, optionally verify referenced Polymarket trades, attach a node signature, publish the final artifact to IPFS, pin it, and store duplicate-safe state keyed by the stream identity plus sequence.

Milestone 2 creates the new agent module under `agent-library/agents/polymarket-staked-external-settlement/`. The module should own all agent-specific behavior. It should:

- observe one configured trigger source for v1 trading decisions
- execute external Polymarket trades from the agent wallet
- update and persist a market-stream ledger locally
- publish a signed ledger snapshot to the Oya node after every material state change
- watch market status until the stream is flat or resolved
- deposit gross proceeds to the Safe before requesting reimbursement
- refuse new trades when required stake, Safe reserve coverage, or policy constraints are violated

Milestone 3 completes the commitment semantics. Draft `commitment.txt` from `Solo User`, `Proposal Delegation`, `Fair Valuation`, `Trade Restrictions`, `Transfer Address Restrictions`, and `Staked External Polymarket Execution`, then add missing reusable rule language for:

- netted reimbursement instead of per-trade reimbursement
- withdrawal restrictions while unsettled external liabilities exist
- dynamic required stake based on published exposure

If those additions are generic enough, add them to `agent-library/RULE_TEMPLATES.md` instead of burying them only in the new module.

Milestone 4 adds proof-quality validation. The module and node need tests for restart recovery, duplicate publication, broken sequence chains, invalid prior-CID links, missing settlement, and incorrect reimbursement attempts. A local smoke flow should run with mocked Polymarket responses and mock IPFS, because a safe non-production path is required and live Polygon/Polymarket credentials are not guaranteed in every environment.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Add the new shared node protocol and config surfaces.

   Files:

   - `agent/src/lib/config.js`
   - `agent/src/lib/agent-config.js`
   - `agent/src/lib/signed-trade-log.js` (new)
   - `agent/src/lib/trade-log-publication-store.js` (new)
   - `agent/src/lib/trade-log-publication-api.js` (new)
   - `agent/scripts/lib/trade-log-publish-runtime.mjs` (new)
   - `agent/scripts/start-trade-log-publish-node.mjs` (new)
   - `agent/scripts/test-trade-log-publication-api.mjs` (new)
   - `agent/scripts/test-trade-log-publication-store.mjs` (new)

   Commands:

   - `node agent/scripts/start-trade-log-publish-node.mjs --module=polymarket-staked-external-settlement --dry-run`
   - `node agent/scripts/test-trade-log-publication-store.mjs`
   - `node agent/scripts/test-trade-log-publication-api.mjs`

   Expected behavior:

   - dry-run prints resolved host, port, chain, state file, and node name
   - exact duplicate publication retries return the existing CID and node signature
   - conflicting sequence or `previousCid` mismatches fail closed

2. Extend shared Polymarket helpers only where the functionality is clearly cross-agent.

   Files:

   - `agent/src/lib/polymarket.js`
   - optional new helper such as `agent/src/lib/polymarket-market-state.js`

   Work:

   - add minimal market-status / resolution fetch helpers
   - add whichever public or authenticated trade-verification helper Milestone 0 proves usable
   - keep strategy logic out of shared files

   Commands:

   - `node agent/scripts/test-polymarket-request-retries.mjs`
   - add and run a new focused script if resolution helpers are introduced

3. Create the new module and its local ledger.

   Files:

   - `agent-library/agents/polymarket-staked-external-settlement/agent.js`
   - `agent-library/agents/polymarket-staked-external-settlement/commitment.txt`
   - `agent-library/agents/polymarket-staked-external-settlement/agent.json`
   - `agent-library/agents/polymarket-staked-external-settlement/config.json`
   - `agent-library/agents/polymarket-staked-external-settlement/state-store.js` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/trade-ledger.js` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/settlement-reconciliation.js` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/harness.mjs` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs` (new)

   Commands:

   - `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs`
   - `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`

   Expected behavior:

   - the module refuses to trade when stake or Safe reserve coverage is insufficient
   - every accepted trade state change yields one signed publication request
   - reimbursement proposals are only built after the corresponding proceeds deposit is recorded

4. Add reusable rule text and docs.

   Files:

   - `agent-library/RULE_TEMPLATES.md`
   - `agent-library/README.md`
   - `agent/README.md`

   Commands:

   - `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`

   Expected behavior:

   - the new commitment text is assembled mostly from templates
   - docs explain that this example is public-log and single-market by design

5. Add smoke coverage with a safe mock environment.

   Commands:

   - `node agent/scripts/testnet-harness.mjs smoke --module=polymarket-staked-external-settlement --profile=local-mock`
   - `node agent/scripts/testnet-harness.mjs down --module=polymarket-staked-external-settlement --profile=local-mock`

   Expected behavior:

   - local harness starts the agent plus any required mock node services
   - the scenario publishes at least one trade-log artifact
   - the scenario reaches either a mock final exit or mock market resolution and performs the expected deposit-plus-reimbursement sequence

## Validation and Acceptance

Required validation commands:

- `node agent/scripts/test-trade-log-publication-store.mjs`
- `node agent/scripts/test-trade-log-publication-api.mjs`
- `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs`
- `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`
- `node agent/scripts/testnet-harness.mjs smoke --module=polymarket-staked-external-settlement --profile=local-mock`

Acceptance requires all of the following:

- the new module stays local to `agent-library/agents/polymarket-staked-external-settlement/`, except for clearly shared node or Polymarket infrastructure
- the Oya node can archive, pin, and dedupe signed trade-log snapshots
- the trade ledger nets realized proceeds against later buys before computing reimbursement
- the module enforces stake and Safe reserve checks before trading or approving reimbursement
- the module deposits gross proceeds before proposing reimbursement
- the commitment text and docs describe the exact trust model, especially the public-log tradeoff and the difference between market close and resolution

If Milestone 0 shows that node-side verification cannot independently confirm trades with acceptable confidence, the v1 result must explicitly document that the node is a notary-only surface and must not claim stronger user protection than that.

## Idempotence and Recovery

The new node store and the module state store must both be crash-safe and retry-safe. Retries must never create duplicate liability records or duplicate reimbursement rights.

Specific recovery rules:

- exact re-publication of the same signed snapshot should return the stored publication record
- sequence gaps or mismatched `previousCid` values should stop the stream and require manual reconciliation
- if the node publishes to IPFS but fails before durable store write, it must preserve enough volatile or staged state to reuse the first CID on retry
- if the agent loses local state, it should be able to reconstruct the latest market stream from its persisted snapshots and observed onchain deposits/proposals before resuming settlement work
- no automatic retry should create a second reimbursement proposal for the same settled stream

If interrupted, resume by reading this file first, then inspect:

- `git diff -- plans/polymarket-deferred-settlement-agent.md`
- the new node files under `agent/src/lib/` and `agent/scripts/`
- the new module files under `agent-library/agents/polymarket-staked-external-settlement/`

Then re-run the validation commands above before continuing.

## Artifacts and Notes

Useful current references inside the repo:

- `agent-library/agents/copy-trading/agent.js`
- `agent-library/agents/polymarket-intent-trader/agent.js`
- `agent/src/lib/proposal-publication-api.js`
- `agent/src/lib/proposal-publication-store.js`
- `agent/scripts/start-proposal-publish-node.mjs`
- `plans/polymarket-agent-hardening.md`
- `plans/oya-node-publish-and-propose.md`

External behavior summarized from current official Polymarket docs and embedded here so the plan is self-contained:

- positions can be sold before resolution, so a market stream can settle before oracle resolution if the agent is flat
- redemption into USDC only becomes available after resolution
- market close and resolution are separate lifecycle stages
- public APIs exist for market metadata and some trade or position data, but Milestone 0 must still confirm whether they are sufficient for node-side verification in this repo's exact flow

Primary source links used for the above summary:

- https://docs.polymarket.com/concepts/resolution
- https://docs.polymarket.com/trading/ctf/redeem
- https://docs.polymarket.com/trading/ctf/overview
- https://docs.polymarket.com/developers/market-makers/data-feeds
- https://docs.polymarket.com/developers/market-makers/inventory
- https://docs.polymarket.com/market-data/websocket/overview

## Interfaces and Dependencies

New node-side interface to add:

- `POST /v1/trade-logs/publish`

Proposed signed request body shape:

- `chainId`
- `requestId`
- `commitmentSafe`
- `user`
- `marketId`
- `sequence`
- `previousCid`
- `snapshot`
- `auth`

Proposed snapshot contents:

- stream identity (`commitmentSafe`, `user`, `marketId`, `tradingWallet`)
- cumulative trade entries with timestamps and external identifiers
- derived ledger fields (`netAgentAdvanceWei`, `maxPotentialPayoutWei`, `requiredStakeWei`)
- current position summary
- settlement status summary

New config dependency to add in module config:

- `tradeLogPublishApi.enabled`
- `tradeLogPublishApi.host`
- `tradeLogPublishApi.port`
- `tradeLogPublishApi.requireSignerAllowlist`
- `tradeLogPublishApi.signerAllowlist`
- `tradeLogPublishApi.signatureMaxAgeSeconds`
- `tradeLogPublishApi.stateFile`
- `tradeLogPublishApi.nodeName`

Existing secrets and runtime dependencies:

- Polygon-compatible `rpcUrl`
- Polymarket CLOB credentials for the trading wallet
- IPFS API access for the node
- node signer credentials

Known design gaps that this plan must close before calling the agent sound:

- reimbursement must be netted across flips, not summed per buy
- required stake must cover upside exposure, not just principal
- user withdrawals must be checked against open offchain liabilities
- "market close" must be replaced with explicit resolution or flat-exit semantics
- public IPFS trade logs are acceptable for an example, but not automatically acceptable for a profit-sensitive production strategy
