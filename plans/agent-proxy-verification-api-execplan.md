# Add Proposal Verification API and Agent Proxy Verifier

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Add a proposal verification capability to the existing Oya proposal publication node so the node can determine whether a signed proposal is correct before it submits the proposal onchain. The first supported verifier should target the standard-template `Agent Proxy` rule because that rule is the first major product surface and already maps to existing deposit-then-reimbursement behavior in this repository. The verifier must support reimbursement proposals that cover a batch of agent deposits, not just a single deposit, so one proposal can reimburse multiple valid deposits at once. In v1, each referenced deposit is reimbursable at most once: after a covering proposal executes, that deposit cannot be used again even if the reimbursed amount was slightly less than the full deposit-time value due to deterministic rounding.

After this work, an operator should be able to send a signed proposal candidate to the proposal node and receive a deterministic verification result: `valid`, `invalid`, or `unknown`, with the node reading the live commitment rules from `ogModule.rules()` and using structured onchain-readable reimbursement explanations to recover deposit history. In `propose` mode, the same verifier should be reusable as a pre-submit gate so the node can refuse to post bond and propose when the proposal cannot be proven correct under supported standard-template rules.

Observable user value:

- Standard-template commitments gain a machine-checkable verification path before onchain submission.
- The proposal node can explain why a proposal was accepted, rejected, or left unverified.
- `Agent Proxy` reimbursements stop depending solely on caller trust or agent-local logic.
- Future standard-template verifiers can be added without redesigning the node surface.

## Progress

- [x] 2026-04-12 17:43 PDT: Audited the current proposal publication node, request auth flow, proposal submission path, and rule-template sources.
- [x] 2026-04-12 17:43 PDT: Audited `agent-library/agents/first-proxy/agent.js` and confirmed it already contains deterministic reimbursement checks and deposit-time valuation logic that can inform a shared verifier.
- [x] 2026-04-12 17:43 PDT: Wrote this initial ExecPlan with a v1 requirements sketch, architecture decisions, milestones, and validation strategy.
- [x] 2026-04-12 18:19 PDT: Updated the v1 requirements to allow a single reimbursement proposal to consume value from a batch of confirmed deposits, with explicit anti-double-count accounting.
- [x] 2026-04-12 18:25 PDT: Simplified the batch model so each referenced deposit is reimbursable only once; no numeric remaining-balance tracking is required in v1.
- [x] 2026-04-12 19:03 PDT: Implemented a first shared parser in `agent/src/lib/proposal-verification.js` that recognizes standard-template sections, extracts key `Agent Proxy`, `Solo User`, `Fair Valuation`, and `Account Recovery and Rule Updates` parameters, and reports template coverage plus unparsed sections.
- [x] 2026-04-12 19:03 PDT: Implemented the first shared proposal verification library with explicit `valid`, `invalid`, and `unknown` outcomes, signed metadata parsing, deposit-state checks, receipt-backed deposit evidence checks, and deterministic reimbursement-value arithmetic for `agent_proxy_reimbursement`.
- [x] 2026-04-12 19:03 PDT: Added `POST /v1/proposals/verify`, verification result persistence on published proposal records, and an `off | advisory | enforce` `proposalVerificationMode` gate for propose mode.
- [x] 2026-04-12 19:03 PDT: Added regression coverage for the verifier module, verify endpoint behavior, propose-mode enforcement, store persistence, and signed proposal smoke compatibility.
- [x] 2026-04-12 19:03 PDT: Documented the shipped verification surface in `node/README.md` and `agent/README.md`, including endpoint behavior, signed metadata requirements, config gating, and current verifier limits.
- [x] 2026-04-13 14:34 PDT: Added canonical structured reimbursement explanations with `kind`, `description`, and `depositTxHashes`; the verifier now cross-checks explanation references against signed metadata and scans onchain `TransactionsProposed` history for the same OG module to derive non-local deposit reservation and consumption state.
- [x] 2026-04-13 16:05 PDT: Added deposit-scoped submission serialization in propose mode so concurrent requests with different `requestId`s but overlapping `depositTxHashes` cannot both verify and submit before local reservation state is durable.
- [ ] Expand verifier coverage so `first-proxy` commitments with extra templates such as `Trade Restrictions` and `Trading Limits` can reach `valid` instead of `unknown`.

## Surprises & Discoveries

