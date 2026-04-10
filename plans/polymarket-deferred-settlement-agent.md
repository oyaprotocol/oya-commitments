# Deferred Settlement Polymarket Agent And Oya Trade Log Node

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build a new example agent that trades on Polymarket with the agent's own wallet and funds, keeps the user's capital parked in the commitment Safe, and settles each market stream only when that market stream is over. In this design, the agent can change positions quickly outside of the Safe, but every material trade state change is recorded in a signed trade log that an Oya node archives to IPFS and co-signs. When a market resolves, the agent deposits whatever settlement amount is owed to the user under the logged trade history for that market and then claims reimbursement for the initially fronted principal defined by the commitment rules.

After this work, a reviewer or operator should be able to:

- run a standalone Oya signed-message publication node for a selected agent module
- run a new agent module under `agent-library/agents/` that executes external Polymarket trades and maintains durable per-market liability ledgers
- inspect IPFS-published message artifacts, including Polymarket trade-log messages that show what the agent says it did, what the node attested to, and what settlement is now owed
- observe that the agent only proposes reimbursement after depositing the required final settlement amount into the Safe
- observe that the agent disputes user withdrawals that violate the commitment's withdrawal rule while one or more market streams are still unsettled

This plan intentionally treats the result as an example module, not a general-purpose production trading product. The goal is to prove the external-settlement pattern cleanly inside this repo.

## Progress

- [x] 2026-04-09 17:09Z: Re-read `AGENTS.md`, `agent-library/AGENTS.md`, `agent/AGENTS.md`, and `PLANS.md`.
- [x] 2026-04-09 17:09Z: Reviewed `skills/add-agent-commitment/SKILL.md` and `agent-library/RULE_TEMPLATES.md` to ground the commitment and locality rules.
- [x] 2026-04-09 17:10Z: Audited existing Polymarket-related modules, especially `agent-library/agents/copy-trading/` and `agent-library/agents/polymarket-intent-trader/`, plus shared Oya node surfaces under `agent/src/lib/`.
- [x] 2026-04-09 17:11Z: Confirmed from current Polymarket docs that positions can be sold before resolution, but redemption into USDC only happens after resolution; "market close" and "market resolution" are not the same event.
- [x] 2026-04-09 17:12Z: Wrote this initial ExecPlan in `plans/polymarket-deferred-settlement-agent.md`.
- [x] 2026-04-09 17:22Z: Revised the plan after user clarification: the node is notary-only in v1, reimbursement is for the initially fronted principal, later trading affects only the final settlement deposit, and fixed stake is acceptable.
- [x] 2026-04-09 17:30Z: Revised the plan after user clarification that each trade is either a reimbursable new trade or a continuation trade that does not create new reimbursement principal.
- [x] 2026-04-09 17:30Z: Revised the plan to support any number of Polymarket markets per commitment by modeling the system as many concurrent per-market streams keyed by `marketId`.
- [x] 2026-04-09 23:20Z: Implemented a minimal generalized Oya signed-message publication surface under `agent/`: `messagePublishApi` config/runtime plumbing, canonical signed-message builder, durable store, generic `/v1/messages/publish` API, standalone startup script, and focused store/API tests. The minimal patch verifies the agent signature against the message, publishes and pins the artifact to IPFS, and dedupes by signer plus `(chainId, requestId)` from the signed message body.
- [x] 2026-04-09 23:26Z: Added explicit node-side co-signing to the generalized message publication artifact. The node now signs a canonical attestation over publication metadata plus the archived signed message, embeds that attestation in the artifact, and verifies it in the focused API test.
- [x] 2026-04-09 23:56Z: Fixed two review-discovered Milestone 1 bugs: runtime helpers now preserve `buildConfig()` symbol metadata when overriding `chainId`, so env-only message-publish/proposal-publish keys and IPFS headers still resolve, and message publication retries no longer risk overwriting durable CID/artifact state after partial publish progress.
- [x] 2026-04-10 00:29Z: Fixed additional Milestone 1 hardening issues: `message-publication-api.start()` now rejects cleanly on bind/listen errors, and the signed-message artifact builders now require `signedAtMs === envelope.timestampMs` for both the archived agent signature and the node attestation.
- [x] 2026-04-10 00:58Z: Fixed two more Milestone 1 review issues in the shared message publisher: signed-auth chain enforcement now accepts numeric-string `message.chainId` values by normalizing them before comparing to the configured chain, and IPFS uploads now keep a retry-safe in-memory CID snapshot so a transient post-publish store failure does not trigger duplicate uploads on the next identical request.
- [x] 2026-04-10 01:16Z: Added operator-facing documentation for the signed message publication flow in `agent/README.md`, including config fields, request and artifact shapes, startup instructions, and retry semantics, with supporting doc signposts in the repo root and `agent-library/README.md`.
- [ ] Create the new deferred-settlement Polymarket agent module and its commitment text.
- [ ] Add tests, smoke harness coverage, and documentation updates.

