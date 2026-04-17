# Deferred Settlement Polymarket Agent And Oya Trade Log Node

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build a new example agent that trades on Polymarket with the agent's own wallet and funds, keeps the user's capital parked in the commitment Safe, and settles each market stream only when that market stream is over. In this design, the agent can change positions quickly outside of the Safe, but every material trade state change is recorded in a signed trade log that an Oya node archives to IPFS and co-signs. The node should publish the full cumulative snapshot whenever sequence and internal-consistency checks pass, even if some newly introduced trade entries miss the reimbursement window. For those newly introduced trades, the node must add its own attested classification such as `reimbursable` or `non_reimbursable_late` based on the rule-defined time window after execution, so the agent cannot wait to see whether a trade pays off before deciding whether to attribute it to the user. When a market resolves, the agent deposits whatever settlement amount is owed to the user under the logged trade history for that market and then claims reimbursement only for the initially fronted principal tied to node-attested reimbursable initiated trades.

After this work, a reviewer or operator should be able to:

- run a standalone Oya signed-message publication node for a selected agent module
- run a new agent module under `agent-library/agents/` that executes external Polymarket trades and maintains durable per-market liability ledgers
- inspect IPFS-published message artifacts, including Polymarket trade-log messages that show what the agent says it did, what the node attested to, and what settlement is now owed
- observe that the agent only requests reimbursement after depositing the required final settlement amount into the Safe
- observe that the standalone node disputes user withdrawals that violate the commitment's withdrawal rule while one or more market streams are still unsettled
- observe that the standalone node submits reimbursement proposals from published node state after the agent's signed reimbursement request is published

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
- [x] 2026-04-10 01:45Z: Spun out the requested directory-refactor work into `plans/node-directory-extraction.md`. Any later implementation of this plan's node startup paths should follow that extraction plan so the primary entrypoints move from `agent/` to a dedicated `node/` workspace instead of growing more node-owned code under `agent/scripts/`.
- [x] 2026-04-10 02:03Z: Implemented the first extraction pass for standalone node process surfaces: new primary startup paths now live under `node/scripts/`, `node/README.md` documents the node workspace, and the old `agent/scripts/start-...node.mjs` files now delegate to the new paths as compatibility wrappers.
- [x] 2026-04-13 14:52 PDT: Revised the plan after user clarification that trade logs must be published within the commitment-defined timeliness window to remain reimbursement-eligible, and that the node should enforce that window during publication.
- [x] 2026-04-13 15:01 PDT: Revised the plan again so late trades stay visible in published cumulative snapshots, while the node separately attests which newly introduced trades are reimbursable versus non-reimbursable based on timeliness, sequence continuity, and internal consistency.
- [x] 2026-04-13 15:11 PDT: Implemented the shared message-publication validator hook, attested `publication.validation` payloads, duplicate-safe persistence of validator output, runtime resolution of `validatePublishedMessage()` from agent modules, and focused store/API/runtime regressions.
- [x] 2026-04-13 16:10 PDT: Added the first module-local Polymarket trade-log validator under `agent-library/agents/polymarket-staked-external-settlement/`. The new module now exists as a minimal scaffold with its own `agent.js`, `commitment.txt`, `agent.json`, `config.json`, and validator test. The validator reads `ogModule.rules()` onchain, parses the deployed logging-delay minutes from the `Staked External Polymarket Execution` clause, validates cumulative snapshot continuity against previously published records, and classifies newly introduced trades as `reimbursable` or `non_reimbursable_late`.
- [x] 2026-04-13 17:02 PDT: Added validator-provided message publication lock keys and stream-scoped serialization in the shared node so concurrent requests for the same Polymarket stream but different `requestId`s cannot both validate against stale history. The staked external settlement module now exports per-stream lock keys derived from the same normalized stream identity as the validator.
- [x] 2026-04-13 17:45 PDT: Hardened the module-local validator so read-only runtime initialization failures are re-wrapped as `message_validation_unavailable` instead of leaking as generic publish failures. This preserves validator-specific API semantics during RPC outages or chain mismatch.
- [x] 2026-04-14 11:56 PDT: Expanded `agent-library/agents/polymarket-staked-external-settlement/` beyond the scaffold. The module now persists per-market trade/settlement state, ingests signed agent-authored `polymarket_trade` and `polymarket_settlement` commands, publishes cumulative trade-log snapshots through the companion node via the new shared `publish_signed_message` tool, and tracks node reimbursement classifications. A later same-day refactor moved disputes and reimbursement proposal submission out of the agent loop and into the standalone node control loop.
- [x] 2026-04-14 11:56 PDT: Added focused module coverage in `test-polymarket-staked-external-settlement-agent.mjs`, updated module metadata/config/commitment text, and documented the new shared `publish_signed_message` tool in `agent/README.md`.
- [x] 2026-04-14 13:12 PDT: Refactored the module boundary so the agent only trades, deposits settlement, and publishes signed trade-log / reimbursement-request messages, while a standalone node-side control loop now owns withdrawal disputes and reimbursement proposal submission from published node state. Added `node/scripts/start-control-node.mjs`, module-local node controller state/helpers, and focused node-controller coverage.
- [x] 2026-04-14 15:09 PDT: Rewired the Polymarket control node so reimbursement proposals now go through the standalone proposal-publication node in `propose` mode instead of calling `post_bond_and_propose` directly. Added a shared signed proposal-publication bridge in `agent/src/lib/`, updated the module config to enable `proposalPublishApi`, and extended focused shared/module coverage.
- [x] 2026-04-14 16:05 PDT: Hardened trade-log settlement handling so the validator now normalizes settlement summary fields into the accepted snapshot shape, rejects inconsistent settled snapshots, and the control node reads only that validated summary before allowing reimbursement. Added regressions for malformed settlement summaries and premature reimbursement requests against unsettled snapshots.
- [x] 2026-04-14 16:18 PDT: Hardened configured-market scoping so Polymarket message validation now rejects unconfigured `stream.marketId` values, and the control node filters published state down to configured markets before disputes or reimbursement proposals can be generated. Added regressions for both validation-time rejection and node-side defense in depth.
- [x] 2026-04-14 16:27 PDT: Hardened reimbursement replay safety so node-side `submission.status = "uncertain"` now blocks further reimbursement proposal generation for that market, and fixed `resolvePolicy()` to allow per-market-only `userAddress` configuration instead of requiring a global fallback when each market already specifies its own user.
- [x] 2026-04-14 16:43 PDT: Fixed two more control-node safety gaps: `node/scripts/start-control-node.mjs` now lazy-loads and caches real `ogContext` before executing dispute tool calls, and `node-controller.js` now filters published trade-log / reimbursement-request state by the module's full configured stream identity (chain, authorized agent, Safe, OG, user, marketId, trading wallet) instead of `marketId` alone. Added regressions for both the script-side OG-context loader and foreign-scope published-market rejection.
- [x] 2026-04-14 17:02 PDT: Propagated bearer auth from resolved runtime config into both Polymarket publication paths (`publish_signed_message` and `publish_signed_proposal`) so bearer-gated message/proposal nodes keep working, and widened persisted state scope compatibility to include collateral token plus per-market user mappings so stale state files fail closed after config changes. Added focused regressions for both auth propagation and scope mismatch.
- [x] 2026-04-14 17:21 PDT: Hardened settlement and proposal retry state. Settlement-command updates now invalidate prior deposit proof when the settlement amount/time/kind changes, so increased obligations are no longer treated as already paid. The node-side reimbursement refresh path now clears tx-backed submissions after `pendingTxTimeoutMs` if the receipt never becomes available, allowing safe retries instead of blocking that market forever. Added focused module/node regressions for both cases.
- [x] 2026-04-14 17:38 PDT: Fixed two more reimbursement-stall / underfunding edge cases. Reimbursement-request publication now preserves the exact dispatched market revision instead of reading mutable current market state when a delayed publish succeeds, and the node-side settlement-deposit verifier now treats a shared settlement deposit tx as one aggregate funding pool across all configured markets that reference it. Added focused module/node regressions for both cases.
- [x] 2026-04-14 17:47 PDT: Added timeout-based recovery for agent-side settlement deposits. Submitted settlement deposit txs now record `depositSubmittedAtMs`, and repeated receipt lookup failures clear the stuck tx hash after `pendingTxTimeoutMs` so the market can retry deposit dispatch instead of remaining blocked forever. Added a focused agent regression for the timeout path.
- [x] 2026-04-15 09:11 PDT: Fixed two more stale-state hazards. Hashless `submitted`/`uncertain` proposal-publication responses now stay in the short-lived node dispatch state instead of the permanent submitted state, so the control node retries after `dispatchGraceMs` rather than getting stuck. Trade-log publication request IDs now include both sequence and revision, so a cleared stale dispatch can safely publish a newer same-sequence snapshot without colliding with the old request ID. Added focused module/node regressions for both cases.
- [x] 2026-04-15 09:18 PDT: Hardened control-node signer authorization. `getNodeDeterministicToolCalls()` now enforces that the runtime signer equals the configured `authorizedAgent` before emitting disputes or reimbursement proposals, matching the agent-loop guard and preventing misconfigured control nodes from using the wrong key. Added a focused node regression for the rejection path.
- [x] 2026-04-15 09:26 PDT: Repaired `node/scripts/start-control-node.mjs` package compatibility. The control-node entrypoint now loads shared runtime modules through a new local wrapper that uses the same local-path-first, `og-commitment-agent` fallback import strategy as the other extracted node entrypoints, so standalone `node/` installs do not fail on hardcoded `../../agent/...` imports.
- [x] 2026-04-15 09:34 PDT: Fixed two more dispute-loop reliability gaps. Pending dispute retries now refresh `dispatchAtMs` on each emitted `dispute_assertion`, so long-lived transient failures do not age out and disappear, and the control-node loop now feeds the full active proposal set into module dispute logic instead of only newly observed proposals. Added focused module and script-level regressions for both behaviors.
- [x] 2026-04-15 09:42 PDT: Fixed stale settlement-deposit dispatch locks. Agent-side stale-dispatch cleanup now also expires `settlement.depositDispatchAtMs`, records a retryable deposit error, and allows `make_deposit` to be re-emitted when no `onToolOutput` ever arrives after dispatch. Added a focused agent regression for the deadlock case.
- [x] 2026-04-15 09:48 PDT: Enforced `--chain-id` as a real startup assertion in `node/scripts/start-control-node.mjs`. The entrypoint now compares the explicit CLI chain ID against the resolved runtime config and aborts on mismatch instead of silently ignoring the flag. Added a focused script-level regression for the helper.
- [x] 2026-04-15 09:56 PDT: Stopped trusting agent-authored settlement confirmation flags for node decisions. `buildPublishedMarketViews()` now treats `summary.settlementDepositConfirmedAtMs` as only a claimed value, and the control node overwrites effective `depositConfirmedAtMs` from onchain receipt verification before dispute or reimbursement gating runs. Added a focused node regression showing that a fake claimed deposit no longer suppresses withdrawal disputes.
- [x] 2026-04-15 10:05 PDT: Hardened settlement-deposit receipt timeout handling so reconciliation timeouts preserve the original `depositTxHash` and block automatic retry instead of clearing the hash and risking a second transfer if the first deposit actually mined during an RPC outage. Updated the focused agent regression to assert the market stays blocked pending reconciliation of the original tx hash.
- [x] 2026-04-15 10:16 PDT: Fixed late trade-log publication reconciliation after stale-dispatch races. `applyPublicationToolOutput()` now recovers successful `polymarketTradeLog` outputs by published stream identity plus embedded sequence/revision, even when the old `requestId` no longer matches `pendingPublication`, and clears obsolete local pending publications for that sequence so the module advances to the next sequence instead of looping on `message_sequence_invalid`.
- [x] 2026-04-15 10:28 PDT: Fixed reimbursement proposal delete-retry request IDs. The node now persists a per-market `proposalRetryGeneration`, resets it when a new reimbursement request CID arrives, increments it only when an onchain delete event clears a prior proposal, and appends `:retry:<n>` to proposal-publication request IDs after deletion so replacement proposals get fresh proposal-publication records instead of replaying the old resolved request.
- [x] 2026-04-15 10:39 PDT: Hardened hashless resolved proposal-publication handling. When `publish_signed_proposal` returns `submission.status = "resolved"` with `skipped: true` and no tx/proposal hash, the control node now treats that as terminal for the current reimbursement request instead of re-arming the dispatch timer and looping forever. A new reimbursement request CID still resets that terminal state so later fresh requests can proceed.
- [x] 2026-04-16 09:12 PDT: Relaxed agent-side tool scheduling so retrying stuck trade-log publications no longer starve settlement deposits. Newly created trade-log publications still take priority, but if a market is only replaying an existing `pendingPublication`, the module now allows `make_deposit` to run first for any settled market with unpaid settlement. Added a persisted-state regression proving a blocked publication retry no longer prevents settlement repayment dispatch.
- [x] 2026-04-16 17:13 PDT: Added module-local smoke coverage in `agent-library/agents/polymarket-staked-external-settlement/harness.mjs` plus `test-polymarket-staked-external-settlement-harness.mjs`. The new in-process harness stands up real message/proposal publication API servers on ephemeral local ports with mock IPFS and mocked onchain reads, then drives the full happy-path flow: timely trade-log publication, settlement publication, settlement deposit confirmation, post-deposit trade-log publication, reimbursement-request publication, and node-side reimbursement proposal publication through the standalone proposal node.
- [x] 2026-04-16 17:20 PDT: Reframed the remaining roadmap after user direction to require direct Polymarket trade discovery and execution. The signed `polymarket_trade` / `polymarket_settlement` ingress is now explicitly temporary scaffolding to be replaced by module-local market observation, CLOB order placement, and execution reconciliation using the existing `copy-trading` and `polymarket-intent-trader` code paths as references.
- [x] 2026-04-16 18:07 PDT: Completed the first direct-execution slice inside `agent-library/agents/polymarket-staked-external-settlement/`. The module now supports direct market observation via configured source-user / token mappings, emits real `polymarket_clob_build_sign_and_place_order` tool calls, reconciles filled CLOB orders back into the existing trade ledger as `initiated` / `continuation` entries, and the smoke harness now opens the market through that direct path before continuing through settlement deposit, reimbursement request publication, and node-side reimbursement proposal publication.
- [x] 2026-04-16 19:06 PDT: Hardened the new direct execution/settlement paths. Direct settlement observation now requires explicit resolved-state signals from Gamma before a payout can mark the market settled, so live `0.5/0.5` or transient `1/0` prices do not advance settlement prematurely. Stale direct-order dispatch cleanup now clears the full in-flight execution state instead of only `orderDispatchAtMs`, so missed tool outputs truly become retryable. Added focused regressions plus a smoke rerun.
- [x] 2026-04-16 19:18 PDT: Added legacy persisted-state compatibility for the new direct-execution fields. Existing markets now get in-place backfills for missing nested state like `execution`, `settlement`, and `reimbursement` before direct-order logic runs, so pre-direct-trading state files do not crash with `Cannot set properties of undefined`. Added a persisted-state regression and reran focused smoke coverage.
- [x] 2026-04-16 19:24 PDT: Tightened direct-trading readiness so a market must include `sourceMarket` as well as `sourceUser`, token IDs, and positive `initiatedCollateralAmountWei` before it is treated as executable. This prevents silent no-op direct paths when `marketsById` uses human-readable keys that are not valid Polymarket market identifiers. Added a focused policy regression and reran the agent plus smoke suites.
- [x] 2026-04-16 19:33 PDT: Hardened two more direct Polymarket reconciliation edges. Filled terminal CLOB orders can now finalize from order-summary maker/taker fill fields even when `/data/trades` returns no rows, avoiding indefinite stalls behind missing trade indexing, and resolved settlement payout rounding now floors deterministically to collateral base units instead of dropping the market on fractional 50/50-style payouts. Added focused regressions and reran the agent plus smoke suites.
- [x] 2026-04-16 19:43 PDT: Fixed two additional direct-trading correctness issues. Order-summary fee handling now subtracts `feeAmount` as base-unit shares instead of reparsing it as a decimal share string, and CLOB preflight errors are now raised only when the module is about to create a fresh direct order, not while it is processing existing bootstrap settlement / reimbursement work for a settled market. Added focused regressions and reran the agent plus smoke suites.
- [x] 2026-04-16 19:52 PDT: Hardened direct Polymarket fetch/config behavior. Source-trade discovery failures from the Polymarket Data API now degrade into per-market `orderError` state and still let the loop continue into unrelated reimbursement publication work, and the module now accepts the standard runtime `polymarketConditionalTokens` config key when resolving the CTF contract for direct settlement observation. Added focused regressions and reran the agent plus smoke suites.
- [x] 2026-04-16 18:39 PDT: Replaced the primary settlement signal path with direct settlement observation for the current BUY-side flow. The module now reads resolved Polymarket market state from Gamma, reads live Yes/No ERC1155 balances from the configured trading holder via the CTF contract, derives `finalSettlementValueWei` from the resolved payout, publishes that observed settlement through the existing trade-log publication flow, and the smoke harness now reaches reimbursement without any `polymarket_settlement` command.