- Observation: The current proposal node already authenticates requests, archives proposal artifacts to IPFS, and can submit proposals onchain, but it does not verify commitment-rule correctness before submission.
  Evidence: `agent/src/lib/proposal-publication-api.js` validates body/auth and then calls `postBondAndPropose`, while `agent/src/lib/tx.js` only checks balances, allowances, simulation success, and receipt reconciliation.

- Observation: `commitmentSafe` is included in the signed proposal envelope and archived artifact, but the onchain submit path ultimately uses `ogModule`, `transactions`, and `explanation`; there is no current check that the submitted proposal is valid for the commitment text.
  Evidence: `agent/src/lib/signed-proposal.js` includes `commitmentSafe`, while `agent/src/lib/tx.js` `postBondAndPropose()` takes `ogModule`, `transactions`, and `explanation`.

- Observation: The signed proposal schema already has `metadata`, which is signed, so new verification inputs can be bound to the signature without redesigning the auth mechanism.
  Evidence: `agent/src/lib/signed-proposal.js` canonicalizes and signs `metadata`, and `agent/src/lib/proposal-publication-api.js` rebuilds the signed payload from request fields before signature recovery.

- Observation: `deadline` already exists in the signed proposal envelope but is not enforced anywhere in the current proposal-node path.
  Evidence: `deadline` is normalized and archived in `agent/src/lib/signed-proposal.js`, but no pre-submit enforcement appears in `agent/src/lib/proposal-publication-api.js` or `agent/src/lib/tx.js`.

- Observation: `first-proxy` already performs several machine-checkable validations that are close to the desired `Agent Proxy` verifier, but those checks are mixed with momentum-strategy specifics and should not be moved wholesale into shared infrastructure.
  Evidence: `agent-library/agents/first-proxy/agent.js` validates reimbursement recipient, token allowlists, explanation fields, price-derived USD values, and deposit linkage around lines 1847-1966, while the same file also includes epoch, winner-token, and momentum-return logic around lines 1414-1533.

- Observation: Batch reimbursement valuation across multiple deposit timestamps needs an explicit mapping from proposal withdrawals back to deposits; aggregate transaction totals alone are not enough to prove correctness when prices differ between deposits.
  Evidence: During implementation, a whole-deposit batch still required per-deposit value ceilings. The shipped v1 verifier therefore requires signed `depositPriceSnapshots` and `reimbursementAllocations` in `metadata.verification` instead of inferring batch allocation from the proposal transactions alone.

- Observation: Local proposal store history is not enough to prevent cross-operator double reimbursement. Deposit reuse checks needed a chain-visible encoding of deposit references so the verifier could inspect all prior `TransactionsProposed` events for the same OG module.
  Evidence: The local store only knows proposals this node has seen, while the OG event stream already exposes proposal lifecycle and the signed `explanation` bytes for all operators.

- Observation: Global onchain proposal history does not remove the need for same-node deposit-scoped locking. Two different signed requests can otherwise verify against the same locally available deposits concurrently before either submission records a reserved or resolved state.
  Evidence: Propose-mode submission queueing originally serialized only by `(signer, chainId, requestId)`, while deposit reuse enforcement is keyed by `depositTxHashes` and depends on persisted proposal state becoming visible before the next verification pass.

## Decision Log

- Decision: Add proposal verification to the existing proposal publication node rather than creating a third standalone node daemon.
  Rationale: The existing node already owns signed request auth, archival, proposal submission, and duplicate handling. A separate daemon would duplicate auth, storage, and runtime resolution, while the real need is to gate the existing propose path.
  Date/Author: 2026-04-12 / Codex.

- Decision: Use the current onchain `ogModule.rules()` text as the only rules source for proposal verification and proposal-time gating.
  Rationale: The node should verify proposals against the commitment rules that are actually live onchain at the time of verification or submission. That removes ambiguity from caller-supplied rule text and keeps `metadata.verification.rulesHash` bound to the same onchain source the node actually evaluates.
  Date/Author: 2026-04-12 / Codex.

- Decision: Bias to `unknown` instead of permissive acceptance whenever the rules text, evidence, or template coverage is incomplete.
  Rationale: False positives here cause incorrect onchain proposals. The node should only auto-submit when it can prove a proposal is valid under the supported verifier profile.
  Date/Author: 2026-04-12 / Codex.

- Decision: Scope v1 to `Agent Proxy` reimbursement verification and explicitly avoid claiming complete general verification for all template combinations.
  Rationale: `Agent Proxy` is the first product target and already has implementation reference points in `first-proxy`. General fee, pause, and rule-update verification can follow after the shared framework exists.
  Date/Author: 2026-04-12 / Codex.

