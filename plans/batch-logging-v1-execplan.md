# Optional direct-runtime batch logging

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

Opt-in direct nodes publish each authorized signed message independently, then publish a manifest of exact message CIDs and log only that manifest CID. Count or elapsed time since the last verified log triggers a bounded batch. Omitted configuration retains immediate per-message logging. This implements the priority recorded in `plans/peer-node-network-execplan.md`, informed by dialogue Q001 (security) and Q006 (node logging responsibility).

## Progress

- [x] 2026-11-14: Read instructions, direct/inbox publication paths, current peer direction and prior Ledger evidence plan.
- [x] 2026-11-14 17:14Z: Implemented durable direct batching, shared checkpointed Ledger stage, explicit worker rejection, health/status and packaged operator documentation.
- [x] 2026-11-14 17:14Z: Focused 22/22 and full production 410/410 tests pass, zero failures/skips. All new chain/IPFS tests use synthetic mocked transports.
- [x] 2026-11-14: Independent review reran 22 focused and 410 production tests; no blockers under the trusted-journal/provider model. Parent corrected permanent size failures to HTTP 413 and documented the journal integrity boundary.
- [x] 2026-11-14: Parent validation on Node 24.22.3: 23 focused and 411 production tests passed, no failures/skips. Cumulative code budget: 673 additions + 20 deletions = 693 lines, below 3,000.
- [ ] Publish after final live open-feature/overlap check; human review and merge remain required.

## Surprises & Discoveries

The direct runtime has no durable state. The inbox processor already checkpoints raw signed transactions before broadcast and verifies receipts. Extract its Ledger stage rather than create a second transaction recovery implementation. The earlier evidence feature verifies arbitrary logged bytes; it neither produces batches nor verifies membership of signed messages inside manifests.

Initial tests exposed cleanup ordering in the synthetic fixture (directory removal before lock release), corrected in the fixture. Review also preserved the inbox processor's pre-publication execution-identity check during extraction. Filesystem failures after rename can have uncertain acknowledgement: the coordinator blocks all subsequent work until restart reloads disk. The retention test executes 101 real prepared/signed transactions through mocked RPC and proves only 100 summaries remain. Packaging has an explicit documentation allowlist, so the new guide is added to bundle creation, verification and their fixture.

## Decision Log

- 2026-11-14, Hermes: limit this milestone to direct Ledger runtime. Inbox/worker batching needs multi-job lease/checkpoint semantics and is explicitly rejected rather than silently ignored.
- 2026-11-14, Hermes: one bounded pending batch, bounded recent results, serialized admission/flush, local atomic journal with exclusive lock; failures block admission until recovery. A crash leaves a lock for deliberate operator recovery, avoiding unsafe lock stealing.
- 2026-11-14, Hermes: maintain context binding (chain, contract, node), manifest version, ordered message CIDs and message digests. Authorization is rechecked before new transaction preparation; an already checkpointed transaction must reconcile even after revocation.

## Outcomes & Retrospective

The direct-runtime milestone is implemented and exercised: independent message publications, versioned context-bound manifest, count/time scheduling, atomic checkpoint recovery, bounded status retention, authorization and safe shutdown. The unchanged immediate path and inbox/worker regressions pass. The operator guide documents 202 semantics, pending-only deduplication, recovery after revocation, stale-lock removal, single-signer ownership and the trusted private-journal/IPFS-provider integrity boundary. Review reproduced a permanent oversized request incorrectly returning 503; it now returns 413 without publication side effects, protected by a regression. Inbox/worker batching remains future work requiring a separate multi-job lease design. No live chain, funded transaction, release or deployment was performed.

## Context and Orientation

`node/production/src/server.mjs` owns authenticated direct ingress and concurrency limits. `config.mjs` is its strict config parser. `main.mjs` owns startup/signals. `inbox/processor.mjs` owns durable publication and Ledger execution; `inbox/protocol.mjs` validates signed transaction identity and limits. A CID is an IPFS content identifier. A manifest is JSON listing separately published content. A checkpoint is state saved before the next irreversible action.

## Plan of Work

Extract the processor's checkpointed Ledger stage with behavior unchanged. Add a direct batch coordinator and local journal. Connect startup, ingress, read-only batch status, timer and shutdown. Reject batching from worker entrypoints. Add synthetic transport tests that exercise actual signatures, transaction bytes, HTTP and disk persistence. Document the protocol and recovery limitations.

## Concrete Steps

From the repository root, install with `npm ci --prefix node/production --ignore-scripts`, run focused `node --test node/production/test/batch-logging.test.mjs`, then `npm --prefix node/production test`. Inspect `git diff --check`, the complete diff and `git diff --numstat`. Commit only local code/tests/docs/plan.

## Validation and Acceptance

Prove count/time triggers, independent uploads and one manifest transaction, unchanged default, bounded backpressure, invalid/revoked signer denial, persisted recovery with the same raw transaction, upload/checkpoint/receipt failures, lock/identity rejection, and graceful shutdown. All new chain/IPFS evidence uses synthetic mocked transports, never a live chain. Full production suite must pass. Added+deleted code/test/config must remain at most 3,000 lines excluding prose.

## Idempotence and Recovery

Preserve the state directory and its checkpoint. Never discard a checkpointed raw transaction to escape a timeout. Stop every process using the dedicated signer before recovering a stale lock; verify the process is gone, then remove only the lock. Restart against the same execution identity. Failed/reverted batches remain visible, and uncertain transactions are retried by hash rather than re-signed. Drain pending work before disabling batching or changing identity. Do not share the signer with another runtime.

## Artifacts and Notes

The operator contract is in `node/production/batch-logging.md`. This is source functionality, not a claim about any published image. Validation used Node v26.12.1 and npm 12.0.2, with the unchanged pinned lockfile installed via `npm ci --ignore-scripts`. Initial focused suite: 22 passed; initial full production suite: 410 passed. After independent review, parent Node 24.22.3 validation passed 23 focused and 411 full production tests, zero failed/cancelled/skipped. New tests use synthetic mocked chain/IPFS; real power-loss, Docker, public-chain and replication acceptance remain unperformed. The suite includes mocked packaging/upgrade checks; it did not publish a release. Default inbox deployment remains immediate logging.

## Interfaces and Dependencies

No new dependency or contract. Reuse installed pinned message/IPFS/Ethereum kernels, ethers, and Node filesystem primitives. Batch configuration supplies a persistent state directory, count limit and time limit. HTTP admission returns 202 with individual CID and batch ID; status exposes bounded pending/recent batch summaries without signed raw transactions or message text.
