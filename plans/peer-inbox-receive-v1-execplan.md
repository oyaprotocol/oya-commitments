# Authorize registry members as ordinary v1 publication senders

Feature ID: `peer-inbox-receive-v1`. This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator enables a reviewed registry snapshot on the inbox and worker. A registered node prepares an ordinary v1 signed job, submits it to `/v1/jobs`, and follows publication through `/v1/status`. The worker publishes the original independently signed `{ text, signer, signature }` to IPFS and logs its CID in Ledger mode, using the same authorization, execution identity, transaction limits and checkpoints as any other message. Queue admission is not publication confirmation.

[pemulis's comment 6901246015 on PR #173](https://github.com/oyaprotocol/oya-commitments/pull/173#issuecomment-6901246015), updated November 15, 2026 at 20:57:37 UTC, requests removing the v2 envelope entirely and treating node messages ordinarily, without a unique receiver/network binding. It supersedes the intermediate peer transport and receipt pipeline. His earlier publication correction remains satisfied by the independently signed message and opt-in registry authorization on both roles.

## Progress

- [x] 2026-11-15: Read repository guidance and the selected PR's inherited implementation. Confirmed ordinary v1 jobs already carry both signatures and support registry-member publication.
- [x] 2026-11-15: Removed peer protocol, client/CLI, schema/store, HTTP handlers, proxy paths and cross-store insertion abstraction. Reduced peer configuration to `registryFile` and removed self exclusion and receiver identity checks.
- [x] 2026-11-15: Updated operator guides to use the ordinary CLI and status contract. Kept discovery, image/bundle registry assets and explicit authorization.
- [x] 2026-11-15: Added ordinary-route rejection/recovery tests and adapted real PostgreSQL/CLI/worker integration and signing/transaction failure tests.
- [x] 2026-11-15: Passed 452 production tests, six registry PostgreSQL tests and 12 existing inbox PostgreSQL tests without skips. Built the pinned-base image and passed offline v1 CLI/signature/private-output checks.
- [x] 2026-11-15: Independent review found no blockers and reran 33 focused/packaging, 452 production, six registry PostgreSQL and 12 inbox PostgreSQL tests successfully.
- [ ] Publish the validated follow-up on PR #173 and verify remote head and hosted CI.

## Surprises & Discoveries

The inherited wrapper and receipt store duplicated the ordinary job protocol, queue and status lifecycle. Once unique peer routing was removed, adapting those abstractions would have preserved unnecessary second-pipeline semantics. They are deleted instead. Registry authorization is the only runtime addition besides status recovery at the existing protocol size ceiling.

Ordinary status previously used the current admission text limit. A legitimate historical job could become unqueryable after lowering that limit. Status now verifies against 8,192 bytes, still requiring both signatures, current authorization, the exact target and the stored payload digest. Admission keeps its configured lower limit. HTTP tests cover forgery and over-ceiling rejection; real process integration covers a lower-limit restart.

Ordinary retries return the current job state, not an immutable admission receipt. The integration test follows `queued` to `published` and checks the original signed IPFS object. Tests deliberately use controlled IPFS/RPC services and disposable synthetic identities.

## Decision Log

- 2026-11-15 / Oya Gardener: Follow comment 6901246015 by using existing `signJob`, inbox client and `/v1/jobs` plus `/v1/status` directly. Delete the peer envelope, separate receipt rows and cross-store transaction method rather than rebranding them.
- 2026-11-15 / Oya Gardener: Keep opt-in `peers: { registryFile }` on both roles. Union every registry member with explicit local grants. The founder's ordinary-message semantics require no special self exclusion or receiver/network field. Existing execution identity checks remain ordinary worker safeguards.
- 2026-11-15 / Oya Gardener: Preserve installed, bounded, immutable registry snapshots. Coordinated role restart adopts edits; explicit grants survive registry removal. Directory discovery alone never changes authorization or sends messages.
- 2026-11-15 / Oya Gardener: Reject obsolete peer envelopes/settings rather than silently convert publication intent. Leave experimental historical tables untouched and stop using them. Operators reconcile already queued ordinary work before authorizing replacement requests.
- 2026-11-15 / Oya Gardener: Preserve status recovery after expiry and lower admission limits in the shared ordinary status route. This benefits all signed-job senders without weakening admission, signature or membership checks.

## Outcomes & Retrospective

The local candidate uses one signed-job and execution pipeline. Registry membership authorizes normal publication on inbox and worker startup. Removed peer-specific code has no replacement wrapper. Discovery and release packaging remain available, with ordinary CLI instructions for both host and image use. The full feature is 558 added-plus-deleted non-Markdown lines against fetched main `f51fd93`, below the 3,000-line cap. The complete PR diff from its main merge-base is 725 lines including documentation. A direct tree comparison with main is 815 lines because main also contains 90 unrelated dialogue-document lines absent from this branch; no freshness-only merge is needed.

Informational next candidate, revision November 15, 2026 v3: a separately scoped testnet message/publication/logging review loop using these same v1 commands. As [pemulis clarified in comment 6901487008](https://github.com/oyaprotocol/oya-commitments/pull/173#issuecomment-6901487008), peer liveness and performance verification is later work based on onchain logs, rather than messaging-layer responses or receipts. Before implementation, define recipients, frequency, gas/spend caps, stop conditions and onchain evidence requirements. Deployment and transaction execution require separate authorization.

## Context and Orientation

Production code lives in `node/production`. `src/peers/config.mjs` reads the installed registry and derives the effective signer union. `src/inbox/config.mjs`, `main.mjs` and `worker.mjs` enable that union explicitly at startup. `src/inbox/client.mjs` prepares/submits/queries normal signed jobs. `src/inbox/protocol.mjs` verifies the independently signed message and job signature; `store.mjs` is the ordinary PostgreSQL queue; `processor.mjs` owns publication and transaction recovery. Protocol, client, queue and processor require no peer-specific adapters.

`peers/README.md` describes discovery. `peers/receive.md` explains authorization, compatibility and recovery. The inbox Compose registry overlay and release bundle allowlists install the operator assets. `test/peer-receive.test.mjs` exercises registry authorization and ordinary routes. `test/peer-publication.test.mjs` covers publication and transaction failures. `scripts/test-peer-receive.mjs` launches disposable PostgreSQL and actual inbox/CLI/worker processes.

## Plan of Work

Implementation and independent review are complete. The remaining publication step verifies the existing PR head and source feedback before pushing, then reads back the resulting commit, description and response. Hosted CI is recorded separately from local validation.

## Concrete Steps

From repository root with Node 24 or newer, npm, Python 3 and local Docker:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/peer-receive.test.mjs node/production/test/peer-publication.test.mjs
    npm --prefix node/production test
    node node/production/scripts/test-peer-receive.mjs
    node node/production/scripts/test-inbox.mjs
    docker build -t oya-registry-local:validation node/production
    git diff --check

All suites must pass without skipped tests. Integration scripts create and clean their own loopback PostgreSQL containers. They do not use an operator database. Image acceptance uses `src/inbox/client.mjs` offline with synthetic keys, validates both signatures and exact message bytes, checks mode-0600/exclusive job output, and verifies that `src/peers` contains only the registry loader. Keep validation logs outside Git.

## Validation and Acceptance

Tests must show registry opt-in on both roles, no extra peer routes/tables, ordinary v1 messages accepted and old wrappers rejected. Verify unknown/revoked signers, forged message/job signatures, malformed text, wrong target, expiry, capacity, bounded registry resources and fail-closed configuration. Explicit local grants must remain independent of the registry. Status must authenticate even after expiry and admission-limit reduction.

Real PostgreSQL tests prove concurrent retries create one ordinary row, independent pools serialize capacity, conflicting signed payloads fail, lost HTTP acknowledgements survive database restart, execution identity changes reject, and a database error after insertion rolls back admission. Actual CLI/inbox/worker processes prove registry-only authorization, the original signed IPFS upload, ordinary status progression, restart adoption of revocation and unchanged saved jobs.

Publication failure tests cover IPFS, preparation, signing, lost CID/transaction checkpoint acknowledgements, broadcast failure, pending receipts and reverted/malformed receipts. No broadcast follows an unacknowledged transaction checkpoint; recovery reuses the saved signed transaction. Existing inbox lease, fencing, retention and Ledger recovery tests remain unchanged and pass.

## Idempotence and Recovery

Retain the saved ordinary v1 job after uncertain submission. Retry the exact signed job before expiry or query status afterward while the record is retained. Missing status is not proof of non-publication. Jobs use ordinary capacity, pruning and backup rules. Removing registry grants does not cancel queued or broadcast work; reconcile pending checkpoints and coordinate inbox/worker replica restarts. Explicit grants continue to authorize their senders.

Do not unwrap or automatically republish historical peer requests. Remove obsolete peer configuration fields when upgrading an experimental installation. Keep existing ordinary jobs and reconcile them before authorizing a new request. Without receiver/network binding, the same valid job can be accepted by multiple authorized inboxes sharing its target; choose recipients deliberately rather than claiming cross-node deduplication.

## Artifacts and Notes

Local validation: 15 focused tests, 452 production tests on Node 26.12.1, six registry PostgreSQL tests and 12 existing inbox PostgreSQL tests passed without skips. The pinned Node 24.21.0 image built successfully; all 15 focused tests and its ordinary CLI checks passed with external networking disabled. Production tests include discovery, packaging and upgrade-verifier coverage. No hosted CI, public HTTPS deployment, real IPFS retrieval or real-chain execution is claimed. Earlier candidate validation counts refer to superseded implementations, not this acceptance result.

## Interfaces and Dependencies

No dependency or lockfile changes. Reuse Node built-ins, ethers, pg and the installed Oya packages. Optional `peers` settings contain only `registryFile`. Registries remain capped at 1 MiB/1,000 entries. Ordinary `maxJobs`, `maxTextBytes`, lease, expiry, execution identity and worker credentials govern the queue. HTTP admission is `/v1/jobs` (202); signed execution status is `/v1/status` (200). The ordinary message signer signs the inner text and job envelope. No peer signature, network ID, receiver address, receipt retention settings or peer-specific endpoint is introduced.