- Decision: Treat batched `Agent Proxy` reimbursements as first-class v1 behavior rather than a future extension.
  Rationale: Agents need to be able to make multiple valid deposits and recover them in a single proposal. A single-deposit-only design would force either inefficient onchain behavior or a later redesign of the verifier’s evidence and accounting model.
  Date/Author: 2026-04-12 / Codex.

- Decision: Use a whole-deposit batch model in v1 rather than partial per-deposit reimbursement accounting.
  Rationale: The implementation and operator model become much simpler if each referenced deposit can be reimbursed only once. A proposal may reimburse equal or slightly less value than the aggregate deposit-time batch value because of deterministic rounding, and that executed proposal still consumes the referenced deposits completely.
  Date/Author: 2026-04-12 / Codex.

- Decision: Keep momentum-specific `first-proxy` logic local to `agent-library/agents/first-proxy/` and extract only truly generic pieces into shared verification code.
  Rationale: The repository’s locality rule forbids leaking one-agent policy into shared infrastructure unless it is clearly cross-agent.
  Date/Author: 2026-04-12 / Codex.

- Decision: Bind verification inputs to the signed request through signed `metadata` fields rather than relying on unsigned auxiliary request parameters alone.
  Rationale: The node should verify the proposal that the originator actually signed, not a modified verification request assembled later by an intermediary.
  Date/Author: 2026-04-12 / Codex.

- Decision: Require signed per-deposit price snapshots and signed reimbursement allocations for `agent_proxy_reimbursement` v1, rather than trying to infer a valid batch allocation from proposal transactions alone.
  Rationale: Whole-deposit batch consumption avoids persistent remaining-balance accounting, but it does not eliminate per-deposit valuation ambiguity when deposits occurred at different timestamps. Explicit signed allocation data keeps the verifier deterministic and auditable.
  Date/Author: 2026-04-12 / Codex.

- Decision: Provide a read-only verification runtime resolver even when the node is not in `propose` mode.
  Rationale: `/v1/proposals/verify` still needs chain access for deposit receipts, token decimals, and proposal lifecycle checks. Requiring a signer-capable propose runtime for read-only verification would unnecessarily limit the endpoint.
  Date/Author: 2026-04-12 / Codex.

- Decision: Encode reimbursement deposit references inside the signed `explanation` as canonical JSON with `kind`, `description`, and `depositTxHashes`, and treat that explanation block as the onchain-readable source for non-local proposal history.
  Rationale: `TransactionsProposed` logs expose the signed explanation bytes onchain, so any node can reconstruct prior reimbursement claims without trusting another node’s local store. Keeping the human-readable summary in `description` preserves operator context without sacrificing machine readability.
  Date/Author: 2026-04-13 / Codex.

## Outcomes & Retrospective

First implementation slice shipped. Current outcome:

- The proposal publication node now exposes `/v1/proposals/verify` and can persist verification results on proposal records.
- The node can run verification in `propose` mode behind `proposalVerificationMode = off | advisory | enforce`.
- The shared verifier can parse standard-template sections, verify signed `agent_proxy_reimbursement` metadata, require structured `explanation` deposit references, inspect referenced deposit receipts, prevent reuse of reserved/consumed deposits from both local records and onchain OG proposal history, and enforce signed reimbursement allocations against deposit-time value ceilings.
- The main remaining product gap is coverage breadth: commitments with additional relevant templates such as `Trade Restrictions`, `Trading Limits`, or pause semantics still resolve to `unknown` instead of `valid`.

## Context and Orientation

Relevant current code paths:

- `node/scripts/start-proposal-publish-node.mjs` is the public `node/` entrypoint. It imports the shared startup path in `agent/scripts/lib/start-proposal-publish-node-main.mjs`.
- `agent/scripts/lib/start-proposal-publish-node-main.mjs` resolves module config, loads the proposal publication store, and starts `createProposalPublicationApiServer()`.
- `agent/src/lib/proposal-publication-api.js` owns the HTTP API for `/v1/proposals/publish`, signed request authentication, IPFS archival, duplicate handling, and optional onchain proposal submission in `propose` mode.
- `agent/scripts/lib/proposal-publish-runtime.mjs` resolves chain-specific runtime config and signer clients for the proposal node.
- `agent/src/lib/tx.js` owns `postBondAndPropose()` and `resolveProposalHashFromReceipt()`. Current checks are technical execution checks, not rule verification.
- `agent/src/lib/signed-proposal.js` defines the canonical signed proposal envelope. It already signs `chainId`, `requestId`, `commitmentSafe`, `ogModule`, `transactions`, `explanation`, `metadata`, and `deadline`.
- `agent-library/RULE_TEMPLATES.md` is the canonical human source for standard-template commitments, including `Agent Proxy`, `Proposal Delegation`, `Solo User`, and `Account Recovery and Rule Updates`.
- `agent-library/agents/default/commitment.txt` is the minimal standard scaffold and proves the repo expects commitments to be assembled directly from template text.
- `agent-library/agents/first-proxy/commitment.txt` is the strongest nearby product example because it includes `Solo User`, `Agent Proxy`, `Trade Restrictions`, `Fair Valuation`, `Trading Limits`, and fee-related templates.
- `agent-library/agents/first-proxy/agent.js` already contains deterministic proposal checks for its own generated reimbursement proposals, including deposit-time price snapshots and reimbursement-value limits, but it currently thinks in terms of one pending deposit per reimbursement cycle rather than a general whole-deposit batch verifier.