## Surprises & Discoveries

- Observation: The repo already has the two halves this design needs, but not yet the combined flow.
  Evidence: `agent-library/agents/copy-trading/agent.js` already does external Polymarket execution with agent funds, while `agent-library/agents/polymarket-intent-trader/agent.js` already does durable IPFS archival and actual-spend reimbursement accounting.

- Observation: The node-side publish surface should be generalized beyond Polymarket-specific trade logs.
  Evidence: The user wants the endpoint to accept arbitrary signed agent messages, with any domain-specific interpretation details embedded inside the message itself.

- Observation: The existing `Staked External Polymarket Execution` rule template is directionally right but incomplete for the clarified accounting model.
  Evidence: `agent-library/RULE_TEMPLATES.md` defines stake, logging, and post-resolution settlement, but it does not yet spell out "initial principal reimbursement plus final settlement deposit" or misreporting-specific slash conditions.

- Observation: In this design, the Oya node is an authenticated notary, not an independent trade verifier.
  Evidence: The user clarified that inaccurate logs should be handled by proposal rejection and slashing, not by the node proving trade truth before publication.

- Observation: "Wait until markets close" is not precise enough for a settlement rule.
  Evidence: Current Polymarket docs distinguish market close from resolution, and redemption is only available after resolution. An agent can also exit earlier by selling before resolution. The commitment must key settlement deadlines to resolution or earlier flat exit, not to close time alone.

- Observation: The user accepts public IPFS publication of executed trades because the underlying Polymarket trades are already public.
  Evidence: The user explicitly stated that the logs do not leak anything beyond already-public executed trades.

## Decision Log

- Decision: Scope v1 to one commitment and one primary user, but support any number of concurrent Polymarket market streams per module instance.
  Rationale: Multi-user accounting is still a major expansion, but multi-market support can be handled as independent per-market ledgers keyed by `marketId` under the same commitment and user.
  Date/Author: 2026-04-09 / Codex.

- Decision: Build the new example by borrowing trading mechanics from `copy-trading` and accounting/archival patterns from `polymarket-intent-trader`, rather than starting from the generic `default` agent alone.
  Rationale: This reduces risk and keeps the new module local while reusing already-proven Polymarket execution and reimbursement logic.
  Date/Author: 2026-04-09 / Codex.

- Decision: Add a new standalone Oya signed-message publication surface instead of overloading the existing message API or proposal-publication API.
  Rationale: Publication has different persistence and duplicate semantics from the runtime inbox, but the endpoint itself should stay domain-agnostic so Polymarket-specific details live inside the signed message rather than the API schema.
  Date/Author: 2026-04-09 / Codex.

- Decision: The Polymarket example will use cumulative, hash-chained trade-log messages keyed by `(agent signer, chainId, commitmentSafe, user, marketId)` instead of fire-and-forget per-trade messages.
  Rationale: The node endpoint is generic, but the existing rule template already describes "an updated log documenting all trades." A cumulative stream with `sequence` and `previousCid` is easier to replay, verify, dedupe, and reason about during slashing or settlement.
  Date/Author: 2026-04-09 / Codex.

- Decision: Multi-market support will be implemented as a collection of independent per-market streams, not one merged portfolio log.
  Rationale: This preserves the existing stream identity keyed by `marketId`, keeps settlement and reimbursement reasoning local to one market at a time, and avoids turning the node protocol into a portfolio reconciliation engine.
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

- Decision: Keep v1 Polymarket trade-log messages public and plaintext without treating that as a blocker.
  Rationale: The user explicitly accepts this because the underlying executed Polymarket trades are already public.
  Date/Author: 2026-04-09 / Codex.

- Decision: Do not update `agent-library/RULE_TEMPLATES.md` without explicit user approval.
  Rationale: The user asked to keep any rule-template changes very minimal and to check first before making them.
  Date/Author: 2026-04-09 / Codex.

## Outcomes & Retrospective

Initial outcome: the repo already contains most of the reusable building blocks, but the user's proposed flow only works cleanly if the implementation adds three things that do not exist yet:

1. A ledger system that separately tracks reimbursable initiated-trade principal and final settlement owed to the user for each active market.
2. A dedicated Oya node publication surface for arbitrary signed agent messages, which the Polymarket example will use for trade-log messages.
3. A clearer commitment rule set covering misreporting slashing and withdrawal limits while any supported market remains unsettled.

Milestone 1 status after the first implementation pass:

- Completed: generic signed-message publication plumbing landed in `agent/src/lib/config.js`, `agent/src/lib/agent-config.js`, `agent/src/lib/signed-published-message.js`, `agent/src/lib/message-publication-store.js`, `agent/src/lib/message-publication-api.js`, `agent/scripts/lib/message-publish-runtime.mjs`, and `agent/scripts/start-message-publish-node.mjs`.
- Completed: focused validation landed in `agent/scripts/test-message-publication-store.mjs`, `agent/scripts/test-message-publication-api.mjs`, and an extension to `agent/scripts/test-agent-config-file.mjs`.
- Validated: `node agent/scripts/test-message-publication-store.mjs`, `node agent/scripts/test-message-publication-api.mjs`, and `node agent/scripts/test-agent-config-file.mjs`.
- Completed follow-up: the artifact now also includes an explicit node `eip191` attestation over publication metadata plus the archived signed message, and the publish-node startup path resolves a signer from `MESSAGE_PUBLISH_API_SIGNER_PRIVATE_KEY` or the shared signer configuration.

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
  - crash-safe durable JSON store pattern that can be mirrored for generalized signed-message publication

- `agent/src/lib/polymarket.js` and `agent/src/lib/polymarket-relayer.js`
  - shared Polymarket execution helpers
  - currently focused on CLOB orders, trades, and relayer wallet resolution, not on market-resolution or generalized message-publication flows

The commitment side remains rule-driven rather than contract-driven. This means no new Solidity code should be assumed unless implementation proves a contract gap. The expected enforcement model is:

- the agent deposits stake into the commitment
- the agent publishes signed messages to the Oya node for each active market, with Polymarket-specific trade details embedded in those messages
- the agent deposits the final settlement amount owed to the user for a given market into the Safe before claiming reimbursement for that market
- the agent disputes user withdrawals that violate the commitment's withdrawal rule while any market settlement is still outstanding
- the user or another watcher can slash the agent's stake if the published log and market outcome show non-settlement or misreporting for any market

This plan assumes v1 remains an offchain-enforced commitment served by the current Oya runner and Optimistic Governor patterns.

## Plan of Work

Milestone 0 freezes the accounting model before code spreads. The first task is to define the data model the module and node both agree on. The agent should maintain a portfolio index keyed by `marketId`, where each market owns its own independent stream and settlement state. The core per-market values are:

- `marketId`: Polymarket market identifier for this stream
- `tradeEntryKind`: `initiated` or `continuation`
- `tradeGroupId`: stable identifier tying continuation trades back to the reimbursable trade path they continue
- `initiatedPrincipalContributionWei`: reimbursable principal contributed by a single initiated trade; always zero for continuation trades
- `initiatedPrincipalWei`: cumulative reimbursable principal across all initiated trades in this market stream
- `grossBuyCostWei`: total USDC the agent spent opening or adding to positions
- `grossSellProceedsWei`: total USDC the agent received from offchain sales before resolution
- `grossRedeemProceedsWei`: total USDC the agent received from onchain redemption after resolution
- `feesWei`: total trading or redemption fees charged to the agent wallet
- `finalSettlementValueWei`: the amount the agent must deposit into the Safe at flat exit or resolution based on the cumulative logged trading result
- `reimbursementEligibleWei`: the amount the agent may claim back after making that final settlement deposit; for v1 this is the sum of reimbursable initiated-trade principal
- `fixedStakeWei`: the active slashable stake deposited under the commitment rules
- `withdrawalLimitState`: the values needed to decide whether a user withdrawal violates the commitment during an unsettled stream

The critical accounting separation is: all trades affect `finalSettlementValueWei`, but only trades marked `initiated` affect `reimbursementEligibleWei`. If a later trade uses fresh agent capital and should be reimbursable, it must be logged as a new initiated trade. If it continues an earlier trade path after that path was closed out with a sale, it must be logged as a continuation trade with zero new reimbursement principal.

Milestone 0 must also define the portfolio-level rollups derived from those per-market ledgers, because the withdrawal rule is commitment-wide rather than market-local. At minimum the module needs deterministic sums for:

- `totalUnsettledReimbursementEligibleWei`
- `totalUnsettledSettlementObligationWei`
- `unsettledMarketIds`
- any additional aggregate used to decide whether a user withdrawal proposal must be disputed

Milestone 0 must also define the module config shape for multi-market support. The plan should replace any single-market policy assumptions with a per-market policy map keyed by `marketId` so new markets can be added without changing the core ledger model.

Milestone 1 adds a generalized signed-message publication protocol to the Oya node. This should parallel the proposal-publication node but not replace it. Add a new config block such as `messagePublishApi`, a canonical signed payload builder, a durable store, and a standalone startup helper. The node endpoint should accept an arbitrary signed message, verify the submitted `auth` envelope against that message, publish the final artifact to IPFS, pin it, and store duplicate-safe state keyed by the signed message identity. The signed message itself must carry `chainId`, `requestId`, `commitmentAddresses`, `agentAddress`, and any domain-specific payload. In v1 the node is a notary and archivist, not an independent message verifier. If we still want explicit node-side co-signing after review, that should be added as a follow-up to the minimal publication artifact now in place. The Polymarket example should use this generalized publication surface by embedding the market-specific trade details inside the signed message payload.

Milestone 2 creates the new agent module under `agent-library/agents/polymarket-staked-external-settlement/`. The module should own all agent-specific behavior. It should:

- observe one configured trigger source for v1 trading decisions
- execute external Polymarket trades from the agent wallet across any number of supported markets
- update and persist per-market ledgers plus portfolio-level unsettled-state rollups locally
- publish a signed message to the Oya node after every material state change in the affected market
- watch market status for every active market until that market is flat or resolved
- deposit the final settlement amount owed to the user for a resolved market before requesting reimbursement for that market
- refuse new trades when the fixed stake is not active or policy constraints are violated
- classify each logged trade deterministically as `initiated` or `continuation` before it affects reimbursement accounting in that market

Milestone 3 completes the commitment semantics. Draft `commitment.txt` from `Solo User`, `Proposal Delegation`, `Fair Valuation`, `Trade Restrictions`, `Transfer Address Restrictions`, and `Staked External Polymarket Execution`, then add commitment-local language for:

- initiated-trade reimbursement plus final-settlement deposit semantics
- withdrawal restrictions while unsettled external liabilities exist
- slashability for false trade logging or misreporting through the node

Do not change `agent-library/RULE_TEMPLATES.md` during implementation unless the user explicitly approves a minimal shared-template update first.

Milestone 4 adds proof-quality validation. The module and node need tests for restart recovery, duplicate publication, broken sequence chains, invalid prior-CID links, missing settlement, false-log handling, incorrect reimbursement attempts, and concurrent multi-market activity. A local smoke flow should run with mocked Polymarket responses and mock IPFS, because a safe non-production path is required and live Polygon/Polymarket credentials are not guaranteed in every environment.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Add the new shared node protocol and config surfaces.

   Files:

   - `agent/src/lib/config.js`
   - `agent/src/lib/agent-config.js`
   - `agent/src/lib/signed-published-message.js` (new)
   - `agent/src/lib/message-publication-store.js` (new)
   - `agent/src/lib/message-publication-api.js` (new)
   - `agent/scripts/lib/message-publish-runtime.mjs` (new)
   - `agent/scripts/start-message-publish-node.mjs` (new)
   - `agent/scripts/test-message-publication-api.mjs` (new)
   - `agent/scripts/test-message-publication-store.mjs` (new)

   Commands:

   - `node agent/scripts/start-message-publish-node.mjs --module=polymarket-staked-external-settlement --dry-run`
   - `node agent/scripts/test-message-publication-store.mjs`
   - `node agent/scripts/test-message-publication-api.mjs`

   Expected behavior:

   - dry-run prints resolved host, port, chain, state file, and node name
   - exact duplicate publication retries return the existing CID and archived artifact metadata
   - the API accepts arbitrary signed messages without needing any domain-specific top-level fields
   - duplicate detection and indexing are derived from fields inside the signed message rather than parallel top-level copies
   - the Polymarket example can still reject malformed per-market sequence histories inside its own message payload processing

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
   - `agent-library/agents/polymarket-staked-external-settlement/market-index.js` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/settlement-reconciliation.js` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/harness.mjs` (new)
   - `agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs` (new)

   Commands:

   - `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs`
   - `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`

   Expected behavior:

   - the module refuses to trade when fixed stake is inactive or policy gating fails
   - every accepted trade state change yields one signed publication request for the affected `marketId`
   - every logged trade is classified as `initiated` or `continuation`
   - the module can keep multiple market ledgers active at once without merging their sequence histories
   - the module config can describe multiple supported markets without code changes in shared infrastructure
   - reimbursement proposals are only built after the required final settlement deposit is recorded for the corresponding market

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
   - docs explain that this example is public-log and multi-market capable by design

