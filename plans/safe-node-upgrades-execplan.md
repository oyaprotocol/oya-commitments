# Upgrade node releases without replacing operator state

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

Node runners should be able to select a published node release, preview its effect, and replace the inbox and worker application images without resetting configuration, identities, credentials or storage. The inbox is the HTTP queue backed by PostgreSQL; the worker processes that durable queue and publishes content to Kubo, the IPFS service. Ledger workers additionally save signed transaction checkpoints in PostgreSQL before broadcast. Those checkpoints must survive failures and upgrades.

The deliverable is a Python 3 standard-library command, operator instructions, release packaging and automated tests. A separately authorized installation upgrade provides real operational evidence; private installation records and secrets remain outside this repository.

## Progress

- [x] 2026-11-08: Inspected the published node-v0.4.0 release, existing deployment guides, Compose layouts, Keychain helper and transaction recovery behavior; created an isolated branch from main.
- [x] 2026-11-08: Checked existing PRs. PR #145 automates producing releases; this work consumes already-published releases. Packaging and operator-document edits need a final overlap check.
- [x] 2026-11-08: Upgraded both application services to verified v0.4.0. Preserved three original complete job rows, four original IPFS pins and DAGs, peer identity, private configuration/key hashes, and dependency container identities. Restored the database dump and IPFS snapshot in isolated/offline fixtures. One new offline-queued smoke job published on its first attempt with exact content and unchanged duplicate result.
- [x] 2026-11-08: Implemented the Python CLI with preview/apply/quiesce actions, verified artifacts and image identity, preserved selectors/storage, coordinated role acknowledgements, Keychain lifecycle and retained failure records.
- [x] 2026-11-08: Packaged the helper and upgrade guide; aligned README, local/inbox guides and deployment-agent instructions. Packaging and existing Keychain tests passed.
- [x] 2026-11-08: Passed 43 focused Python safety tests and all 9 existing PostgreSQL integration tests. Real CLI previews passed on both running installations without mutation. A disposable two-project HTTPS installation upgraded from v0.3.1 to v0.4.0 through the new CLI, retaining original job result, exact IPFS content, configuration/key hashes, dependency container IDs, backup and recovery journals.
- [x] 2026-11-08: Addressed review findings: verify classic/containerd image identity plus platform, reject alternate application config arguments, sync retained assets/backups before saving selectors, and preserve sanitized failure phase. Quiesce reports its recovery directory; a broken success-output pipe cannot stop a verified node.
- [x] 2026-11-08: Final-source validation passed 48 Python safety tests and 280 production tests. A real-Docker Keychain-lifecycle fixture (credential lookup stubbed) upgraded v0.3.1 to v0.4.0, restored the helper's dump into an isolated database, and retained complete rows and signed-transaction canary bytes across a lost startup acknowledgement and deliberate reconciled retry.
- [x] 2026-11-08: The final ordinary-worker real-Docker run also passed dump restoration, exact row/checkpoint preservation, injected uncertain startup and reconciled retry.
- [x] 2026-11-08: Follow-up review cleared the previous findings and identified an ancestor-directory durability gap. Three focused regressions failed before the fix; the recovery root is now synced through its installation directory before stopping services or replacing selectors. All 50 Python tests, 280 production tests and 9 PostgreSQL integration tests passed afterward.
- [x] 2026-11-08: Final-source real-Docker confirmation passed after the parent-directory sync fix, including both role upgrades, isolated dump restoration, Keychain cleanup and uncertain-startup recovery. Implementation and validation are complete and ready for review.
- [x] 2026-11-08: Reproduced PR #146 review findings: inconsistent Git tag/manifest revisions were accepted, and the original suite failed three Keychain cases under UID 0. Added exact tag-ref resolution with bounded annotated-tag peeling and scoped test-only UID simulation. All 56 Python tests pass on macOS and in a disposable root Linux container; all 280 production tests pass on Node.js 24. Syntax checks and read-only verification of the official v0.4.0 Git tag also pass.
- [ ] Human review and merge.

## Surprises & Discoveries

Release metadata, uploaded manifests and OCI labels can agree while the Git tag points elsewhere. The upgrader now independently resolves the official tag ref before extracting assets. Root-container testing also showed that a blanket nonzero UID mock would conflict with real file ownership; only the Keychain selection call simulates a non-root macOS user. Production ownership and root rejection checks remain exercised.