Important terminology for this plan:

- Commitment rules text: the exact `commitment.txt` text that defines what a Safe may do.
- Standard template: one rule body in `agent-library/RULE_TEMPLATES.md` with placeholders such as `[AGENT_ADDRESS]`.
- Template parser: code that matches exact rules text against standard-template bodies and extracts concrete values for placeholders.
- Proposal verifier: code that inspects a signed proposal candidate, its evidence, and the parsed rule set, then returns a verdict.
- Coverage: the mapping from parsed templates to verifier support. A template can be enforced, irrelevant to the current proposal kind, or unsupported.

Current limitations that motivate this work:

- The proposal node can authenticate who signed a proposal, but not whether the proposal satisfies the commitment.
- The signed proposal envelope is generic and does not yet define a machine-readable proposal kind or verifier inputs.
- Non-local proposal history is only reconstructable for reimbursement proposals that encode deposit references in the signed `explanation`. Older explanations without that structure remain opaque to global reuse checks.
- The first-proxy agent validates its own deterministic outputs locally, which is useful but not sufficient for a general proposal node that accepts externally supplied signed proposals.

## Requirements Sketch

Functional requirements for v1:

- Provide `POST /v1/proposals/verify` on the proposal publication node.
- Load the current commitment rules text from `ogModule.rules()` onchain during verification.
- Deterministically parse the rules text against supported standard templates and extract placeholder values.
- Return a machine-readable verification result with one of three top-level verdicts: `valid`, `invalid`, or `unknown`.
- Report matched template IDs, extracted parameters, and coverage status so operators can see which parts of the commitment were actually evaluated.
- Support one initial proposal kind: `agent_proxy_reimbursement`.
- For `agent_proxy_reimbursement`, verify that:
  - the signed `explanation` is a canonical JSON string with `kind`, `description`, and `depositTxHashes`;
  - `explanation.kind` and `explanation.depositTxHashes` match the signed metadata exactly;
  - the rules text includes an `Agent Proxy` rule with an authorized agent address;
  - the proposal transfers assets only to the authorized agent for the reimbursement portion;
  - the reimbursement proposal is backed by one or more confirmed agent deposits into the commitment Safe;
  - the verifier can accept a batch of deposit references and compute the aggregate deposit-time reimbursable value across that batch using deposit-time fair valuation snapshots;
  - the reimbursed value is less than or equal to the aggregate deposit-time value from the referenced deposits;
  - if the reimbursed value is slightly less than that aggregate value due to deterministic rounding down, the executed proposal still counts as the only allowable reimbursement for every referenced deposit;
  - repeated or replayed proposals cannot reuse any deposit that is already reserved by a pending proposal or consumed by an executed proposal, including proposals discovered only from onchain `TransactionsProposed` history for the same OG module;
  - any mandatory explanation or signed metadata fields required for deterministic verification are present and internally consistent.
- Reuse the same verification library inside `POST /v1/proposals/publish` when the node runs in `propose` mode.
- Add a config gate so operators can choose whether verification is disabled, advisory, or enforced before onchain submission.
- Persist verification results in the proposal publication store so duplicates and retries remain auditable and deterministic.

Non-functional requirements for v1:

- Deterministic behavior only. Do not use an LLM to decide whether a proposal is valid.
- Safe failure mode. Missing evidence, unsupported templates, or unresolved price data must return `unknown`, not `valid`.
- Backward compatibility. Existing publication flows should keep working when verification is disabled.
- Clear error reporting. Every `invalid` or `unknown` result must include concrete reasons.
- Testability. Parser logic, verifier logic, HTTP API behavior, and propose-mode enforcement must all be covered by automated tests.

