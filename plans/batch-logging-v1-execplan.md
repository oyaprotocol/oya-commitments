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
- [x] 2026-11-15 16:05Z: Reviewed PR165 feedback and reproduced the duplicate admission URI omission and packaged runtime import failure. Fixed both with response/restart regressions and the missing Docker allowlist entry.
- [x] 2026-11-15 16:05Z: Follow-up validation passed: 23 focused and 411 production tests on Node 24.22.2, nine PostgreSQL integration tests, Linux amd64 direct Docker lifecycle, and packaged HTTPS inbox/worker scenarios. Human review and merge remain required; follow-up is local only.

- [x] 2026-11-15 16:46Z: Reproduced founder comment 6897727483 with a failing HTTP manifest-shape regression; removed public batch/execution/digest metadata. Added cross-context content identity and failure/restart coverage.
- [x] 2026-11-15: Local Node 24.22.2 validation passed 30 focused and 418 production tests. Independent review is pending; no remote writes.

## Surprises & Discoveries

Founder clarification on November 15 separates IPFS content identity from transaction execution identity. The regression failed because the published manifest included `batchId`, `execution` and `messageDigest`. The journal already stores all recovery metadata separately, so the correction changes only manifest serialization. Existing manifest-CID checkpoints can be resumed without republishing, including the earlier format.

PR165 review found that the pending-duplicate branch omitted `uri`; a full HTTP response equality assertion failed on that field alone. The Docker build allowlist also excluded `src/batch-logging.mjs`, despite unconditional imports from runtime configuration. A fresh image reproduced `ERR_MODULE_NOT_FOUND`, explaining the worker CI failure and the direct runtime's startup failure. Adding the module restored imports and both failed CI commands passed locally.

The direct runtime has no durable state. The inbox processor already checkpoints raw signed transactions before broadcast and verifies receipts. Extract its Ledger stage rather than create a second transaction recovery implementation. The earlier evidence feature verifies arbitrary logged bytes; it neither produces batches nor verifies membership of signed messages inside manifests.

Initial tests exposed cleanup ordering in the synthetic fixture (directory removal before lock release), corrected in the fixture. Review also preserved the inbox processor's pre-publication execution-identity check during extraction. Filesystem failures after rename can have uncertain acknowledgement: the coordinator blocks all subsequent work until restart reloads disk. The retention test executes 101 real prepared/signed transactions through mocked RPC and proves only 100 summaries remain. Packaging has an explicit documentation allowlist, so the new guide is added to bundle creation, verification and their fixture.

## Decision Log

- 2026-11-15, Hermes: derive the retry URI from the saved canonical CID and retain the strict Docker build allowlist with one added module. Both failures need no transaction or inbox API changes; existing Docker integrations cover the packaging regression.

- 2026-11-14, Hermes: limit this milestone to direct Ledger runtime. Inbox/worker batching needs multi-job lease/checkpoint semantics and is explicitly rejected rather than silently ignored.
- 2026-11-14, Hermes: one bounded pending batch, bounded recent results, serialized admission/flush, local atomic journal with exclusive lock; failures block admission until recovery. A crash leaves a lock for deliberate operator recovery, avoiding unsafe lock stealing.
- 2026-11-15, Hermes, superseding the initial manifest-context decision: publish only the type/version and ordered CID strings. Content must be independent of batch ID, node, chain and Ledger; message digests remain private checkpoint checks. Retain journal execution binding, signed-message authorization and transaction validation. Keep version 1 for this pre-merge correction; retain existing legacy manifest CIDs and raw transactions exactly rather than migrate uncertain work.

## Outcomes & Retrospective

The founder correction publishes a content-only CID list. Identical ordered members now yield identical bytes across different batch IDs, node accounts, chains and contracts; reversing order changes the content CID. Signed transactions still target the configured identity. Regression tests reject changed recovery identities without side effects, retry identical manifest bytes after a lost upload acknowledgement, and preserve unsigned/signed legacy manifest checkpoints with the original authorization/reconciliation boundaries. The source change is confined to serialization.

