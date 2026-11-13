# Deliver an offline, reviewable testnet peer directory

This living ExecPlan follows `PLANS.md`. Feature ID: `peer-directory-v1`.

## Purpose / Big Picture

Operators and reviewers can validate and compare public directory snapshots without contacting peers or changing node authorization. A repository-hosted, initially empty testnet directory establishes a reviewed source of public routing data. An offline CLI exposes exact-byte SHA-256 checksums, normalized content hashes, revisions, public records and added/removed/changed identities. CI enforces revision progression. Release bundles carry the snapshot and source/checksum metadata.

This is a bounded prerequisite of `plans/peer-node-network-execplan.md`, not that plan's full peer network. No runtime config integration, signer policy, delivery, key access, enrollment, deployment or chain operations are included.

## Progress

- [x] 2026-11-13: Read repository guidance, merged plan #142, ledger proposal #137, dialogue Q001–Q006, current source, recent merges and complete open-PR inventory.
- [x] 2026-11-13: Selected offline directory milestone and isolated a branch from upstream main.
- [x] 2026-11-13: Implemented strict schema, bounded loader, deterministic inspection/comparison CLI and Git-base CI checks.
- [x] 2026-11-13: Added empty bootstrap snapshot and release metadata, updated upgrader allowlist; first focused run passed 94 tests.
- [x] 2026-11-13: Focused success/failure/recovery and packaging tests passed (97); full production suite passed on Node 24.22.3 (459 tests, no skips/failures). Syntax and whitespace checks passed.
- [x] 2026-11-13: Completed separate self-review, fixed sparse-array handling and trailing-dot endpoint aliases, and rechecked all open PRs; no substantial feature or overlapping paths.
- [x] 2026-11-13: Published PR #161; review follow-up remains local for parent review and publication.
- [x] 2026-11-13: Reproduced all three Codex findings with regressions (79 pass, 3 fail before fixes); pinned the release fallback base, rejected duplicate JSON names and restored checksummed comparison records.
- [x] 2026-11-13: Follow-up validation passed 100 focused tests and 462 complete production tests on Node 24.22.3, with no failures or skips.
- [ ] Parent independently reviews and publishes the local follow-up commit; human review/merge remains required.

## Surprises & Discoveries

Review follow-up confirmed that a release-dispatch reusable CI call had no event base and silently took the schema-only path. A fixture with unbumped membership passes that path but fails base-aware validation. `JSON.parse` discards duplicate names, including Unicode-escaped equivalents, before object-field validation; the original text must also be checked. Comparison used normalized hash records for display and lost checksum casing.

The full peer plan is merged at `90f2d3fcbaab3f0c0a0c3853313a01e6f4320878` (2026-11-07). It retains an earlier separate-plan-approval gate. The user's current instruction explicitly authorizes this bounded implementation without routine plan approval; it does not authorize deployment or completion of the remaining network milestones. Pemulis's public direction in PR #142 comment 6712305115 requires a repository registry and reviewed enrollment, not an invented live roster. None has been supplied, so `nodes` must start empty.

The npm 12 `npx --package=node@24` invocation reported the installed Node 26 rather than the requested runtime. Re-running through the bundled npm launcher reported Node 24.22.3 and the entire production suite passed there; validation records use the observed runtime, not the requested version.

The release upgrader has an explicit public-file allowlist. New bundle assets must be added there and exercised through the real archive verifier. Existing runtime configuration rejects unknown fields, which remains intentional.

## Decision Log

- 2026-11-13 / Oya Gardener review follow-up: Pass the exact checked-out source’s first-parent SHA from release preflight to a required reusable-workflow input. Fetch two commits and fail preflight if that parent is unavailable. Ordinary standalone manual CI keeps its explicit schema-only behavior.
- 2026-11-13 / Oya Gardener review follow-up: Keep native JSON grammar validation, then scan the intact bounded text with an iterative object-scope stack and decoded name sets before schema validation. Reject duplicate names using the existing sanitized JSON error, without new dependencies. Return checksummed parsed records in comparisons; retain normalized identity matching and content hashing.

- 2026-11-13 / Oya Gardener: Implement only offline validation/inspection and review distribution. The full peer-policy/outbox/transport feature cannot safely fit this milestone's bounded review budget. Q001 emphasizes hardened home-node security; Q006 supports specializing nodes in logging and verification.
- 2026-11-13 / Oya Gardener: Reuse already installed ethers address checking, with strict hex input and nonzero checks. No dependency or generated-output changes.
- 2026-11-13 / Oya Gardener: Maintain separate exact-byte checksum and normalized content hash. Formatting, node ordering and address casing are not membership changes. Revision changes must be monotonic; domain changes are rejected in comparisons and need a new directory/network migration. Neither hash proves upstream provenance, freshness, endpoint ownership or safe network routing.
- 2026-11-13 / Oya Gardener: CLI outputs sanitized JSON, exit 0 for success, 1 for validation/revision failure and 2 for usage errors. It never prints raw input on failures. Empty directory is valid bootstrap data but explicitly not a runnable peer network.

## Outcomes & Retrospective

Review follow-up resolves all three reported defects. Regression coverage executes the workflow shell blocks in disposable Git repositories (stale revision, corrected revision, unavailable base and missing parent), rejects duplicate names at all schema levels through decoding/CLI/Git-base paths, and verifies checksummed added/removed/updated records without treating casing-only edits as content changes. Current results supersede the original counts below: 100 focused and 462 full production tests pass on Node 24.22.3. Hosted Actions and Docker/PostgreSQL/live-chain integration were not executed during this offline follow-up.