## Surprises & Discoveries

- Observation: The repo already has the two halves this design needs, but not yet the combined flow.
  Evidence: `agent-library/agents/copy-trading/agent.js` already does external Polymarket execution with agent funds, while `agent-library/agents/polymarket-intent-trader/agent.js` already does durable IPFS archival and actual-spend reimbursement accounting.

- Observation: The standalone node workspace already had publication APIs, but no polling control loop.
  Evidence: `node/README.md` and the existing `node/scripts/start-...publish-node.mjs` surfaces covered message/proposal publication only, so moving disputes and reimbursement proposals to the node required a new loop entrypoint instead of just flipping a config flag.

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

- Observation: Cumulative trade-log snapshots require timeliness checks only for newly introduced trade entries, not for the entire historical snapshot.
  Evidence: This plan intentionally uses hash-chained cumulative snapshots. Rechecking every historical entry against the current time would make retries and later updates fail after the original logging window passed, even if those older entries had already been accepted on time.

- Observation: The control node cannot safely treat agent-authored settlement summaries as reimbursement gates unless those summary fields are themselves part of the validator-owned accepted snapshot shape.
  Evidence: Before the hardening pass, `node-controller.js` read `payload.summary.finalSettlementValueWei` directly from the archived signed message even though `normalizeTradeLogMessage()` only validated `stream`, `sequence`, `previousCid`, and `trades`.

