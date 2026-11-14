# Deliver a minimal testnet peer registry

This living ExecPlan follows `PLANS.md`. Feature ID: `peer-directory-v1`.

## Purpose / Big Picture

Keep the repository's trusted public node addresses and receive endpoints in a simple JSON list. Operators can load the bundled list or explicitly fetch the current upstream list using a dependency-free helper. Registry data is an address book, not an authorization policy: existing inbox/worker signature checks and explicitly configured `allowedSigners` remain the authority.

## Progress

- [x] 2026-11-13: Implemented and published the original offline directory milestone as PR #161, then corrected initial review findings. That implementation's schema, revisions, hashes and comparison CI are superseded below.
- [x] 2026-11-14: Read pemulis's review 5899973061 and comment 6868468543 requesting a minimum viable trusted repository registry and an updated ExecPlan.
- [x] 2026-11-14: Reproduced Codex findings 4570003511 and 4570003520 before simplification: a legitimate revision-2 roster breaks the introduction fixture; a changed domain passes without a base but fails base-aware validation.
- [x] 2026-11-14: Replaced that machinery with a plain list and `list`/`fetch` helper, packaged the helper with the list, and restored preexisting CI/release workflows.
- [x] 2026-11-14: Node 24.22.3 validation passed: 25 focused and 387 complete production tests, no failures or skips. Packaging/upgrader and the documented save/retry workflow are exercised with local fixtures.
- [x] 2026-11-14: Independent review found no blockers and independently reran all 25 focused and 387 production tests. Corrected its shell-example exit-status nit and verified failure propagation.
- [x] 2026-11-14 02:55Z: Reproduced founder comment 4570974007 with the requested `url` fixture: local-list and mocked-fetch tests both rejected it before the helper change. Renamed the registry field in the helper, fixtures, guide and both plans; added missing/empty/non-string `url` rejection cases. All 25 focused registry/packaging tests pass on Node 24.22.2 and 26.12.1.
- [x] 2026-11-14: Assessed founder comment 4570981899 requesting automatic testnet peer grants against inbox admission and worker reauthorization. Runtime grants remain unimplemented in this review follow-up.
- [x] 2026-11-14: Incorporated pemulis's clarification 4571135806: registry peers need message-only inbox acceptance, not IPFS publication or onchain transaction authority. Superseded the automatic publication-grant candidate below; no runtime change made.
- [x] 2026-11-14: Candidate revision v2 incorporates pemulis comments 4571803463, 4571811963 and 4571834696: receiver-local policy may queue publication; optional batching is preferred next, with periodic peer test messages as an alternative. Supersedes the prior message-only isolation candidate; documentation only.
- [ ] Human review and merge; release and deployment remain separate operations.

## Surprises & Discoveries

The initial milestone made review of a trusted temporary address book harder than editing the list. Revision fixtures also depended on the mutable official roster. Separate schema-only and base-aware CI paths could disagree, while existing release CI reuse accepted a successful run for the same commit. Removing the introduced domain/revision policy removes both defects without changing preexisting release gates.

The inbox protocol needs a `target` as well as a receive URL. Keep that routing field so a listed endpoint is useful; do not turn the list into a new signed-message or permission format. No bootstrap roster has been supplied, so the official array remains empty.

The requested `url` records failed both local loading and mocked upstream fetching with exit 1 (`Unable to load peer registry`) before the rename. The worker reads its signer list from raw node input (`src/inbox/worker.mjs`), while inbox admission uses parsed inbox configuration. Updating only one parser would allow admission/processing disagreement; revoking a signer can also block reconciliation of an already checkpointed transaction because worker authorization runs first.

## Decision Log

- 2026-11-14 / Oya Gardener, following pemulis: Trust normal repository review for addresses and endpoints. Remove custom schema enforcement, JSON duplicate-name scanning, revision/domain comparison, hashes, snapshot metadata and registry-specific CI. Keep only JSON/required-string checks to catch accidental wrong files or failed downloads.
- 2026-11-14 / Oya Gardener: Choose the requested easy-fetch workflow rather than changing runtime startup permissions. A no-argument helper loads the shipped list; `fetch` retrieves only the fixed official upstream URL and prints JSON. It never writes configuration or contacts listed peers.
- 2026-11-14 / Oya Gardener: Retain the existing release checks and strict public bundle allowlist. Replace the PR's generated snapshot metadata with the standalone helper in that allowlist, retaining older-bundle support.
- 2026-11-14 / Oya Gardener: Initially kept runtime peer-policy integration as the next feature proposal, not an implicit side effect of this registry change; the v2 candidates below supersede that priority.