Offline schema/inspection/comparison, exact Git-base revision CI, the empty official registry, and release checksum/source metadata are implemented and exercised. The full production suite passed 459 tests on Node 24.22.3; focused validation passed 97 tests on Node 26.12.1. Real Git/archive extraction and upgrade verification are tested with Docker/network responses stubbed. No runtime build step exists for these standalone `.mjs` files; Node syntax checks, Python AST parsing, shell syntax and `git diff --check` passed. Docker/PostgreSQL/live-chain integration was not rerun because runtime behavior and image inputs are unchanged.

A separate self-review corrected sparse in-memory arrays and trailing-dot hostname aliases before final validation. Independent review could not be delegated in this session; no claim of independent approval is made. Human review/merge remains required. Inspection changes no production files or running services. The larger network plan remains deliberately incomplete.

## Context and Orientation

Production node code is under `node/production`. The existing inbox accepts signed jobs at `/v1/jobs`; directory records pair Ethereum node addresses with that HTTPS endpoint and inbox target. The Ledger domain is the chain ID plus Ledger contract, not proof of actual deployment. `src/defaults.mjs` holds existing Sepolia defaults. `src/peers/directory.mjs` will be standalone and imported only by the offline CLI/tests. `scripts/peer-directory.mjs` will expose `inspect FILE` and `compare BASE CANDIDATE`. `scripts/check-peer-directory.mjs` will compare a Git base snapshot in CI without a shell or network request. `scripts/publish-image.sh` assembles release archives; `scripts/upgrade-node.py` verifies their public contents.

## Plan of Work

First add pure schema validation, a bounded regular-file reader and deterministic comparison functions with strict identity/endpoint/target uniqueness. Then expose inspection and revision checks through CLI entrypoints. Add the empty official registry at `node/production/peers/testnet-directory.json` and contribution guidance. Connect the CI base revision check and release provenance metadata, retaining older-bundle support. Finally add negative, recovery and packaging tests, review all changed files, and publish after a fresh open-PR overlap gate.

## Concrete Steps

From the repository root with Node 24 and Python 3:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node node/production/scripts/peer-directory.mjs inspect node/production/peers/testnet-directory.json
    node node/production/scripts/peer-directory.mjs compare node/production/peers/testnet-directory.json node/production/peers/testnet-directory.json
    node --test node/production/test/peer-directory*.test.mjs node/production/test/publish-image.test.mjs
    npm --prefix node/production test
    bash -n node/production/scripts/publish-image.sh
    git diff --check

The CLI should report an empty bootstrap, two distinct hashes and unchanged comparison; no DNS, HTTP, signer, database or configuration writes. CI uses a full base commit SHA supplied as an argument, retrieves the base registry through Git, and requires advancement for changed content. Initial introduction is allowed only with revision 1 and an empty roster. Existing base registry errors must fail closed, not be treated as absent.

## Validation and Acceptance

Test valid boundaries; unknown fields at each level; wrong types, zero/checksum-invalid addresses; ASCII IDs and targets (including final newline); duplicate addresses/endpoints/targets; strict HTTPS URLs without normalization escapes, credentials or query/fragment; bounded node count and bytes; invalid UTF-8/JSON, symlink/FIFO/directory/missing/truncated reads; changed, unchanged, backwards and domain-changing revisions; added/removed/rotated records; deterministic output and input immutability. CLI subprocess tests exercise sanitized failure followed by recovery without rewriting input. Git fixtures cover initial creation, deletion, unavailable base and revision violations. Packaging tests extract actual archives and verify exact source bytes, commit/checksum binding and acceptance by the upgrader. Full production tests protect existing behavior. There is no build step for these `.mjs` files; use syntax checks and tests. No external service validation is needed for an explicitly offline feature.

## Idempotence and Recovery

All validation commands are read-only and repeatable. Invalid data remains untouched; fix a candidate explicitly and rerun. Never silently download, trim or repair an identifier. A reverted membership edit must be a new reviewed higher revision, not a rollback to an old numeric revision. Bundles are pinned historical artifacts, not automatic membership updates. Rollback of this feature reverts CLI/CI/assets only; runtime permissions and database state are unchanged. Real future enrollment requires owner evidence, review and coordinated full-snapshot rollout on both roles under the later peer-policy milestone.

## Artifacts and Notes

Open #160 is an 18-line fee-parser bugfix, #159 is dialogue documentation and #22 is legacy agent predicate/hydration work with a stale base; none is a substantial production node feature or edits these proposed paths. #153 is merged. No open PRs will be edited or commented by this task. Count all implementation/test/script/config/JSON line additions and deletions against 3,000; count Markdown separately. Independent delegation is unavailable in this session; perform and label a separate self-review rather than claiming independent review.

## Interfaces and Dependencies

`parsePeerDirectory(raw)` returns a deeply frozen, checksummed snapshot. `loadPeerDirectory(path)` returns the snapshot and exact file SHA-256. `inspectPeerDirectory(snapshot)` produces stable public fields and normalized content hash. `comparePeerDirectories(base, candidate)` enforces immutable network/execution domain and monotonic revision, returning sorted added/removed/changed records. Node standard library and the existing pinned ethers dependency are sufficient. No environment variables, secrets or network connectivity are required for offline operations.