- Observation: Rejecting an entire cumulative snapshot because one newly introduced trade is late would hide audit-relevant trade history and create incentives to omit losing trades from the publication stream.
  Evidence: The user clarified that the preferred path is to publish all trades, but separately track which ones remain reimbursement-eligible.

- Observation: Per-request duplicate handling is not enough for cumulative trade-log streams. Two different `requestId`s for the same stream can otherwise both validate against the same stale latest snapshot and produce permanently conflicting sequence history.
  Evidence: The shared message publisher originally serialized only by `(signer, chainId, requestId)`, while the Polymarket validator enforces sequence monotonicity by stream identity.

- Observation: The deferred-settlement module could not use the new message publication node cleanly until the shared runner exposed a generic way for deterministic agents to sign and submit structured messages.
  Evidence: `getDeterministicToolCalls()` only receives read-side runtime context, so module-local code could not reach the runtime signer without either a shared tool or a shared API-surface change. The implemented solution was a new generalized `publish_signed_message` tool in `agent/src/lib/tools.js`.

- Observation: The current module boundary is right, but the current trade ingress is still a scaffold.
  Evidence: `agent-library/agents/polymarket-staked-external-settlement/trade-ledger.js` still centers `TRADE_COMMANDS` / `SETTLEMENT_COMMANDS`, while `agent-library/agents/copy-trading/agent.js` and `agent-library/agents/polymarket-intent-trader/polymarket-reconciliation.js` already contain the repo’s real Polymarket execution and reconciliation patterns.

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