The existing deployment uses explicitly selected IPFS-only mode. Version 0.4.0 changes new-installation defaults to Sepolia, not existing execution identities. Copying new example configuration during upgrade would be unsafe. The selected release has no database migration, and its bundled Kubo/PostgreSQL/proxy definitions match the previous release. Upgrading only the application services avoids unnecessarily recreating these dependencies.

Real-Docker validation caught two mismatches that mocked fixtures initially missed: rendered Compose null command/entrypoint fields mean inherit image defaults, and the containerd image store identifies an image by its manifest/index digest rather than the classic image-config digest. Red-capable regressions now cover both; pulled identities must match verified content and the running image ID.

A final macOS packaging run exposed exit 141 from the existing `git archive | tar` pipeline after adding larger operator assets. Staging the archive before extraction removes the early-closing-reader failure; a deterministic packaging regression and the complete production suite passed.

The existing Keychain helper removes the temporary host token after startup and disables restart. Plain Compose recreation cannot start such a worker; upgrades must use the helper and preserve its credential references and security behavior. Worker health verifies a recent successful inbox poll, while inbox health verifies database connectivity.

## Decision Log

- 2026-11-08 / Oya Gardener: Resolve the exact official Git ref, follow at most 16 annotated tags, and require a terminal commit equal to the release manifest. Reject malformed, cyclic, non-commit or unavailable references rather than trusting `target_commitish` or asset agreement. Keep UID simulation in tests scoped to Keychain selection so real filesystem ownership checks remain intact.

- 2026-11-08 / Oya Gardener: Keep the runtime/database protocol unchanged. Upgrade orchestration must preserve the existing transaction recovery mechanism, not introduce a replacement queue or retry scheme.
- 2026-11-08 / Oya Gardener: Require explicit apply or quiesce for mutation and provide a read-only preview. Downloading verified public artifacts may use temporary storage, but preview must not pull images, stop containers, read Keychain, or alter installation settings.
- 2026-11-08 / Oya Gardener: Retain exact project, Docker context, private directories, user, overrides and volume identities. Only replace the application image and corresponding bundle references. Refuse incompatible storage/topology changes rather than guessing a migration.
- 2026-11-08 / Oya Gardener: Coordinate roles explicitly: stop all workers before replacing the inbox, verify inbox readiness before resuming workers. A local inventory cannot prove that a remote worker is stopped; require an explicit operator gate and document its scope.
- 2026-11-08 / Oya Gardener: Never automatically restore PostgreSQL or roll back an image after potentially applying a migration. Retain private recovery information and stop unverified execution. Unknown transactions retain their original signed bytes/hash and must be reconciled rather than replaced.

## Outcomes & Retrospective

PR #146's tag-binding and root-CI findings are fixed with failing-before/passing-after coverage. The follow-up reran the Python suite on both host and root-container environments and the production suite on Node.js 24. It did not repeat operational upgrades or PostgreSQL restoration; the earlier evidence below covers those unchanged paths. Independent review and publication of the follow-up remain pending.

The authorized installation upgrade and the independent real-Docker CLI upgrade both passed. New release defaults did not change existing IPFS-only identities. Recovery backups were restored successfully in isolated fixtures for the live operation. The CLI makes and catalogs an inbox dump but deliberately leaves full restore testing, off-device backups and public delivery verification to the operator. The Keychain fixture also restored the CLI-generated dump and preserved a signed-transaction canary across failure/retry; actual Keychain credential lookup was stubbed. Initial review findings are fixed, with both real-Docker variants passing. Follow-up review identified one remaining parent-directory sync gap; the fix has red/green ordering regressions and all offline/database suites pass. Final-source real-Docker confirmation also passed. Implementation and validation are complete; human review and merge remain.

## Context and Orientation

`node/production/scripts/publish-image.sh` packages `node/production/` operator assets with `image.txt`, and emits an external `release.txt` and archive. The release's three assets must agree on tag, source and immutable image identity. `inbox/compose.worker.yaml` runs service `node` with Kubo; `inbox/compose.yaml` runs service `inbox`, optionally with the PostgreSQL and HTTPS overlays. Operators save exported selectors in private `compose.env` files. `scripts/keychain-worker.py` owns Keychain-backed startup/stop and its temporary token lifecycle.