The November 15 follow-up preserves the admission response on exact pending retries, including after journal reload, without another upload or signature. The packaged immediate direct runtime and inbox workers now load the batch module. No transaction implementation changes were needed. Both previously failing integration paths pass against disposable local services; batch-specific chain/IPFS coverage remains synthetic.

The direct-runtime milestone is implemented and exercised: independent message publications, versioned content-only manifest, count/time scheduling, atomic checkpoint recovery, bounded status retention, authorization and safe shutdown. The unchanged immediate path and inbox/worker regressions pass. The operator guide documents 202 semantics, pending-only deduplication, recovery after revocation, stale-lock removal, single-signer ownership and the trusted private-journal/IPFS-provider integrity boundary. Review reproduced a permanent oversized request incorrectly returning 503; it now returns 413 without publication side effects, protected by a regression. Inbox/worker batching remains future work requiring a separate multi-job lease design. No live chain, funded transaction, release or deployment was performed.

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

The operator contract is in `node/production/batch-logging.md`. This is source functionality, not a claim about any published image. Initial validation used Node v26.12.1 and npm 12.0.2, with the unchanged pinned lockfile installed via `npm ci --ignore-scripts`: 22 focused and 410 production tests passed. After independent review, parent Node 24.22.3 validation passed 23 focused and 411 production tests.

November 15 follow-up validation used Node 24.22.2, Foundry 1.5.1, Docker 29.9.2 and Compose 5.6.1. From the repository root, `node --test node/production/test/batch-logging.test.mjs` passed 23 tests and `npm --prefix node/production test` passed 411. `forge build --root contracts` built the local fixture. `npm --prefix node/production run test:inbox` passed nine tests, including checkpoint/broadcast/completion acknowledgement-loss recovery. `npm --prefix node/production run test:docker -- --verbose --platform linux/amd64` passed the direct publication, persistence, shutdown-drain, uncertain-receipt and backup lifecycle test (amd64 image on arm64 Docker). `npm --prefix node/production run test:inbox:docker` passed IPFS, Ledger and Sepolia-default identity scenarios through real PostgreSQL, HTTPS, offline Kubo and isolated Anvil chains. All tests had zero failures/skips. Real power-loss, public-chain, replication and batch-specific Docker acceptance remain unperformed. No release was published; default inbox logging remains immediate.

### Founder correction validation

On Node 24.22.2, `node --test node/production/test/batch-logging.test.mjs` passes 30 tests and `npm --prefix node/production test` passes 418 tests, with no failures or skips. The exact HTTP shape assertion first failed against `036e4379df` on execution metadata, batch ID and per-message digest objects. Synthetic transports exercise actual signatures, transaction preparation, disk checkpoints and HTTP. Earlier Docker/PostgreSQL results above belong to the previous follow-up, not this correction. Independent review and any publication remain pending.

### Next feature — informational candidate

`batch-evidence-v1`: bounded read-only verification of a signed message's membership in an IPFS manifest through the existing evidence CLI. Validate the content-only manifest shape, ordered CID list, selected member CID/bytes and message signature; separately verify any supplied Ledger receipt against its chain, contract and transaction signer. Do not infer the originating publisher or require chain/node/contract metadata in the manifest. Cover malformed/oversized manifests, unavailable content, invalid membership/bytes/signatures and mismatched receipt context. Estimate 1,200–2,200 changed code/test lines under an independent 3,000-line cap. Reconcile open evidence work before implementation; this is informational, not an approval gate.

## Interfaces and Dependencies

No new dependency or contract. Reuse installed pinned message/IPFS/Ethereum kernels, ethers, and Node filesystem primitives. Batch configuration supplies a persistent state directory, count limit and time limit. HTTP admission returns 202 with individual CID and batch ID; status exposes bounded pending/recent batch summaries without signed raw transactions or message text.
