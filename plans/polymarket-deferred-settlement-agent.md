# Deferred Settlement Polymarket Agent And Oya Trade Log Node

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build a new example agent that trades on Polymarket with the agent's own wallet and funds, keeps the user's capital parked in the commitment Safe, and settles only when the market stream is over. In this design, the agent can change positions quickly offchain and off-Safe, but every material trade state change is recorded in a signed trade log that an Oya node archives to IPFS and co-signs. When the position is finally closed or the market resolves, the agent deposits whatever settlement amount is owed to the user under the logged trade history and then claims reimbursement for the initially fronted principal defined by the commitment rules.

After this work, a reviewer or operator should be able to:

- run a standalone Oya trade-log publication node for a selected agent module
- run a new agent module under `agent-library/agents/` that executes external Polymarket trades and maintains a durable liability ledger
- inspect IPFS-published trade-log artifacts that show what the agent says it did, what the node attested to, and what settlement is now owed
- observe that the agent only proposes reimbursement after depositing the required final settlement amount into the Safe
- observe that the agent disputes user withdrawals that violate the commitment's withdrawal rule while the trade stream is still unsettled

This plan intentionally treats the result as an example module, not a general-purpose production trading product. The goal is to prove the external-settlement pattern cleanly inside this repo.

## Progress

- [x] 2026-04-09 17:09Z: Re-read `AGENTS.md`, `agent-library/AGENTS.md`, `agent/AGENTS.md`, and `PLANS.md`.
- [x] 2026-04-09 17:09Z: Reviewed `skills/add-agent-commitment/SKILL.md` and `agent-library/RULE_TEMPLATES.md` to ground the commitment and locality rules.
- [x] 2026-04-09 17:10Z: Audited existing Polymarket-related modules, especially `agent-library/agents/copy-trading/` and `agent-library/agents/polymarket-intent-trader/`, plus shared Oya node surfaces under `agent/src/lib/`.
- [x] 2026-04-09 17:11Z: Confirmed from current Polymarket docs that positions can be sold before resolution, but redemption into USDC only happens after resolution; "market close" and "market resolution" are not the same event.
- [x] 2026-04-09 17:12Z: Wrote this initial ExecPlan in `plans/polymarket-deferred-settlement-agent.md`.
- [x] 2026-04-09 17:22Z: Revised the plan after user clarification: the node is notary-only in v1, reimbursement is for the initially fronted principal, later trading affects only the final settlement deposit, and fixed stake is acceptable.
- [x] 2026-04-09 17:30Z: Revised the plan after user clarification that each trade is either a reimbursable new trade or a continuation trade that does not create new reimbursement principal.
- [ ] Implement the Oya trade-log publication surface and its durable store.
- [ ] Create the new deferred-settlement Polymarket agent module and its commitment text.
- [ ] Add tests, smoke harness coverage, and documentation updates.

## Surprises & Discoveries

- Observation: The repo already has the two halves this design needs, but not yet the combined flow.
  Evidence: `agent-library/agents/copy-trading/agent.js` already does external Polymarket execution with agent funds, while `agent-library/agents/polymarket-intent-trader/agent.js` already does durable IPFS archival and actual-spend reimbursement accounting.

- Observation: The Oya node is currently split into a signed message inbox hosted by the main agent process and a separate standalone proposal-publication node.
  Evidence: `agent/src/lib/message-api.js` is started from `agent/src/lib/runtime-loop.js`, while proposal publication runs from `agent/scripts/start-proposal-publish-node.mjs` and `agent/src/lib/proposal-publication-api.js`.

- Observation: The existing `Staked External Polymarket Execution` rule template is directionally right but incomplete for the clarified accounting model.
  Evidence: `agent-library/RULE_TEMPLATES.md` defines stake, logging, and post-resolution settlement, but it does not yet spell out "initial principal reimbursement plus final settlement deposit" or misreporting-specific slash conditions.

- Observation: In this design, the Oya node is an authenticated notary, not an independent trade verifier.
  Evidence: The user clarified that inaccurate logs should be handled by proposal rejection and slashing, not by the node proving trade truth before publication.

- Observation: "Wait until markets close" is not precise enough for a settlement rule.
  Evidence: Current Polymarket docs distinguish market close from resolution, and redemption is only available after resolution. An agent can also exit earlier by selling before resolution. The commitment must key settlement deadlines to resolution or earlier flat exit, not to close time alone.

