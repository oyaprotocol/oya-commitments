# Local nodes with a portable PostgreSQL inbox

This ExecPlan follows `PLANS.md` and replaces the unfinished SSH relay design.

## Purpose / Big Picture

An agent submits a signed message to an always available inbox. PostgreSQL retains the job while the operator's computer is offline. A local node polls over outbound HTTPS, publishes to IPFS, optionally records the CID in Ledger, and updates the job. Operators choose where to host both the inbox container and PostgreSQL; no tunnel provider or cloud-specific queue is required.

## Progress

- [x] 2026-10-11: Audited the synchronous runtime, release assets, and unfinished relay draft. Selected a PostgreSQL execution journal as well as queue.
- [x] 2026-10-11: Implemented signed jobs, bounded HTTP ingress, transactional leases, and immutable publication/transaction checkpoints.
- [x] 2026-10-11: Implemented both worker modes, sender CLI, status monitoring, and restart recovery.
- [x] 2026-10-11: Added portable Compose deployments, local/inbox/API guides, release assets, and a separate inbox CI job. Retained direct-node guides as advanced/historical references.
- [x] 2026-10-11: Initial PostgreSQL recovery tests passed; the packaged HTTPS flow published and retrieved messages in both modes against real PostgreSQL, Kubo, and Anvil. All 157 production tests passed.
- [x] 2026-10-11: Completed all nine database-suite tests, including immutable checkpoint conflicts and long-running lease renewal. Packaged client creation/overwrite protection and both modes passed through the shipping Caddy routes, with private health routing verified. Reviewed source, configuration, docs, release contents, and plan.
- [x] 2026-10-12: Added bounded PostgreSQL readiness checks for startup connection resets reported by GitHub Actions. All nine database-suite tests and 160 runtime tests passed locally, including three new readiness regression tests. GitHub job 117021722870 subsequently passed all nine database tests.
- [x] 2026-10-16: Reproduced the Caddyfile permission failure on a Linux volume and corrected its mode. The Linux permissions check and both packaged worker modes passed in about 69 seconds; all 161 runtime tests passed. Added bounded waits and credential-redacted failure diagnostics. All six CI checks subsequently passed for the final PR source tree, which exactly matches merged commit `07acda6b247b34f5061275904d209ad071b80029`.
- [x] 2026-10-16: Published `node-v0.3.0` and `ghcr.io/oyaprotocol/oya-node:v0.3.0` from the merged commit, verified anonymous image access, and published the three matching GitHub Release assets. Verified all 24 bundle files against the tag and all 17 image source/manifest files against the tagged source.
- [x] 2026-10-16: Corrected public bundle permissions before upload and added the same correction to the publisher with regression coverage; all 13 publisher tests passed. The publisher/test correction and release record were committed in `f05e385` after the tagged source.
- [x] 2026-10-16: Aligned operator extraction instructions with the permission-preserving test command and covered `umask 077`; all 13 publisher tests passed. GNU tar checks as a non-root Linux user passed for both published bundles, including the public-file repair required by v0.2.0.

## Surprises & Discoveries

The existing Ledger preparer returns signed transaction bytes without broadcasting. This provides the boundary needed to save the exact transaction in PostgreSQL before sending it. The synchronous runtime has only an in-memory unknown-transaction guard and cannot safely serve as a queue worker unchanged.

The PostgreSQL client accepts URL options that can override TLS settings. Inbox configuration rejects connection-string query options and uses explicit certificate verification, with plaintext permitted only by explicit configuration for private networks.

Docker Desktop can change a dynamically allocated host port when a database container restarts. The integration fixture now rediscovers the port and recreates its connection pool; this corrected fixture connection failures without changing runtime behavior.

The reported GitHub Actions PR run failed all database subtests with `ECONNRESET` while acquiring a startup connection. The previous retry loop handled refused connections and PostgreSQL startup errors but omitted connection resets. The fixture now probes `SELECT 1` through the published TCP endpoint before subtests and after database restart, with a bounded wait for transient connection failures. Schema initialization remains outside that retry loop so SQL and configuration errors fail immediately.

GitHub job 117021722870 passed the PostgreSQL suite but timed out reading the proxy's internal CA certificate in the packaged HTTPS fixture. The fixture wrote its generated Caddyfile with mode `0600`, owned by the runner, while the proxy drops the capabilities needed to bypass Linux file permissions. Copying that file with its ownership preserved onto a Linux Docker volume reproduced `open /etc/caddy/Caddyfile: permission denied` with the pinned Caddy image. Changing only this non-secret configuration to `0644` made the same check pass. Docker Desktop bind mounts had hidden the permission mismatch locally; the old command wrapper discarded Caddy's error output.

