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
- [ ] Independent review and human merge; release and deployment remain separate operations.

## Surprises & Discoveries

The initial milestone made review of a trusted temporary address book harder than editing the list. Revision fixtures also depended on the mutable official roster. Separate schema-only and base-aware CI paths could disagree, while existing release CI reuse accepted a successful run for the same commit. Removing the introduced domain/revision policy removes both defects without changing preexisting release gates.

The inbox protocol needs a `target` as well as a receive URL. Keep that routing field so a listed endpoint is useful; do not turn the list into a new signed-message or permission format. No bootstrap roster has been supplied, so the official array remains empty.

## Decision Log

- 2026-11-14 / Oya Gardener, following pemulis: Trust normal repository review for addresses and endpoints. Remove custom schema enforcement, JSON duplicate-name scanning, revision/domain comparison, hashes, snapshot metadata and registry-specific CI. Keep only JSON/required-string checks to catch accidental wrong files or failed downloads.
- 2026-11-14 / Oya Gardener: Choose the requested easy-fetch workflow rather than changing runtime startup permissions. A no-argument helper loads the shipped list; `fetch` retrieves only the fixed official upstream URL and prints JSON. It never writes configuration or contacts listed peers.
- 2026-11-14 / Oya Gardener: Retain the existing release checks and strict public bundle allowlist. Replace the PR's generated snapshot metadata with the standalone helper in that allowlist, retaining older-bundle support.
- 2026-11-14 / Oya Gardener: Keep runtime peer-policy integration as the next feature proposal, not an implicit side effect of this registry change.

## Outcomes & Retrospective

The implementation is now a small trusted address book and an operator loading/fetching workflow. The original review tooling was unnecessary for this milestone. `target` remains because the current inbox requires it; network/execution-domain policy belongs to the later runtime feature, not this file. Validation passed on Node 24.22.3: 25 focused and 387 full production tests, with no failures or skips. Real fixture archives pass the strict upgrade verifier and their packaged helper runs without dependencies. A populated-roster mutation also passed all 25 focused tests. A temporary overlay of the current-main fee fix passed 388 full production tests and was restored afterward; this follow-up retains the original PR parentage. Fetch responses are mocked; the official file becomes available only after merge. Docker/PostgreSQL/live-chain integration was not run locally. Independent review and human merge remain pending.

## Context and Orientation

`node/production/peers/testnet-directory.json` is an array of `{nodeAddress, receiveUrl, target}` records. `nodeAddress` is the public Ethereum node identity; `receiveUrl` is the public HTTPS `/v1/jobs` endpoint; `target` is the inbox's destination name. `peers/README.md` documents edits and loading/fetching. `scripts/peer-directory.mjs` reads the bundled file relative to itself, accepts a local filename, or fetches the fixed official GitHub raw URL. It uses only Node built-ins, a ten-second fetch deadline and redirect rejection.

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

**peer-policy-v1 — consistent inbox/worker peer authorization.** Consume this simple registry through an explicitly enabled, shared policy for both roles; keep manual agent grants, self/target identity, locally configured network/chain/Ledger identity, authenticated policy agreement and admission-only maintenance for safe updates. Keep signature/domain checks at the message authorization boundary, not in registry enrollment proofs or revision CI. Acceptance must cover mismatched/old roles, unknown signers, overlapping manual grants, malformed signed messages and draining/recovery using disposable fixtures. Estimate 1,800–2,700 added/deleted code lines, capped at 3,000. Reconcile the remaining proposal in `peer-node-network-execplan.md` before implementation; outbound delivery/outbox and deployment remain separate. This follow-up implements none of that next feature.