- Observation: The user accepts public IPFS publication of executed trades because the underlying Polymarket trades are already public.
  Evidence: The user explicitly stated that the logs do not leak anything beyond already-public executed trades.

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

- Decision: In v1, the node is explicitly notary-only and does not need to verify trade truth before publication.
  Rationale: The user wants false logs handled at settlement time by rejecting reimbursement and slashing stake, not by moving verification into the node.
  Date/Author: 2026-04-09 / Codex.

- Decision: Reimbursement accounting in v1 is "initial principal reimbursement plus separate final settlement deposit," not netted reimbursement across flips.
  Rationale: The user clarified that later trading affects how much the agent must deposit into the commitment at settlement, but reimbursement is for the amount initially spent to open the user's market exposure.
  Date/Author: 2026-04-09 / Codex.

- Decision: Every trade must be logged as either `initiated` or `continuation`.
  Rationale: The user clarified that initiated trades create reimbursable principal, while continuation trades keep the overall profit-and-loss stream going without creating new reimbursement principal.
  Date/Author: 2026-04-09 / Codex.

- Decision: A fixed stake is acceptable in v1; do not add dynamic stake sizing.
  Rationale: The user explicitly accepts fixed slashing risk plus reputation damage as sufficient deterrence for this example.
  Date/Author: 2026-04-09 / Codex.

- Decision: Keep v1 IPFS trade logs public and plaintext without treating that as a blocker.
  Rationale: The user explicitly accepts this because the underlying executed Polymarket trades are already public.
  Date/Author: 2026-04-09 / Codex.

- Decision: Do not update `agent-library/RULE_TEMPLATES.md` without explicit user approval.
  Rationale: The user asked to keep any rule-template changes very minimal and to check first before making them.
  Date/Author: 2026-04-09 / Codex.

## Outcomes & Retrospective

Initial outcome: the repo already contains most of the reusable building blocks, but the user's proposed flow only works cleanly if the implementation adds three things that do not exist yet:

1. A ledger that separately tracks reimbursable initiated-trade principal and final settlement owed to the user.
2. A dedicated Oya node publication surface for signed trade logs, not just signed proposals.
3. A clearer commitment rule set covering misreporting slashing and withdrawal limits during unsettled offchain exposure.

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
  - standalone node pattern for signed request authentication, IPFS publication, and durable dedupe

- `agent/src/lib/proposal-publication-store.js`
  - crash-safe durable JSON store pattern that can be mirrored for trade logs

- `agent/src/lib/polymarket.js` and `agent/src/lib/polymarket-relayer.js`
  - shared Polymarket execution helpers
  - currently focused on CLOB orders, trades, and relayer wallet resolution, not on market-resolution or trade-log publication flows

The commitment side remains rule-driven rather than contract-driven. This means no new Solidity code should be assumed unless implementation proves a contract gap. The expected enforcement model is:

- the agent deposits stake into the commitment
- the agent publishes signed trade-log snapshots to the Oya node
- the agent deposits the final settlement amount owed to the user into the Safe before claiming reimbursement
- the agent disputes user withdrawals that violate the commitment's withdrawal rule while settlement is still outstanding
- the user or another watcher can slash the agent's stake if the published log and market outcome show non-settlement

This plan assumes v1 remains an offchain-enforced commitment served by the current Oya runner and Optimistic Governor patterns.

## Plan of Work

Milestone 0 freezes the accounting model before code spreads. The first task is to define the ledger fields the module and node both agree on. The core values are:

- `tradeEntryKind`: `initiated` or `continuation`
- `tradeGroupId`: stable identifier tying continuation trades back to the reimbursable trade path they continue
- `initiatedPrincipalContributionWei`: reimbursable principal contributed by a single initiated trade; always zero for continuation trades
- `initiatedPrincipalWei`: cumulative reimbursable principal across all initiated trades in the market stream
- `grossBuyCostWei`: total USDC the agent spent opening or adding to positions
- `grossSellProceedsWei`: total USDC the agent received from offchain sales before resolution
- `grossRedeemProceedsWei`: total USDC the agent received from onchain redemption after resolution
- `feesWei`: total trading or redemption fees charged to the agent wallet
- `finalSettlementValueWei`: the amount the agent must deposit into the Safe at flat exit or resolution based on the cumulative logged trading result
- `reimbursementEligibleWei`: the amount the agent may claim back after making that final settlement deposit; for v1 this is the sum of reimbursable initiated-trade principal
- `fixedStakeWei`: the active slashable stake deposited under the commitment rules
- `withdrawalLimitState`: the values needed to decide whether a user withdrawal violates the commitment during an unsettled stream