Release review found that the publisher's private `umask` also gave archived public files mode `0600` and directories mode `0700`. The v0.3.0 bundle was normalized to the tagged public file modes and traversable directories before upload, with local owner names removed from archive metadata. File contents still match the release tag exactly. The publisher now grants read/traversal permission only within its public bundle staging subtree; its enclosing staging and output directories remain private. Regression assertions cover both Caddyfiles and directory traversal.

The extraction review found a separate operator-side permission issue: the direct guide used `tar -xzf` after `umask 077`, while the regression test used `-p`. The documented command now preserves archived permissions. The pinned v0.2.0 archive itself stores owner-only modes, so that historical walkthrough also repairs only its extracted public `node` and `agent-library` trees. Private operator configuration remains separate.

## Decision Log

- 2026-10-11 / Codex: Replace SSH forwarding with an application inbox, as requested by the user. Keep direct HTTP operation as an advanced option.
- 2026-10-11 / Codex: Use PostgreSQL for both queue and execution checkpoints. Persist signed transactions before broadcast, use compare-and-set to prevent replacement, and recover the same transaction after lease loss. This avoids a second database on the local device and permits safe restart with the same node identity.
- 2026-10-11 / Codex: Process one job per inbox target at a time. An unresolved transaction blocks later jobs. A lease controls ownership of mutations; immutable transaction bytes protect against a delayed worker broadcasting after lease expiry.
- 2026-10-11 / Codex: Bind the request ID and target in an agent signature in addition to the existing signed message. Retain idempotency records through the signed submission expiry. PostgreSQL and the authenticated worker are trusted execution infrastructure; neither receives the node private key.
- 2026-10-11 / User and Codex: Pin `pg@8.23.1`, the release reported by npm during implementation. The user confirmed the choice; exact pinning and the lockfile keep dependency installation reproducible.
- 2026-10-16 / Codex: Make only the generated test Caddyfile readable by the proxy, retain owner-only secret files and proxy capability restrictions, and exercise file ownership on a Linux volume before starting the stack. Keep the pinned image's verified CA path, allow a two-minute CA wait, and report bounded, credential-redacted command errors and service logs on failure.
- 2026-10-16 / User and Codex: Publish the first inbox-capable image as v0.3.0 from the merged, CI-tested source. Verify the immutable image digest anonymously and upload the matching bundle only after content and permissions checks. Keep the publisher-only follow-up separate from the already tested runtime release.

## Outcomes & Retrospective

The default documentation describes local execution and a separately hosted inbox. Both modes passed the packaged flow with PostgreSQL, HTTPS, Kubo, and Anvil, including offline acceptance, worker restart, content retrieval, and the private health route. All 157 runtime tests and nine database-suite tests passed. The final container check completed in about 81 seconds. Release-bundle tests cover the new guides and Compose assets. The database is trusted execution infrastructure and stores signed transaction bytes before broadcast; it does not store private signing keys. The direct API remains compatible.

The original implementation and review are complete and committed. The inbox-capable image and deployment bundle are now published as `node-v0.3.0`; v0.2.0 cannot run this feature. No external node or inbox deployment was performed. Provider-specific PostgreSQL services and real-chain transactions were not exercised; local disposable fixtures cover the portable implementation. Operational limits remain explicit: one job per target, bounded queue retention, no automatic fee replacement, and reconciliation before database rollback.

The 2026-10-12 CI follow-up changes only the integration fixture and its regression coverage. `npm --prefix node/production run test:inbox` passed all nine tests against disposable PostgreSQL, including database restart; `npm --prefix node/production test` passed all 160 tests. Injected connection resets verify the reported failure path, and separate checks verify fatal errors, startup timeout, and cancellation. GitHub job 117021722870 also passed the database suite; its later packaged HTTPS failure is tracked in the 2026-10-16 follow-up.

The 2026-10-16 follow-up fixes a Linux permission mismatch in the generated test Caddyfile. The new check preserves the runner's file ownership and permissions on a Linux Docker volume and runs the pinned proxy image with its capability restrictions. It failed with `permission denied` before the mode correction and passed afterward. `npm --prefix node/production run test:inbox:docker` then passed both modes in about 69 seconds, and `npm --prefix node/production test` passed all 161 tests, including diagnostic credential redaction. Failure output now includes the last polling error and bounded service logs before cleanup. These changes affect test infrastructure only; [GitHub CI](https://github.com/oyaprotocol/oya-commitments/actions/runs/38917953391) subsequently passed all checks for the same source tree as the release.

The release image is Linux amd64 and was built from tag `node-v0.3.0` at commit `07acda6b247b34f5061275904d209ad071b80029`. An empty Docker credential configuration successfully pulled its exact digest. The published image also passed non-root, offline module-load and source-hash checks. GitHub's uploaded-asset digests matched all three local files. The publisher permissions regression passed all 13 tests using `node --test node/production/test/publish-image.test.mjs`; that source fix and release record were subsequently committed in `f05e385`. The next operational milestone is an external inbox/PostgreSQL deployment connected to a local worker, starting with IPFS-only offline-delivery verification.