- 2026-11-14 / Oya Gardener, following pemulis comment 4570974007: Use `url` for the registry endpoint field; retain the existing required-string checks and signed-job protocol.
- 2026-11-14 / Oya Gardener: Initially interpreted pemulis comment 4570981899 as automatic testnet publication grants; this interpretation is superseded by clarification 4571135806.
- 2026-11-14 / Oya Gardener, following pemulis clarification 4571135806: Previously proposed an isolated message-only receive path without publication effects. The v2 clarification below supersedes that categorical isolation requirement, while preserving the prohibition on publication authority granted solely by registry membership.
- 2026-11-14 / Oya Gardener, following pemulis (user ID 1646497) in PR #161 thread 4570981899: [4571803463](https://github.com/oyaprotocol/oya-commitments/pull/161#discussion_r4571803463) permits the receiving node to queue publication under its own local policy; [4571811963](https://github.com/oyaprotocol/oya-commitments/pull/161#discussion_r4571811963) prefers optional batched onchain logging; [4571834696](https://github.com/oyaprotocol/oya-commitments/pull/161#discussion_r4571834696) offers optional periodic peer test messages as an alternative. The earlier zero-publication requirement overstated intent: peers must not directly control IPFS/transactions or acquire publication `allowedSigners` solely through membership. These are informational candidates, not runtime changes.

## Outcomes & Retrospective

The implementation is now a small trusted address book and an operator loading/fetching workflow. The original review tooling was unnecessary for this milestone. `target` remains because the current inbox requires it; network/execution-domain policy belongs to the later runtime feature, not this file. Validation passed on Node 24.22.3: 25 focused and 387 full production tests, with no failures or skips. Real fixture archives pass the strict upgrade verifier and their packaged helper runs without dependencies. A populated-roster mutation also passed all 25 focused tests. A temporary overlay of the current-main fee fix passed 388 full production tests and was restored afterward; this follow-up retains the original PR parentage. Fetch responses are mocked; the official file becomes available only after merge. Docker/PostgreSQL/live-chain integration was not run locally. Independent review found no blockers and independently reran the focused and full suites; human review and merge remain pending.

The field-rename follow-up passes the same 25 focused tests on Node 24.22.2 and 26.12.1, including packaged-helper and refresh/retry fixtures. `node --check node/production/scripts/peer-directory.mjs` and `git diff --check` pass; the default CLI still prints `[]`. The parent also reran all 387 production tests on Node 24.22.2 after the rename: no failures or skips. The subsequent message-only clarification was a documentation correction, not implemented runtime functionality. Existing `/v1/jobs` admission queues publication work, and `processWork` publishes to IPFS before any Ledger processing; neither is a message-only handler. The Sepolia publication-grant question is superseded: registry membership must not itself grant publication authority on any chain. Runtime peer reception remains future work; preserve existing explicit publication grants and pending-transaction recovery. That earlier documentation correction passed required-heading and local-link checks and `git diff --check`; independent review found no blockers, and its path/link formatting nits were corrected. Runtime tests were not rerun for that correction. All seven hosted checks passed on the preceding implementation head `5e7acfe`; that result does not claim CI for subsequent documentation commits.

Revision 2026-11-14 v2 corrects the receive/publication distinction: a receiving node MAY queue publication when its LOCAL policy chooses it. Optional batching is the preferred next candidate; optional periodic peer tests are an alternative. Neither candidate is implemented here, and the earlier unconditional zero-publication acceptance requirement is withdrawn. Both plans pass all twelve required-heading checks, twenty local-link checks, JSON example parsing and `git diff --check`; runtime tests were not rerun for this documentation-only revision.

## Context and Orientation

`node/production/peers/testnet-directory.json` is an array of `{nodeAddress, url, target}` records. `nodeAddress` is the public Ethereum node identity; `url` is the public HTTPS `/v1/jobs` endpoint; `target` is the inbox's destination name. `peers/README.md` documents edits and loading/fetching. `scripts/peer-directory.mjs` reads the bundled file relative to itself, accepts a local filename, or fetches the fixed official GitHub raw URL. It uses only Node built-ins, a ten-second fetch deadline and redirect rejection.

`scripts/publish-image.sh` includes the public list, guide and helper in deployment bundles. `scripts/upgrade-node.py` names those exact public files in its existing allowlist. `test/peer-directory.test.mjs` exercises fixed synthetic records and subprocess behavior; `test/publish-image.test.mjs` extracts real fixture archives and runs the packaged helper. Runtime modules, signing, configuration and database schemas are untouched.

## Plan of Work

Replace the introduced parser/comparer and CI base checker with the standalone list/fetch helper. Keep the official list empty until maintainers add real public records through normal review. Restore both workflows to their pre-feature behavior. Package the helper and test real extraction/upgrader compatibility. Update operator instructions and the broader network plan so the next implementation does not recreate the removed registry machinery. Complete production regression tests and review the whole diff before local commit.