The critical accounting separation is: all trades affect `finalSettlementValueWei`, but only trades marked `initiated` affect `reimbursementEligibleWei`. If a later trade uses fresh agent capital and should be reimbursable, it must be logged as a new initiated trade. If it continues an earlier trade path after that path was closed out with a sale, it must be logged as a continuation trade with zero new reimbursement principal.

Milestone 1 adds a trade-log publication protocol to the Oya node. This should parallel the proposal-publication node but not replace it. Add a new config block such as `tradeLogPublishApi`, a canonical signed payload builder, a durable store, and a standalone startup helper. The node endpoint should accept a cumulative trade-log snapshot, authenticate the agent signature, attach a node signature, publish the final artifact to IPFS, pin it, and store duplicate-safe state keyed by the stream identity plus sequence. In v1 the node is a notary and archivist, not an independent trade verifier.

Milestone 2 creates the new agent module under `agent-library/agents/polymarket-staked-external-settlement/`. The module should own all agent-specific behavior. It should:

- observe one configured trigger source for v1 trading decisions
- execute external Polymarket trades from the agent wallet
- update and persist a market-stream ledger locally
- publish a signed ledger snapshot to the Oya node after every material state change
- watch market status until the stream is flat or resolved
- deposit the final settlement amount owed to the user before requesting reimbursement
- refuse new trades when the fixed stake is not active or policy constraints are violated
- classify each logged trade deterministically as `initiated` or `continuation` before it affects reimbursement accounting

Milestone 3 completes the commitment semantics. Draft `commitment.txt` from `Solo User`, `Proposal Delegation`, `Fair Valuation`, `Trade Restrictions`, `Transfer Address Restrictions`, and `Staked External Polymarket Execution`, then add commitment-local language for:

- initiated-trade reimbursement plus final-settlement deposit semantics
- withdrawal restrictions while unsettled external liabilities exist
- slashability for false trade logging or misreporting through the node

Do not change `agent-library/RULE_TEMPLATES.md` during implementation unless the user explicitly approves a minimal shared-template update first.

Milestone 4 adds proof-quality validation. The module and node need tests for restart recovery, duplicate publication, broken sequence chains, invalid prior-CID links, missing settlement, false-log handling, and incorrect reimbursement attempts. A local smoke flow should run with mocked Polymarket responses and mock IPFS, because a safe non-production path is required and live Polygon/Polymarket credentials are not guaranteed in every environment.

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

   - the module refuses to trade when fixed stake is inactive or policy gating fails
   - every accepted trade state change yields one signed publication request
   - every logged trade is classified as `initiated` or `continuation`
   - reimbursement proposals are only built after the required final settlement deposit is recorded

4. Add reusable rule text and docs.

   Files:

   - `agent-library/RULE_TEMPLATES.md`
   - `agent-library/README.md`
   - `agent/README.md`

   Commands:

   - `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`

   Expected behavior:

   - the new commitment text is assembled mostly from templates
   - any shared rule-template change remains pending explicit user approval
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
- the trade ledger preserves the separation between reimbursable initiated-trade principal and final settlement owed to the user
- continuation trades do not add reimbursement principal, but they do affect final settlement accounting
- the module enforces active fixed-stake and withdrawal-policy assumptions before approving reimbursement
- the module deposits the final settlement amount before proposing reimbursement
- the commitment text and docs describe the exact trust model, especially the public-log assumption and the difference between market close and resolution
- the docs explicitly state that the node is a notary/archive surface, not a trade verifier

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
- the node in this plan is intentionally not a trade verifier, so public market APIs are relevant mainly for market-status and resolution tracking, not for pre-publication attestation

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
- cumulative trade entries with timestamps, external identifiers, and `tradeEntryKind`
- derived ledger fields (`initiatedPrincipalWei`, `finalSettlementValueWei`, `reimbursementEligibleWei`, `fixedStakeWei`)
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

- reimbursable initiated-trade principal and final settlement value must stay distinct throughout the ledger and proposal flow
- the implementation must encode the user-provided `initiated` versus `continuation` classification as deterministic state, not ad hoc operator judgment
- the withdrawal rule still needs exact commitment wording and corresponding dispute logic during unsettled streams
- the rule must say that false or misleading trade logs published through the node are slashable
- "market close" must be replaced with explicit resolution or flat-exit semantics
- any shared rule-template edit must be minimal and user-approved before implementation