Out-of-scope for v1:

- Full verification for arbitrary freeform commitments.
- Full verifier coverage for fee withdrawals, rule updates, pause/unpause actions, or disputes.
- A fully general market-data abstraction across every product. One initial price-source path is acceptable if it is explicit and testable.
- Automatic dispute creation from verification failures.

Proposed v1 request shape:

    POST /v1/proposals/verify
    Content-Type: application/json
    Authorization: Bearer <optional existing node token if configured>

    {
      "chainId": 11155111,
      "requestId": "proposal-123",
      "commitmentSafe": "0x...",
      "ogModule": "0x...",
      "transactions": [
        {
          "to": "0x...",
          "value": "0",
          "data": "0x...",
          "operation": 0
        }
      ],
      "explanation": "{\"description\":\"human-readable proposal explanation\",\"depositTxHashes\":[\"0x...\",\"0x...\"],\"kind\":\"agent_proxy_reimbursement\"}",
      "metadata": {
        "verification": {
          "proposalKind": "agent_proxy_reimbursement",
          "rulesHash": "0x...",
          "depositTxHashes": [
            "0x...",
            "0x..."
          ],
          "depositPriceSnapshots": [
            {
              "depositTxHash": "0x...",
              "depositAssetPriceUsdMicros": "1500000",
              "reimbursementAssetPricesUsdMicros": {
                "0x...": "1000000"
              }
            }
          ],
          "reimbursementAllocations": [
            {
              "depositTxHash": "0x...",
              "reimbursements": [
                {
                  "token": "0x...",
                  "amountWei": "1000000"
                }
              ]
            }
          ]
        }
      },
      "auth": {
        "type": "eip191",
        "address": "0x...",
        "timestampMs": 1760000000000,
        "signature": "0x..."
      }
    }

Proposed v1 response shape:

    {
      "status": "valid",
      "verifiedAtMs": 1760000001234,
      "proposalKind": "agent_proxy_reimbursement",
      "rules": {
        "rulesHash": "0x...",
        "matchedTemplates": [
          {
            "templateId": "agent_proxy",
            "coverage": "enforced",
            "params": {
              "agentAddress": "0x..."
            }
          },
          {
            "templateId": "account_recovery_and_rule_updates",
            "coverage": "not_applicable",
            "params": {
              "requiredSigners": "2",
              "totalSigners": "3",
              "signers": ["0x...", "0x...", "0x..."]
            }
          }
        ],
        "unparsedSections": []
      },
      "checks": [
        {
          "id": "authorized_agent_recipient",
          "status": "pass",
          "message": "All reimbursement transfers target the authorized agent."
        },
        {
          "id": "whole_batch_value_ceiling",
          "status": "pass",
          "message": "Reimbursement value does not exceed the aggregate deposit-time value of the referenced whole-deposit batch."
        }
      ],
      "derivedFacts": {
        "authorizedAgent": "0x...",
        "depositTxHashes": [
          "0x...",
          "0x..."
        ],
        "referencedDeposits": [
          {
            "depositTxHash": "0x...",
            "depositValueUsdMicros": "15000000",
            "allocatedUsdMicros": "10000000",
            "statusBeforeVerification": "available",
            "statusAfterExecution": "consumed"
          },
          {
            "depositTxHash": "0x...",
            "depositValueUsdMicros": "20000000",
            "allocatedUsdMicros": "20000000",
            "statusBeforeVerification": "available",
            "statusAfterExecution": "consumed"
          }
        ],
        "totalBatchDepositValueUsdMicros": "35000000",
        "reimbursementValueUsdMicros": "34950000",
        "roundingShortfallUsdMicros": "50000"
      },
      "reasons": []
    }

Status semantics:

- `valid`: The verifier covered all rules relevant to the selected proposal kind and every enforced check passed.
- `invalid`: The verifier covered the relevant rules and found at least one concrete violation.
- `unknown`: The verifier could not safely decide because parsing coverage, evidence, or price data was incomplete.

## Plan of Work

Implement the feature in four layers so the design stays recoverable and testable.

First, add a deterministic standard-template parser under shared node/agent infrastructure, probably under `agent/src/lib/proposal-verification/` or a similarly named shared directory. This parser should consume the exact current onchain `rules()` text, split it into titled sections, match those sections against canonical template bodies from `agent-library/RULE_TEMPLATES.md`, and extract placeholder values with stable parameter names. This parser must not use fuzzy matching beyond carefully chosen whitespace normalization and placeholder capture rules.