- Decision: In v1, the node does not verify trade truth before publication.
  Rationale: The user wants false logs handled at settlement time by rejecting reimbursement and slashing stake, not by moving trade-truth verification into the node.
  Date/Author: 2026-04-09 / Codex.

- Decision: For Polymarket reimbursement logs, the node must publish the full cumulative snapshot when sequence and internal-consistency checks pass, but attach its own per-trade reimbursement classification for newly introduced entries based on the `Staked External Polymarket Execution` timeliness window.
  Rationale: Agent-controlled timestamps can be backdated, but the node's `receivedAtMs` / `publishedAtMs` values are trustworthy. Publishing the full snapshot preserves auditability, while node-side classifications prevent late trades from creating reimbursement rights.
  Date/Author: 2026-04-13 / Codex.

- Decision: In v1, the node should verify only timeliness, sequence continuity, and internal consistency. Trade-truth verification and entry-price verification are explicit future work.
  Rationale: The shared node surface should stay generic across trade domains. Whether a trade actually happened, and at what price, is use-case-specific and can be layered on in later validators without redesigning the publication protocol.
  Date/Author: 2026-04-13 / Codex.

- Decision: The Polymarket module should stop issuing `dispute_assertion` and reimbursement proposal tool calls from the agent loop. Instead, the agent should publish signed reimbursement-request messages and a standalone node-side control loop should act from published node state.
  Rationale: The user clarified that the agent should trade and report, while the node should own commitment-enforcement actions. Keeping disputes and reimbursement proposal submission on the node side also makes those actions depend on node-attested published history instead of unpublished agent-local state.
  Date/Author: 2026-04-14 / Codex.