`src/inbox/worker.mjs` aborts current processing on termination. `src/inbox/store.mjs` retains CID/transaction checkpoints and fences stale leases; an unresolved signed transaction blocks subsequent work. `host-inbox.md` and `run-locally.md` describe the existing manual upgrade and recovery procedure.

## Plan of Work

First inspect the authorized installation's selected release, explicit configuration, container identities, mounts, job/checkpoint state and IPFS pins. Download and verify release assets before downtime. Stop the worker, stop the inbox for a stable backup, preserve configuration and database/IPFS recovery copies, then recreate only the inbox application. Check persisted records before resuming the worker with the same target and identity. Verify unchanged existing results, pins and secret/configuration hashes, and test harmless end-to-end publication only within established execution scope.

Implement `scripts/upgrade-node.py` and focused Python tests invoked by a Node test wrapper. Verify published release metadata, asset hashes, safe archive paths and image labels. Inspect effective Compose configuration without printing secrets. Use private serialized recovery records and atomic saved-selector updates. Keep direct-node migrations, infrastructure version changes and database rollback outside the automatic path.

Document the exact CLI after implementation, including the two-host order, backups and failure handling. Package the helper and guide together; align the two role guides, agent deployment guide and repository deployment skill. Recheck PR #145 before publishing to avoid inadvertently duplicating release-production work.

## Concrete Steps

From the repository root, install locked runtime development dependencies with `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`. Run focused tests with `python3 node/production/test/upgrade-node_test.py`, then `node --test node/production/test/upgrade-node.test.mjs node/production/test/publish-image.test.mjs node/production/test/keychain-worker.test.mjs`. Run `npm --prefix node/production test` under the supported Node version. Exercise the real CLI against isolated Compose fixtures with disposable credentials and unique projects, never live installation volumes. Run existing PostgreSQL/packaged inbox tests when the available environment supports them. Finish with `git diff --check` and a full sensitive-information/local-path review before pushing the branch.

## Validation and Acceptance

Preview cannot mutate services, saved configuration, credentials or volume state. Incorrect hashes, manifest mismatches, unsafe archive entries, image-label mismatches, unknown layout changes and missing role-coordination assertions must fail before service replacement. Apply preserves private configuration and keys byte-for-byte, retains volume names, recreates only the selected application service, checks its exact image and health, and saves usable recovery information. Both ordinary and Keychain workers need success and failure coverage. Inject download, stop, creation, health, journal and save failures; verify the command returns failure without deleting state or pretending shutdown succeeded.

Real upgrade evidence must distinguish previously retained records from newly generated smoke work and must verify actual content retrieval, not merely container liveness. Tests of transaction safety should retain the same signed transaction across interrupted processing using the existing PostgreSQL/checkpoint failure-injection tests and a real-Docker retained-checkpoint canary. Public testnet transactions are not needed for this task.

## Idempotence and Recovery

Use isolated worktrees and per-installation operation locks. Retain the original bundle and image, private configuration backup, stable database backup and IPFS snapshot. No `down --volumes`, pruning, secret regeneration, automatic rollback, raw-transaction logging or override removal is permitted. A failed or interrupted apply leaves recoverable phase information and nonzero status. Operators inspect actual container/image/database state and reconcile pending work before any manual rollback. An old snapshot is a disaster-recovery artifact, not a routine way to undo a failed image start.

## Artifacts and Notes

The selected release is node-v0.4.0 at commit `d166c6603d41e19627d41922e7c87fe1a0d988a0`. Its published archive SHA-256 is `06d96488285dbf92c85a0c2bfe420a9f08b355a78fc43a5e5a431a259872cba9`; its image is `ghcr.io/oyaprotocol/oya-node@sha256:e4b110bffb994c5fe6af013d4d10e9d2962696b415bfdfec7f63f0c359e3fe17`. These are evidence for the selected live upgrade, never hardcoded future CLI defaults. Actual acceptance results will be added here without private installation identifiers.

## Interfaces and Dependencies

Python 3 standard library, Docker with Compose, HTTPS access to official release assets and GHCR, and the operator's existing private configuration are required. Keychain operation additionally requires macOS and the existing helper. PostgreSQL backup requires the operator's established authorized database access. Neither the upgrade script nor its tests may require provider credentials, funded signing accounts, new permissions or an automatic release publisher.