5. Add smoke coverage with a safe mock environment.

   Commands:

   - `node agent/scripts/testnet-harness.mjs smoke --module=polymarket-staked-external-settlement --profile=local-mock`
   - `node agent/scripts/testnet-harness.mjs down --module=polymarket-staked-external-settlement --profile=local-mock`

   Expected behavior:

   - local harness starts the agent plus any required mock node services
   - the scenario publishes message artifacts for more than one `marketId`
   - the scenario reaches either mock final exits or mock market resolutions and performs the expected deposit-plus-reimbursement sequence per market

## Validation and Acceptance

Required validation commands:

- `node agent/scripts/test-message-publication-store.mjs`
- `node agent/scripts/test-message-publication-api.mjs`
- `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs`
- `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`
- `node agent/scripts/testnet-harness.mjs smoke --module=polymarket-staked-external-settlement --profile=local-mock`

Acceptance requires all of the following:

- the new module stays local to `agent-library/agents/polymarket-staked-external-settlement/`, except for clearly shared node or Polymarket infrastructure
- the Oya node can archive, pin, and dedupe arbitrary signed messages
- the node and module both support arbitrarily many concurrent `marketId` streams for the same commitment and user
- the trade ledger preserves the separation between reimbursable initiated-trade principal and final settlement owed to the user for each market
- continuation trades do not add reimbursement principal, but they do affect final settlement accounting
- portfolio-level withdrawal/dispute logic is derived from the aggregate state of all unsettled markets, not only one market
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
- if the agent loses local state, it should be able to reconstruct the latest set of market streams from persisted snapshots and observed onchain deposits/proposals before resuming settlement work
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

- `POST /v1/messages/publish`

Proposed signed request body shape:

- `message`
- `auth`

For endpoint purposes, `message` is opaque and domain-agnostic. Any details needed to interpret it must be included in the message itself. At minimum, the signed message format for this service should carry:

- `chainId`
- `requestId`
- `commitmentAddresses`
- `agentAddress`

For the Polymarket example, that message should also include at least:

- stream identity (`commitmentSafe`, `user`, `marketId`, `tradingWallet`)
- cumulative trade entries with timestamps, external identifiers, and `tradeEntryKind`
- derived ledger fields (`initiatedPrincipalWei`, `finalSettlementValueWei`, `reimbursementEligibleWei`, `fixedStakeWei`)
- current position summary
- settlement status summary

The protocol stays generalized on the wire but per-market in the Polymarket payload design. Supporting many markets means publishing many independent messages and message histories in parallel, not removing `marketId` from the Polymarket message contents.

New config dependency to add in module config:

- `messagePublishApi.enabled`
- `messagePublishApi.host`
- `messagePublishApi.port`
- `messagePublishApi.requireSignerAllowlist`
- `messagePublishApi.signerAllowlist`
- `messagePublishApi.signatureMaxAgeSeconds`
- `messagePublishApi.stateFile`
- `messagePublishApi.nodeName`

New per-market module config dependency to add:

- `marketsById` or equivalent per-market policy map keyed by `marketId`
- per-market trading metadata needed for settlement and policy checks
- any per-market allowlist, sizing, or settlement options that should vary by market without changing the protocol

Existing secrets and runtime dependencies:

- Polygon-compatible `rpcUrl`
- Polymarket CLOB credentials for the trading wallet
- IPFS API access for the node
- node signer credentials

Known design gaps that this plan must close before calling the agent sound:

- reimbursable initiated-trade principal and final settlement value must stay distinct throughout the ledger and proposal flow
- the implementation must encode the user-provided `initiated` versus `continuation` classification as deterministic state, not ad hoc operator judgment
- the withdrawal rule still needs exact commitment wording and corresponding dispute logic across multiple simultaneous unsettled markets
- the rule must say that false or misleading Polymarket messages published through the node are slashable
- "market close" must be replaced with explicit resolution or flat-exit semantics
- any shared rule-template edit must be minimal and user-approved before implementation