The extraction follow-up documents `tar -xzpf` and keeps the private `umask` active. The publisher suite passed all 13 tests with explicit `umask 077`, checking both Caddyfiles, mounted agent source, directory traversal, and subsequent private file creation. Separate offline GNU tar checks ran the documented commands against the published v0.2.0 and v0.3.0 archives as an ordinary Linux user. Both retained readable public assets and owner-only private settings; removing `-p` from the v0.3.0 command reproduced the restrictive file modes. Existing release assets and image contents were unchanged.

## Context and Orientation

`node/production/src/main.mjs` starts the existing synchronous HTTP node. `config.mjs`, `signer.mjs`, and the published kernel packages provide validated configuration, local signing, IPFS publication, and Ethereum transaction preparation. New code lives under `node/production/src/inbox/`; the same Docker image exposes inbox, worker, and client entrypoints. No contract or agent-library changes were needed. Existing direct-HTTP tests remain regression coverage.

## Plan of Work

First implement a versioned signed envelope and PostgreSQL store. The database locks a target row to serialize claims and checkpoint mutations. Queue submission is durable before returning 202. A configured capacity bounds retained jobs; signed expiry limits new submissions, and only unstarted jobs expire automatically.

Next implement the worker using existing IPFS and Ethereum kernels. Save the CID, prepare and save the signed transaction, then broadcast. On every subsequent attempt use the saved bytes and transaction hash. Verify receipts and Ledger events before marking success. Unknown outcomes remain visible and block subsequent jobs; never automatically replace a signed transaction.

Then add a sender CLI that saves the signed envelope before submission, Compose services with private secrets mounts, separate local-worker and inbox-host instructions, and release bundling. Finish with database-backed concurrency/restart tests, Docker checks, existing runtime tests, and a full diff review.

## Concrete Steps

From the repository root, install production dependencies with `npm --prefix node/production ci --ignore-scripts`. Run `npm --prefix node/production test` for unit and regression checks and `npm --prefix node/production run test:inbox` for isolated PostgreSQL integration tests. Build the contract fixture with `forge build --root contracts`, then run `npm --prefix node/production run test:inbox:docker` for the packaged HTTPS workflow in both modes. Build an operator image with `docker build -t oya-node:local node/production`. Integration fixtures use random resource names and clean up only their own containers and volumes.

## Validation and Acceptance

Prove that a signed job can be submitted while the worker is offline, survives inbox restart, and becomes published when the worker starts. Retry the same envelope and observe one job. Exercise invalid signatures, capacity, status privacy, lease expiry, stale checkpoint rejection, and competing workers. Interrupt Ledger work before and after broadcast and observe the same transaction hash on recovery, with no new signature or nonce. Confirm both modes, error redaction, release contents, and the original synchronous API continue to work. Use disposable local fixtures, never real-chain funds.

## Idempotence and Recovery

Agents retain their signed job file and retry that exact file. New IDs mean new authorized work. CID and transaction checkpoints are immutable. A transaction must be durably acknowledged before broadcast; loss of that acknowledgement causes a later claim to read the database again. Database loss or rollback can invalidate replay protection: stop workers before database restore and reconcile recorded transactions before resuming. Use a dedicated Ledger key for the worker, and never run synchronous publication concurrently with that key. Back up PostgreSQL and secrets separately. No automatic schema downgrade or destructive migration is permitted.

## Artifacts and Notes

Primary documentation consulted: [PostgreSQL row locking](https://www.postgresql.org/docs/current/sql-select.html) and [node-postgres TLS configuration](https://node-postgres.com/features/ssl). Deployment documentation must distinguish the new source build from released v0.2.0 images, which do not contain the inbox implementation.

Published release: [node-v0.3.0](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.0). The assets are `image.txt`, `release.txt`, and `oya-node-v0.3.0.tar.gz`. The immutable image reference is `ghcr.io/oyaprotocol/oya-node@sha256:848806de43f0afa056d1dea533320bfc1b503cb4409a96abb3101d7cedbb69de`. The bundle SHA256 is `8c8cd6f5ecf4c9de1b0704b8f81a7be05d574a68af8ce6eef45a17e2f8c4ae73`. The release notes explain using this digest where the tagged guides still describe a source build or future release.

## Interfaces and Dependencies

Use Node.js 24, the pinned `pg` client, PostgreSQL 17, existing Oya kernels, and ethers. Public endpoints submit signed envelopes and return job status. Worker endpoints use a separate bearer token for claim, renewal, checkpoint, completion, and retry reporting. Database credentials stay with the inbox; signing keys stay with agents and local nodes. HTTPS terminates at an operator-selected reverse proxy; the provided Compose example uses Caddy. Managed PostgreSQL uses certificate verification. Local private-network PostgreSQL can explicitly disable TLS.