- Decision: Replace the temporary signed-command trade ingress with direct Polymarket trade discovery and execution inside `agent-library/agents/polymarket-staked-external-settlement/`.
  Rationale: The user chose the production-shaped direction. The module should discover opportunities from a configured trigger source, place and reconcile Polymarket CLOB orders from the agent wallet directly, and only use signed message publication for node-facing trade logs and reimbursement requests, not as the primary source of trade truth.
  Date/Author: 2026-04-16 / Codex.

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

- Completed: generic signed-message publication plumbing landed in `agent/src/lib/config.js`, `agent/src/lib/agent-config.js`, `agent/src/lib/signed-published-message.js`, `agent/src/lib/message-publication-store.js`, `agent/src/lib/message-publication-api.js`, the shared runtime helper under `agent/scripts/lib/message-publish-runtime.mjs`, and the standalone node entrypoint now exposed primarily at `node/scripts/start-message-publish-node.mjs` with a compatibility wrapper retained at `agent/scripts/start-message-publish-node.mjs`.
- Completed: focused validation landed in `agent/scripts/test-message-publication-store.mjs`, `agent/scripts/test-message-publication-api.mjs`, and an extension to `agent/scripts/test-agent-config-file.mjs`.
- Validated: `node agent/scripts/test-message-publication-store.mjs`, `node agent/scripts/test-message-publication-api.mjs`, and `node agent/scripts/test-agent-config-file.mjs`.
- Completed follow-up: the artifact now also includes an explicit node `eip191` attestation over publication metadata plus the archived signed message, and the publish-node startup path resolves a signer from `MESSAGE_PUBLISH_API_SIGNER_PRIVATE_KEY` or the shared signer configuration.
- Completed follow-up: the shared message publication node now supports an optional module-exported validator hook, signs normalized validator output into `publication.validation`, preserves that output across duplicate/pin-retry flows, and rejects only structural validator failures before publication.

Remaining design work now moves from validator scaffolding into the full deferred-settlement agent implementation. The node-side hook and attested validation payload exist, and `agent-library/agents/polymarket-staked-external-settlement/` now owns the first local validator implementation plus a minimal module scaffold. What remains is to flesh out that module's actual trade-log publisher, settlement ledger, reimbursement logic, and smoke harness.

Milestone 2 status after the current implementation pass:

- Completed: `agent-library/agents/polymarket-staked-external-settlement/agent.js` now owns only the agent-side workflow: it ingests signed agent-authored trade and settlement commands, persists per-market ledgers, publishes cumulative trade logs through the companion node, merges node reimbursement classifications, deposits settlement collateral, and publishes a signed reimbursement request after the required settlement deposit is satisfied.
- Completed: module-local helpers now live in `state-store.js`, `trade-ledger.js`, and `settlement-reconciliation.js` instead of pushing that behavior into shared runner files.
- Completed: the shared runner gained one generalized companion-node bridge, `publish_signed_message`, because signing and posting agent-authored publication requests is reusable across modules and cannot be implemented safely from module-local deterministic code alone.
- Completed follow-up: `agent-library/agents/polymarket-staked-external-settlement/node-controller.js` and `node/scripts/start-control-node.mjs` now provide the node-side half. The control node reads the durable message-publication ledger, watches OG proposals, disputes invalid user withdrawals from published unsettled-market state, and routes reimbursement proposals through `POST /v1/proposals/publish` so the proposal node archives them to IPFS and submits them onchain in `propose` mode.
- Completed follow-up: the shared runner gained a second reusable companion-node bridge, `publish_signed_proposal`, so deterministic module/control-hook code can sign proposal-publication requests with the runtime signer and submit them to the standalone proposal node without bypassing shared auth/canonicalization code.
- Validated: `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-agent.mjs`, `node agent-library/agents/polymarket-staked-external-settlement/test-polymarket-staked-external-settlement-node.mjs`, `node agent-library/agents/polymarket-staked-external-settlement/test-published-message-validator.mjs`, `node agent/scripts/validate-agent.mjs --module=polymarket-staked-external-settlement`, `node agent/scripts/test-message-publication-api.mjs`, `node agent/scripts/test-proposal-publication-api.mjs`, and `node node/scripts/start-control-node.mjs --module=polymarket-staked-external-settlement --dry-run`.
- Follow-up direction: the current signed `polymarket_trade` / `polymarket_settlement` signal ingestion should now be treated as a bootstrap path, not the target architecture. The next implementation slice should replace it with direct trigger observation, CLOB order placement, and fill / settlement reconciliation inside this module.

Remaining work is now narrower:

- broaden direct execution beyond the current single-source BUY-copy slice so the module can handle richer trigger policies, additional outcomes / exits, and repeated source-trade observation without relying on manual command ingress
- decide whether the temporary signed `polymarket_trade` / `polymarket_settlement` ingestion path should stay as test-only scaffolding or be removed entirely now that both direct trade entry and direct settlement observation exist for the current happy path
- extend direct settlement observation beyond the current resolved-balance latch so it can handle richer lifecycle cases such as realized flat exits before resolution, explicit redemption / merge flows, and other settlement-changing post-trade actions without falling back to manual signals