Second, add a shared verification engine that accepts parsed rules, a signed proposal candidate, and verifier-specific evidence. The engine should classify templates into coverage buckets, dispatch to the requested verifier profile, and produce the `valid` / `invalid` / `unknown` result with a full check list. Persist this result in the proposal publication store so the node can reuse it across duplicates and retries.

Third, extend `agent/src/lib/proposal-publication-api.js` to serve a new `/v1/proposals/verify` route and to reuse the same verification engine before submission in `propose` mode. The new route should follow the existing publish API’s JSON parsing, signed request auth, allowlist checks, duplicate rules, and logging style. Add a config flag such as `proposalVerificationMode = off | advisory | enforce` to preserve backward compatibility and give operators a safe rollout path.

Fourth, implement the initial `Agent Proxy` verifier. Use `first-proxy` as a reference implementation only where the logic is genuinely generic: confirmed deposit lookup, deposit timestamp resolution, price snapshot at deposit time, reimbursement-value calculation, recipient checks, and deposit-to-proposal linkage. Extend that shared design to support a batch of deposits, but keep the v1 accounting model simple: each referenced deposit is either available, reserved by a pending proposal, or consumed by an executed proposal. Keep momentum-strategy details such as epochs, winner-token selection, and return calculations out of shared code. If generic helper functions fall out cleanly, extract them from `first-proxy`; otherwise, duplicate small pieces rather than contaminating shared libraries with one-off policy.

## Concrete Steps

1. Create a new shared verification directory under `agent/src/lib/` and add:
   - a standard-template parser module;
   - a result/coverage model module;
   - an `agent_proxy` verifier module;
   - optional shared helpers for price snapshots and deposit evidence normalization.

2. Extend the signed proposal flow so verifier inputs are signature-bound. Preferred approach:
   - keep full rules text out of the signed payload to avoid large signatures;
   - add `metadata.verification.rulesHash`, `metadata.verification.proposalKind`, and any verifier evidence identifiers such as `depositTxHashes` to the signed payload;
   - require the signed `explanation` to carry the same `depositTxHashes` inside canonical JSON so onchain proposal history is self-describing;
   - compute the hash of the current onchain `ogModule.rules()` text in the verification API and require it to match the signed `rulesHash`.

3. Extend `agent/src/lib/proposal-publication-store.js` to record a `verification` subdocument, including:
   - verifier version;
   - verified-at timestamp;
   - verdict;
   - matched templates and coverage;
   - derived facts such as referenced deposit tx hashes, per-deposit valuation snapshots, whole-deposit batch status transitions, and any deterministic rounding shortfall;
   - reasons for `invalid` or `unknown`.

4. Extend the store or adjacent verifier state to track referenced deposit status for v1:
   - `available` before any accepted pending reimbursement proposal uses the deposit;
   - `reserved` while a pending proposal references the deposit;
   - `consumed` after an executed proposal that referenced the deposit;
   - deleted or rejected proposals must release reserved deposits back to `available`.

5. Extend `agent/src/lib/proposal-publication-api.js` with:
   - `POST /v1/proposals/verify`;
   - shared request-preparation code for publish and verify;
   - propose-mode integration that runs verification before `submitProposal` when verification is enabled;
   - response fields that expose stored verification results.

6. Add config parsing and defaults in shared config code, likely in:
   - `agent/src/lib/config.js`;
   - `agent/src/lib/agent-config.js`.

7. Add or update tests. Expected new or changed test entrypoints:
   - `agent/scripts/test-proposal-publication-api.mjs`
   - a new `agent/scripts/test-proposal-verification-api.mjs`
   - a new wrapper `node/scripts/test-proposal-verification-api.mjs`
   - focused parser/verifier unit tests if the shared verification logic becomes large
   - `agent-library/agents/first-proxy/test-first-proxy-agent.mjs` if any generic extraction affects its logic or expected outputs

8. Update operator docs in:
   - `node/README.md`
   - any repo root docs that describe proposal publication and standard-template commitments

Exact commands to use while implementing:

- Working directory: repository root (the directory that contains `AGENTS.md`, `PLANS.md`, `README.md`, `foundry.toml`, `agent/`, `agent-library/`, `node/`, and `plans/`)
- Parser/API regression:
      node node/scripts/test-proposal-verification-api.mjs
- Existing publish regressions:
      node node/scripts/test-proposal-publication-api.mjs
      node node/scripts/test-proposal-publication-store.mjs
