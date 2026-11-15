# Receive peer messages through the ordinary publication queue

Feature ID: `peer-inbox-receive-v1`. This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator enables an installed trusted registry on the inbox and worker. A registered sender prepares one independently signed message, submits its saved transport envelope, and recovers the same admission receipt after a lost acknowledgement. The receiver queues an ordinary publication job in the same PostgreSQL transaction as that receipt. Its existing worker publishes the unchanged `{ text, signer, signature }` to IPFS and, in Ledger mode, logs the CID using normal checkpoints and transaction recovery. Receipt acceptance is not proof of publication or onchain confirmation.

[pemulis's correction 6900008120 on PR #173](https://github.com/oyaprotocol/oya-commitments/pull/173#issuecomment-6900008120), November 15, 2026, supersedes the original receipt-only interpretation and the older receiver-selection candidate. For testing, registry members are ordinary allowed publication senders. Enabling this grant remains explicit operator configuration, not deployment authorization. There is no automatic scheduler, reply, forwarding or instruction execution.

## Progress

- [x] 2026-11-15: Initial receipt-only milestone implemented and independently reviewed: 401 production tests, six real PostgreSQL peer tests, nine existing inbox PostgreSQL tests and image/packaging checks passed.
- [x] 2026-11-15 19:15Z: Fixed retained-receipt status after lowering admission `maxTextBytes` in a6f5dca. Previous evidence: 28 focused, 402 production, six peer PostgreSQL and nine inbox PostgreSQL tests passed. This correction is retained, not duplicated.
- [x] 2026-11-15: Read the founder's later correction, existing code and repository instructions. Inspected active ownership before creating an isolated local candidate.
- [x] 2026-11-15: Added version-2 transport carrying the original signed message and ordinary job signature, atomic queue admission, and registry authorization on inbox and worker startup.
- [x] 2026-11-15: Added real-signature publication and transaction failure tests; first focused run exposed the ordinary message package's ASCII-only schema, now enforced at peer admission rather than accepting unpublishable Unicode.
- [x] 2026-11-15: Passed all 413 production tests on Node 24.22.3, seven real PostgreSQL peer/worker integration tests and nine existing inbox PostgreSQL tests, without skips. Local pinned-base image build and network-disabled image CLI signature/private-output checks pass.
- [ ] Independent parent review before any publication. No push, public reply, deployment or real-chain action is part of this local task.

## Surprises & Discoveries

The earlier peer format allowed UTF-8 and only signed the transport. The installed ordinary message package requires nonempty ASCII and a signature over the message itself. Initial new end-to-end tests failed with `invalid_signed_job`; direct package validation identified `text must contain only ASCII characters`. The corrected validator calls the installed `verifySignedMessage` and preserves its validated object. Unicode/BOM is rejected, never stripped or rewritten.

The worker revalidates an ordinary job signature as well as the inner message. A transport signature cannot substitute for either. Signing a normal job at preparation permits reuse of the existing worker without trusting inbox-created signatures or adding a second execution pipeline.

The ordinary queue has its own capacity, duplicate-ID and expiry rules. Calling its public `enqueue` from a separate transaction would leave partial acceptance on crashes. Extracting its existing insertion logic into `enqueueInTransaction` allows one transaction for both records, with target locks always taken peer first, inbox second.

## Decision Log

- 2026-11-15 / Oya Gardener: Follow the verified founder correction on the same PR. Replace receipt-only admission with ordinary publication intent. The operator-enabled registry is unioned with explicit local grants on both inbox and worker; self is excluded only from registry-derived grants. Local grants are not rewritten.
- 2026-11-15 / Oya Gardener: Use a new version-2 transport domain. Its signature binds the exact inner message, ordinary job signature, network, receiver, target, request ID and expiry. Preserve all message fields unchanged into the queue and IPFS. Version-1 receipt-only rows lack publication consent/signatures and are never automatically promoted. Old envelopes require authorized fresh preparation; records remain in the database.
- 2026-11-15 / Oya Gardener: Keep receipt recovery separate from execution status. Status uses the 8,192-byte protocol ceiling, current membership and exact retained digest. The ordinary signed job can query `/v1/status` for execution state. A retained admission receipt never claims successful execution.
- 2026-11-15 / Oya Gardener: Reuse normal worker authorization, IPFS publication, execution identity, fee/gas limits, checkpoints and receipt verification. No second signer, broadcaster, job processor or bridge scheduler is introduced.
- 2026-11-15 / Oya Gardener: Registry snapshots are local, bounded and immutable until deliberate restart. Revocation requires coordinated inbox/worker restart and does not cancel a broadcast transaction; retain checkpoints and use the existing operator recovery procedure.

## Outcomes & Retrospective

Local correction is implemented and validated; independent parent review remains required before publication. Real CLI/inbox/worker integration proves one ordinary job, registry-only authorization on both roles and unchanged sender-signed IPFS content. The cumulative feature is 1,019 changed non-Markdown lines against PR base `7f40c242759eedad9aa079aad8f324a99f445db5`, below the 3,000-line limit. Tests use disposable synthetic wallets, PostgreSQL and controlled transports, never funded accounts or real RPC/IPFS endpoints. The original receiver-selection next-feature proposal is superseded by this correction. A continuous testnet message/publish/log/review loop remains separate future work requiring its own bounded design and operational authorization.

## Context and Orientation

Production code is under `node/production`. `src/peers/protocol.mjs` creates/verifies the transport and exposes `peerJob`, which extracts the normal signed job. `src/peers/store.mjs` stores receipts and atomically calls `src/inbox/store.mjs`'s insertion logic under both target locks. `src/peers/config.mjs` bounds registry reads and derives the effective signer union. `src/inbox/main.mjs` and `worker.mjs` load independent operator-installed snapshots. `src/inbox/processor.mjs` remains the ordinary publication and transaction path, unchanged by this correction.

`peers/receive.md` describes configuration, compatibility and recovery. Inbox configuration uses `peers`; workers use the same object in `worker.json`, with registry paths relative to their respective config files. No private node key goes onto the inbox. `plans/peer-node-network-execplan.md` records the newer direction above superseded history.

## Plan of Work

Implement signatures and exact immutable validation first. Extract ordinary queue insertion without altering its semantics, then atomically insert the job and receipt. Wire opt-in registry signer unions at both process startup paths. Update operator docs and prior-plan boundaries. Validate forged inner/outer/job signatures, authorization, queue rollback and capacity, lost acknowledgement, worker process startup, unchanged IPFS payload and signing/transaction failures. Inspect the complete cumulative feature diff, including prior commits and new tests, against the 3,000 changed-code-line cap. Parent reviews before publishing anything.

## Concrete Steps

From repository root with Node 24 or newer, npm, Python 3 and Docker:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/peer-receive.test.mjs node/production/test/peer-publication.test.mjs node/production/test/inbox-ledger.test.mjs
    npm_config_loglevel=error npm --prefix node/production test
    node node/production/scripts/test-peer-receive.mjs
    node node/production/scripts/test-inbox.mjs
    git diff --check

Store full logs outside Git. PostgreSQL integration uses disposable loopback containers and synthetic identities. Worker publication integration uses a local mock IPFS HTTP service. Ledger tests use real local cryptographic signing and controlled RPC responses; no real broadcasts occur.

## Validation and Acceptance

Validate all three signatures independently, including valid outer signatures around forged inner content/signers/signatures and forged ordinary job signatures. Prove a detached frozen message snapshot and exact equality of queued and uploaded message objects. Reject old protocol versions, malformed/empty/non-ASCII/NUL text, oversized text, unknown/revoked/self senders, wrong routing and expiry. Preserve retained status when admission limits shrink.

Real PostgreSQL must prove concurrent retries return one receipt and one ordinary job, capacity on either store rejects without partial acceptance, a database error after queue insertion rolls back both, exact ordinary-route duplicates are reused, conflicting IDs reject, restart/lost acknowledgements preserve identity, and peer pruning leaves publication checkpoints untouched. Exercise real CLI, inbox and worker processes with registry-only authorization and inspect the uploaded original signed object.

Signing/transaction tests cover IPFS failure, preparation failure, signing failure, lost CID/transaction checkpoint acknowledgements, broadcast failure, receipt timeout/restart, reverted/malformed receipts and revoked authorization. No broadcast follows an unacknowledged transaction checkpoint. Resume reuses the saved raw transaction/hash. Run the existing ledger identity/event and worker tests unchanged as well as the full production suite and packaging checks.

## Idempotence and Recovery

Preserve the original envelope after any send failure; acceptance may have committed. Exact retries before expiry recover the same receipt, while status works after expiry for the retained digest. Never infer non-publication from a missing receipt. Queue records have their existing lifecycle and are not pruned by peer retention. Enabling registry-derived publication does not retroactively promote version-1 receipts. Coordinate both role snapshots when enabling/revoking. Disabling peer routes does not erase queued jobs or pending transaction checkpoints.

## Artifacts and Notes

Final local validation on Node 24.22.3: 413 production tests, seven peer PostgreSQL tests (including actual CLI/inbox/worker processes and mock IPFS), and nine existing inbox PostgreSQL tests all pass with no skips. The focused peer/ledger suite previously passed 53 tests on Node 26.12.1; the first run exposed and led to correction of the ASCII-schema mismatch. Local image build and network-disabled CLI checks pass, including ordinary job verification, version 2, mode-0600 output and overwrite rejection. `git diff --check` passes. No hosted CI, public HTTPS deployment, real IPFS retrieval or real-chain execution is claimed for this unpushed candidate.

After independent review, integrated current main `8774f5f` with an ordinary merge. The worker conflict preserves both main's direct-runtime-only batch guard and registry-derived signer authorization. Validation on the integrated tree passes 458 production tests, seven peer PostgreSQL tests and 12 existing inbox PostgreSQL tests with no skips. Independent pre-integration review found no blockers and reran the full production and both PostgreSQL suites. Hosted CI on the published integrated head remains separate validation.

## Interfaces and Dependencies

Reuse installed `@oyaprotocol/messages`, ethers, pg and Node built-ins. No dependency or lockfile change. Peer settings remain `networkId`, `nodeAddress`, `registryFile`, `maxMessages` and `retentionMs`. Registry maximums remain 1 MiB/1,000 entries. Transport expiry remains at most seven days. Admission uses configured `maxTextBytes`; status uses 8,192. `POST /v1/peers/receive` acknowledges atomic receipt/job storage with 202; `POST /v1/peers/status` returns the retained receipt with 200. Both require the signed version-2 envelope. Worker startup optionally accepts `peers` in `worker.json` and validates its node address against the actual Ledger signer. Ordinary `/v1/jobs` authentication and worker execution use the effective explicit-plus-registry signer set.