## Context and Orientation

The relevant current code paths are:

- `agent-library/agents/copy-trading/`
  - external Polymarket execution from the agent's wallet
  - source-trade observation and order placement
  - current settlement model is immediate ERC1155 token deposit plus reimbursement proposal

- `agent-library/agents/polymarket-intent-trader/`
  - IPFS archival of signed trade intents
  - durable local state, reimbursement accounting, and restart recovery
  - useful local helpers to borrow conceptually for ledgering, proposal matching, and Polymarket order reconciliation via `polymarket-reconciliation.js`

- `agent/src/lib/message-api.js` and `agent/src/lib/runtime-loop.js`
  - signed message ingestion for the main agent process

- `agent/src/lib/proposal-publication-api.js`
  - standalone node pattern for signed request authentication, IPFS publication, and durable dedupe

- `agent/src/lib/proposal-publication-store.js`
  - crash-safe durable JSON store pattern that can be mirrored for generalized signed-message publication

- `agent/src/lib/signed-published-message.js`
  - current message-publication artifacts already include node-authored `receivedAtMs`, `publishedAtMs`, and attestation metadata, which can anchor trade-log timeliness checks without trusting agent-supplied clocks and can be extended with validator-produced classifications

- `agent/src/lib/polymarket.js` and `agent/src/lib/polymarket-relayer.js`
  - shared Polymarket execution helpers
  - currently focused on CLOB orders, trades, and relayer wallet resolution, and they should remain the shared foundation for the direct-execution refactor rather than duplicating CLOB request logic inside the deferred-settlement module

- `agent-library/RULE_TEMPLATES.md`
  - the `Staked External Polymarket Execution` template now includes `Trades must be logged within [ ] minutes of trade execution to be considered valid for reimbursement.`

The commitment side remains rule-driven rather than contract-driven. This means no new Solidity code should be assumed unless implementation proves a contract gap. The expected enforcement model is:

- the agent deposits stake into the commitment
- the agent discovers configured trade opportunities and executes Polymarket trades directly from its wallet, then publishes signed messages to the Oya node for each active market with the resulting Polymarket-specific trade details embedded in those messages
- the node co-signs and publishes full trade-log snapshots when sequence and internal-consistency checks pass, and adds node-attested per-trade reimbursement classifications for newly introduced trades
- the agent deposits the final settlement amount owed to the user for a given market into the Safe before requesting reimbursement for that market
- the node disputes user withdrawals that violate the commitment's withdrawal rule while any market settlement is still outstanding
- the node submits reimbursement proposals after the agent's reimbursement request is published and the required settlement deposit is verified
- the user or another watcher can slash the agent's stake if the published log and market outcome show non-settlement or misreporting for any market

This plan assumes v1 remains an offchain-enforced commitment served by the current Oya runner and Optimistic Governor patterns.

## Plan of Work

Milestone 0 freezes the accounting model before code spreads. The first task is to define the data model the module and node both agree on. The agent should maintain a portfolio index keyed by `marketId`, where each market owns its own independent stream and settlement state. The core per-market values are:

- `marketId`: Polymarket market identifier for this stream
- `tradeId`: stable identifier for one trade entry inside the cumulative stream
- `tradeEntryKind`: `initiated` or `continuation`
- `tradeGroupId`: stable identifier tying continuation trades back to the reimbursable trade path they continue
- `executedAtMs`: the claimed execution time for a trade entry, which the node compares against attested receipt/publication time when the entry first appears
- `initiatedPrincipalContributionWei`: reimbursable principal contributed by a single initiated trade; always zero for continuation trades
- `initiatedPrincipalWei`: cumulative reimbursable principal across all initiated trades in this market stream
- `grossBuyCostWei`: total USDC the agent spent opening or adding to positions
- `grossSellProceedsWei`: total USDC the agent received from offchain sales before resolution
- `grossRedeemProceedsWei`: total USDC the agent received from onchain redemption after resolution
- `feesWei`: total trading or redemption fees charged to the agent wallet
- `finalSettlementValueWei`: the amount the agent must deposit into the Safe at flat exit or resolution based on the cumulative logged trading result
- `reimbursementEligibleWei`: the amount the agent may claim back after making that final settlement deposit; for v1 this is the sum of reimbursable initiated-trade principal
- `fixedStakeWei`: the active slashable stake deposited under the commitment rules
- `nodeTradeClassificationById` or equivalent durable mapping: the first node-attested record for each `tradeId`, including `firstSeenAtMs`, `classification`, `reason`, and the attested CID
- `withdrawalLimitState`: the values needed to decide whether a user withdrawal violates the commitment during an unsettled stream

The critical accounting separation is: all trades affect `finalSettlementValueWei`, but only trades marked `initiated` affect `reimbursementEligibleWei`. If a later trade uses fresh agent capital and should be reimbursable, it must be logged as a new initiated trade. If it continues an earlier trade path after that path was closed out with a sale, it must be logged as a continuation trade with zero new reimbursement principal. A trade only contributes to `reimbursementEligibleWei` if the node has attested it as `reimbursable` when it first appears in a published snapshot. Late trades remain in the published history and can still matter for audit and settlement reasoning, but they must be attested `non_reimbursable_late` and must not create reimbursement rights.