## Concrete Steps

From the repository root with Node 24 and Python 3:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node node/production/scripts/peer-directory.mjs
    node --test node/production/test/peer-directory.test.mjs node/production/test/publish-image.test.mjs
    npm --prefix node/production test
    node --check node/production/scripts/peer-directory.mjs
    bash -n node/production/scripts/publish-image.sh
    git diff --check

The default command prints the included JSON array. Once merged, `node node/production/scripts/peer-directory.mjs fetch` prints the latest upstream array. Before merge that URL may not exist; tests substitute HTTP responses without requiring publication. Follow the temporary-file-and-rename example in `peers/README.md` to save updates safely.

## Validation and Acceptance

The no-argument command must work from any current directory and in an extracted bundle without installed dependencies. Fixed fixtures cover nonempty/empty lists, malformed or missing files, bad arguments, upstream HTTP failure, invalid JSON/records, transport failure, response-body failure, deadlines and successful retry. The documented save workflow must preserve an existing copy on failure and replace it on success. Tests must remain valid after maintainers add records to the official list. Packaging tests retain source/tag/digest checks and exercise the strict upgrade verifier. Run the complete production suite to protect existing authorization and signing behavior. Docker/PostgreSQL/live-chain runs are not required for this address-book helper; do not claim they ran locally.

## Idempotence and Recovery

Loading/fetching is read-only and repeatable. A failed command emits no list, exits nonzero and leaves files alone. Save to a temporary file first, then rename only on success; a failed fetch leaves the previous copy usable. Maintainers can revert a list edit through ordinary Git review without managing a separate numeric revision. Reverting this feature changes public tooling/assets, not runtime permissions or stored jobs.

## Artifacts and Notes

Review feedback and pre-change reproductions are recorded in the PR discussion and local validation artifacts. Count all added/deleted implementation, JSON, tests, scripts and configuration against the 3,000-line limit; report Markdown separately. Final logs and proposed replies stay outside Git. Existing PR #161 remains the review vehicle.

## Interfaces and Dependencies

`peer-directory.mjs [list [FILE] | fetch]` prints a JSON array on success. Exit 0 means success, 1 means loading failed, and 2 means incorrect arguments. No package dependency or environment variable is added. The helper requires Node.js; online fetching additionally requires HTTPS access to the official GitHub source. It does not load keys, grant permissions or send peer jobs.

## Next feature candidate after merge

**Candidate revision 2026-11-14 v2 — optional batched onchain logging (preferred).** Publish each authorized message separately to IPFS, publish a manifest gathering those message content identifiers (CIDs), then log the manifest CID onchain. Make batching opt-in with configurable message-count and elapsed-time-since-last-log thresholds; retain immediate per-message publication/logging as the default. This supersedes `peer-inbox-messages-v1`'s message-only isolation candidate and the earlier `peer-policy-v1` publication-grant proposal, not their recorded history.

Design must specify manifest format and binding to exact message CIDs/signed content and publishing context; threshold interaction, timer initialization and flush behavior; durable batch membership and checkpoints; crash/retry/idempotency and pending-transaction recovery; and bounded batch size, storage and resources. Acceptance must exercise count/time triggers, the unchanged immediate default, manifest binding/tampering, partial IPFS/manifest/transaction failures, restart/checkpoint recovery and policy/authorization failures without duplicate logical logs. No API, configuration keys or fixed estimate are established by this candidate.

**Alternative — optional periodic peer test messages.** A node may opt into sending bounded periodic signed test messages to registry peers; each receiver recognizes valid messages and decides publication/logging under its LOCAL policy. Reception MAY queue publication when that policy chooses it; membership alone must neither append peers to publication `allowedSigners` nor give peers direct IPFS/transaction control. Design authentication, operation/domain/target binding, scheduling, retention and receiver-policy enforcement before implementation; do not assume the current `/v1/jobs` publication operation is already a peer-message API. Test policy-allowed publication/logging and policy-denied absence of publication effects, unknown/revoked signers, invalid signatures, replay conflicts, wrong domain/target, expired/oversized input, restart/deduplication and bounded traffic/storage. A separate explicit publication grant must not bypass peer-operation checks. Periodic sends must not become automatic replies, forwarding loops or execution of received instructions.

Both candidates preserve existing explicit agent grants, worker credentials, signing boundaries and pending-transaction recovery. Reuse the trusted list without registry revisions or enrollment proofs. Re-estimate the selected scope within the 3,000-code-line feature cap; the former 1,800–2,700-line estimate remains withdrawn. The daily feature job alone may select the next feature after this PR merges, without a separate plan-approval gate; hourly follow-up must not start it. No new runtime work, deployment, enrollment or public-chain spending is authorized by this documentation correction.