- Existing message regressions to catch collateral damage:
      node node/scripts/test-message-publication-api.mjs
      node node/scripts/test-message-publication-store.mjs
- Agent module regression if `first-proxy` is touched:
      node agent-library/agents/first-proxy/test-first-proxy-agent.mjs
- Module config validation if `first-proxy` config or module wiring changes:
      node agent/scripts/validate-agent.mjs --module=first-proxy
- Dry-run config check for node startup:
      node node/scripts/start-proposal-publish-node.mjs --module=first-proxy --dry-run

Expected observable outputs during implementation:

- The verification API returns structured template matches and coverage, not just a boolean.
- In `proposalVerificationMode = enforce`, an invalid or unknown agent-proxy reimbursement returns an HTTP error before onchain submission is attempted.
- In `proposalVerificationMode = advisory`, the publish API still returns archival data plus a stored verification result showing why the proposal was or was not proven correct.

## Validation and Acceptance

Acceptance criteria for the finished feature:

- A verify request against a commitment composed of supported standard templates returns deterministic parsed template matches with extracted parameters.
- A valid `Agent Proxy` reimbursement proposal returns `status = valid` and includes checks proving the reimbursement recipient, deposit linkage, and aggregate valuation ceiling across the referenced deposit batch.
- A valid proposal whose reimbursement is slightly below the aggregate deposit-time value because of deterministic rounding still marks all referenced deposits as single-use once executed.
- An over-withdrawal proposal returns `status = invalid` with a concrete violation reason, including whether the failure came from aggregate batch value or attempted reuse of an already reserved or consumed deposit.
- A commitment containing unsupported or unparsed material rules returns `status = unknown` rather than `valid`.
- In `proposalVerificationMode = enforce`, the proposal publication node refuses to submit invalid or unknown proposals onchain.
- Existing publication behavior remains unchanged when verification mode is `off`.

Minimum automated validation list once implementation exists:

- `node node/scripts/test-proposal-verification-api.mjs`
- `node node/scripts/test-proposal-publication-api.mjs`
- `node node/scripts/test-proposal-publication-store.mjs`
- `node node/scripts/test-message-publication-api.mjs`
- `node node/scripts/test-message-publication-store.mjs`
- `node agent-library/agents/first-proxy/test-first-proxy-agent.mjs` if touched

Recommended targeted test cases:

- Exact match for default `Agent Proxy` scaffold plus `Account Recovery and Rule Updates`.
- Rules text with custom freeform additions that should downgrade the result to `unknown`.
- Signed request whose `metadata.verification.rulesHash` does not match the current onchain `ogModule.rules()` text.
- `Agent Proxy` reimbursement where recipient is not the authorized agent.
- `Agent Proxy` reimbursement where reimbursed value exceeds the aggregate value from the referenced deposit batch.
- `Agent Proxy` reimbursement where one deposit in the batch is valid but another is missing, unconfirmed, or belongs to the wrong sender.
- `Agent Proxy` reimbursement where a later proposal attempts to reuse a deposit already reserved by a pending proposal.
- `Agent Proxy` reimbursement where a later proposal attempts to reuse a deposit already consumed by an earlier executed proposal.
- `Agent Proxy` reimbursement where the proposal reimburses slightly less than the batch total because of deterministic rounding and the deposits still become non-reimbursable after execution.
- Duplicate verify or publish requests that should reuse stored verification results.
- Runtime outage or price-source outage that should produce `unknown`, not `valid`.

## Idempotence and Recovery

Safe retry requirements:

- Verify requests with identical signed proposal contents should be idempotent and should reuse stored verification results when possible.
- Publish requests in `propose` mode must not resubmit a proposal if an identical request already reached `submitted`, `resolved`, or `uncertain`; the current duplicate-handling rules in `proposal-publication-api.js` already provide a foundation and must be preserved.
- If verification persistence fails after a result is computed, the API should surface a clear error and avoid claiming success until the store reflects the final state.
- Deposit status transitions (`available` -> `reserved` -> `consumed`) must be updated atomically enough that a retry cannot silently reuse the same deposit twice. If exact atomic persistence cannot be guaranteed in v1, the API must fall back to `unknown` or an explicit conflict state rather than guessing.

Recovery guidance:

- If parser changes break existing commitments, disable verification with `proposalVerificationMode = off` and rerun the existing proposal publication regressions before re-enabling.
- If the price provider is unavailable, the verifier must return `unknown`; operators can switch to advisory mode or disable verification temporarily rather than bypassing the verdict silently.
- If deposit reservation or consumed status becomes inconsistent with known proposal history, the verifier must return `unknown` or `invalid` and force operator inspection instead of reconstructing state heuristically.
- If implementation extracts helpers from `first-proxy`, validate that `first-proxy` behavior is unchanged before relying on the shared verifier. If regressions appear, revert the extraction and duplicate only the generic logic needed by the shared verifier.

Rollback strategy:

- Keep verification behind config flags during initial rollout.
- Avoid changing the existing signed proposal envelope in a backward-incompatible way. Prefer additive `metadata.verification` fields.
- Land parser/verifier/storage changes before making enforcement the default anywhere.

## Artifacts and Notes

Existing code references that should anchor implementation:

- Proposal node startup: `agent/scripts/lib/start-proposal-publish-node-main.mjs`
- Proposal API: `agent/src/lib/proposal-publication-api.js`
- Proposal submission: `agent/src/lib/tx.js`
- Signed proposal schema: `agent/src/lib/signed-proposal.js`
- Standard rule templates: `agent-library/RULE_TEMPLATES.md`
- Product reference for deterministic validation: `agent-library/agents/first-proxy/agent.js`

Notes on parser strategy:

- Do not parse `RULE_TEMPLATES.md` dynamically on every request. Either compile the templates into a checked-in JS representation or load and cache them at process start.
- Preserve template order in the parse result because some commitments may repeat agent addresses or other placeholder values across multiple rule sections.
- Normalize whitespace and line endings conservatively. If user-authored text diverges materially from the standard template body, return `unknown`.

Notes on proposal kind identification:

- The verifier should not infer proposal kind from prose alone if a signed `metadata.verification.proposalKind` field is available.
- If proposal kind is omitted, the verifier may attempt a deterministic heuristic only if the result is unambiguous. Otherwise return `unknown`.

Notes on batched deposit accounting:

- The verifier should model each referenced deposit as a whole-deposit entry with at least `depositTxHash`, signer, deposit-time valuation, and a simple status lifecycle such as `available`, `reserved`, or `consumed`.
- The consumption model should allow one reimbursement proposal to span multiple deposits, but it should not allow partial reuse of any deposit after an executed covering proposal.
- A proposal may reimburse slightly less than the aggregate deposit-time batch value because of deterministic rounding down; that shortfall is tolerated, but the referenced deposits still become fully consumed after execution.
- For the current signed proposal, `explanation.depositTxHashes` and `metadata.verification.depositTxHashes` must match exactly.
- For non-local proposal history, the verifier should derive deposit membership from onchain structured explanations in `TransactionsProposed` logs, then reconcile lifecycle with executed/deleted events and local store state.

Potential follow-on verifiers after v1:

- Fee withdrawal verifier for `Recurring Fee` and `Performance Fee`.
- Rule-update verifier for `Account Recovery and Rule Updates`.
- Pause/unpause verifier for `Commitment Pause`.

## Interfaces and Dependencies

Files likely to change:

- `agent/src/lib/config.js`
- `agent/src/lib/agent-config.js`
- `agent/src/lib/proposal-publication-api.js`
- `agent/src/lib/proposal-publication-store.js`
- `agent/src/lib/signed-proposal.js` if additive signed metadata helpers are needed
- new shared verification modules under `agent/src/lib/`
- `node/README.md`
- test entrypoints under `agent/scripts/` and `node/scripts/`
- possibly `agent-library/agents/first-proxy/agent.js` and its tests if generic helpers are extracted

Existing interfaces this work must respect:

- `createProposalPublicationApiServer()` request auth and duplicate semantics
- `postBondAndPropose()` return shape and side-effect tracking
- proposal publication store record normalization and persistence invariants
- repository locality rule: agent-specific policy stays local unless clearly shared

Dependencies and runtime assumptions:

- EVM RPC access is required for receipt lookup, deposit verification, and onchain proposal simulation.
- Price resolution requires a deterministic source. The initial implementation may reuse the first-proxy Alchemy price path if extracted cleanly, or it may define a new shared abstraction with one initial provider.
- If a shared price path uses Alchemy, document the required API key or derivation path explicitly and include a mockable test strategy so CI does not require live network access.
- No browser or frontend surface is required for v1.

Environment and config additions to define during implementation:

- `proposalVerificationMode` or an equivalent config flag with at least `off`, `advisory`, and `enforce`.
- Optional price-provider config if the shared verifier cannot reuse existing `firstProxy.priceFeed` settings cleanly.
- Optional verifier version string for persisted results and auditability.