Milestone 0 must also define the portfolio-level rollups derived from those per-market ledgers, because the withdrawal rule is commitment-wide rather than market-local. At minimum the module needs deterministic sums for:

- `totalUnsettledReimbursementEligibleWei`
- `totalUnsettledSettlementObligationWei`
- `unsettledMarketIds`
- any additional aggregate used to decide whether a user withdrawal proposal must be disputed

Milestone 0 must also define the module config shape for multi-market support. The plan should replace any single-market policy assumptions with a per-market policy map keyed by `marketId` so new markets can be added without changing the core ledger model.

Milestone 1 adds a generalized signed-message publication protocol to the Oya node. This should parallel the proposal-publication node but not replace it. Add a new config block such as `messagePublishApi`, a canonical signed payload builder, a durable store, and a standalone startup helper. The node endpoint should accept an arbitrary signed message, verify the submitted `auth` envelope against that message, publish the final artifact to IPFS, pin it, and store duplicate-safe state keyed by the signed message identity. The signed message itself must carry `chainId`, `requestId`, `commitmentAddresses`, `agentAddress`, and any domain-specific payload. The shared endpoint should stay domain-agnostic, but it now needs an optional module-supplied validation hook. For this Polymarket module, that validator must resolve the current onchain `Staked External Polymarket Execution` rules, extract the allowed logging-delay minutes, compare node receipt/publication time against each newly introduced trade entry's `executedAtMs`, and verify sequence continuity plus internal consistency of the cumulative snapshot. If sequence or internal-consistency checks fail, the node should reject the snapshot before publication. If those checks pass, the node should publish the full snapshot and attach per-trade classifications for newly introduced entries, including `reimbursable` and `non_reimbursable_late`. The node still does not verify trade truth or entry price; it only enforces deterministic message-shape, sequence, timeliness, and internal-consistency requirements that are directly spelled out by the commitment or validator contract.

Milestone 2 creates the new agent module under `agent-library/agents/polymarket-staked-external-settlement/`. The module should own all agent-specific behavior. It should:

- observe one configured trigger source for v1 trading decisions and convert those observations into direct Polymarket order attempts
- execute external Polymarket trades from the agent wallet across any number of supported markets
- reconcile submitted CLOB orders and fills from Polymarket APIs instead of depending on externally injected signed trade commands
- update and persist per-market ledgers plus portfolio-level unsettled-state rollups locally
- publish a signed message to the Oya node after every material state change in the affected market
- persist which trade entries the node first classified as `reimbursable` versus `non_reimbursable_late`, and exclude any trade without a reimbursable node classification from reimbursement eligibility
- watch market status for every active market until that market is flat or resolved
- deposit the final settlement amount owed to the user for a resolved market before requesting reimbursement for that market
- refuse new trades when the fixed stake is not active or policy constraints are violated
- classify each logged trade deterministically as `initiated` or `continuation` before it affects reimbursement accounting in that market

Milestone 3 completes the commitment semantics. Draft `commitment.txt` from `Solo User`, `Proposal Delegation`, `Fair Valuation`, `Trade Restrictions`, `Transfer Address Restrictions`, and `Staked External Polymarket Execution`, then add commitment-local language for:

- initiated-trade reimbursement plus final-settlement deposit semantics
- log-timeliness semantics so late trades remain publishable but are marked non-reimbursable by node attestation
- withdrawal restrictions while unsettled external liabilities exist
- slashability for false trade logging or misreporting through the node

Do not change `agent-library/RULE_TEMPLATES.md` during implementation unless the user explicitly approves a minimal shared-template update first.

Milestone 4 adds proof-quality validation. The module and node need tests for restart recovery, duplicate publication, broken sequence chains, invalid prior-CID links, late-trade classification at the time-window boundary, missing settlement, false-log handling, incorrect reimbursement attempts, and concurrent multi-market activity. A local smoke flow should run with mocked Polymarket responses and mock IPFS, because a safe non-production path is required and live Polygon/Polymarket credentials are not guaranteed in every environment.

## Concrete Steps

From the repository root:

1. Add the new shared node protocol and config surfaces.

   Files:

   - `agent/src/lib/config.js`
   - `agent/src/lib/agent-config.js`
   - `agent/src/lib/signed-published-message.js` (new)
   - `agent/src/lib/message-publication-store.js` (new)
   - `agent/src/lib/message-publication-api.js` (new)
   - `agent/scripts/lib/message-publish-runtime.mjs` (new)
   - `node/scripts/start-message-publish-node.mjs` (new primary path)
   - `agent/scripts/start-message-publish-node.mjs` (compatibility wrapper)
   - `agent/scripts/test-message-publication-api.mjs` (new)
   - `agent/scripts/test-message-publication-store.mjs` (new)

   Commands:

   - `node node/scripts/start-message-publish-node.mjs --module=polymarket-staked-external-settlement --dry-run`
   - `node agent/scripts/test-message-publication-store.mjs`
   - `node agent/scripts/test-message-publication-api.mjs`

   Expected behavior:

   - dry-run prints resolved host, port, chain, state file, and node name
   - exact duplicate publication retries return the existing CID and archived artifact metadata
   - the API accepts arbitrary signed messages without needing any domain-specific top-level fields
   - the shared publish path exposes an optional module-level validator hook before CID publication and node attestation
   - duplicate detection and indexing are derived from fields inside the signed message rather than parallel top-level copies
   - for the Polymarket module, snapshots with late newly introduced trades still publish, but the node attestation marks those trades `non_reimbursable_late`
   - for the Polymarket module, snapshots with broken sequence continuity or internal-consistency failures are rejected before publication
   - retries of an already accepted cumulative snapshot remain valid even after the logging window has passed, because only newly introduced trade entries are re-evaluated
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
   - the module can discover a configured trade opportunity, place a Polymarket order directly, and reconcile the resulting fill into the local market ledger without requiring a signed `polymarket_trade` command
   - every accepted trade state change yields one signed publication request for the affected `marketId`
   - every logged trade is classified as `initiated` or `continuation`
   - every logged trade entry includes an execution timestamp that the node can compare against the current logging window
   - the module can keep multiple market ledgers active at once without merging their sequence histories
   - the module config can describe multiple supported markets without code changes in shared infrastructure
   - reimbursement eligibility is derived only from initiated trades whose first node classification is `reimbursable`
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
- the Oya node publishes full Polymarket trade-log snapshots when sequence and internal-consistency checks pass, and records per-trade node classifications for newly introduced trades
- the node and module both support arbitrarily many concurrent `marketId` streams for the same commitment and user
- the trade ledger preserves the separation between reimbursable initiated-trade principal and final settlement owed to the user for each market
- continuation trades do not add reimbursement principal, but they do affect final settlement accounting
- reimbursement proposals only count initiated trades that the node first classified as `reimbursable`
- the module’s primary trading path uses direct Polymarket execution and reconciliation, not externally injected signed trade commands
- portfolio-level withdrawal/dispute logic is derived from the aggregate state of all unsettled markets, not only one market
- the module enforces active fixed-stake and withdrawal-policy assumptions before approving reimbursement
- the module deposits the final settlement amount before proposing reimbursement
- the commitment text and docs describe the exact trust model, especially the public-log assumption and the difference between market close and resolution
- the docs explicitly state that the node is not a trade-truth verifier, but it does enforce message timeliness, sequence continuity, and internal consistency for reimbursement-eligible trade logs

## Idempotence and Recovery

The new node store and the module state store must both be crash-safe and retry-safe. Retries must never create duplicate liability records or duplicate reimbursement rights.

Specific recovery rules:

- exact re-publication of the same signed snapshot should return the stored publication record
- sequence gaps or mismatched `previousCid` values should stop the stream and require manual reconciliation
- timeliness checks must be applied only to trade entries that are new relative to the previously accepted snapshot for that stream, so retries and later cumulative updates do not "age out" older already-accepted entries
- once the node has first classified a trade as `non_reimbursable_late`, later cumulative snapshots must not upgrade that trade to `reimbursable`
- if the node publishes to IPFS but fails before durable store write, it must preserve enough volatile or staged state to reuse the first CID on retry
- if the agent loses local state, it should be able to reconstruct the latest set of market streams from persisted snapshots and observed onchain deposits/proposals before resuming settlement work
- if the node restarts, it must still be able to recover the latest accepted snapshot for each stream plus prior per-trade node classifications so future timeliness checks compare against the right `previousCid` and only the newly introduced trades
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
- `node/scripts/start-proposal-publish-node.mjs` (primary)
- `agent/scripts/start-proposal-publish-node.mjs` (compatibility wrapper)
- `plans/polymarket-agent-hardening.md`
- `plans/oya-node-publish-and-propose.md`

External behavior summarized from current official Polymarket docs and embedded here so the plan is self-contained:

- positions can be sold before resolution, so a market stream can settle before oracle resolution if the agent is flat
- redemption into USDC only becomes available after resolution
- market close and resolution are separate lifecycle stages
- the node in this plan is intentionally not a trade-truth verifier, so public market APIs are relevant mainly for market-status and resolution tracking, not for proving trade correctness before publication

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

- stream identity (`commitmentSafe`, `ogModule`, `user`, `marketId`, `tradingWallet`)
- cumulative trade entries with stable IDs, execution timestamps, external identifiers, and `tradeEntryKind`
- sequence metadata (`sequence`, `previousCid`) so the node can detect which trade entries are newly introduced in the current snapshot
- derived ledger fields (`initiatedPrincipalWei`, `finalSettlementValueWei`, `reimbursementEligibleWei`, `fixedStakeWei`)
- current position summary
- settlement status summary

The protocol stays generalized on the wire but per-market in the Polymarket payload design. Supporting many markets means publishing many independent messages and message histories in parallel, not removing `marketId` from the Polymarket message contents.

New shared/runtime interface to add:

- an optional message-publication validation hook resolved from module/runtime config before the shared `/v1/messages/publish` path builds and publishes the artifact
- for the Polymarket module, that hook must:
  - load the current onchain rules from the stream's `ogModule`
  - parse the `Staked External Polymarket Execution` logging-delay minutes
  - compare `receivedAtMs` or `publishedAtMs` against each newly introduced trade entry's `executedAtMs`
  - verify sequence continuity and internal consistency for the cumulative snapshot
  - reject the snapshot only when structural checks fail
  - otherwise return per-trade classifications for newly introduced entries such as `reimbursable` and `non_reimbursable_late`

The published node attestation should be extended to carry validator output separately from the agent-signed message, so the node can remain agnostic to the trade domain while later consumers can read:

- snapshot validation status and any structural failure reason
- per-trade classifications keyed by `tradeId`
- `firstSeenAtMs` for each newly introduced trade
- the reason attached to each non-reimbursable trade classification

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
