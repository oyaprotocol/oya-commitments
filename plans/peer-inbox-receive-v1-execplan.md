# Receive informational peer messages durably

Feature ID: `peer-inbox-receive-v1`. This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator can explicitly enable signed informational reception from an installed trusted peer list, send one saved envelope, and recover the same inbox receipt after a lost acknowledgement or restart. A receipt means retained in PostgreSQL, not processed by the node, published to IPFS, logged onchain, or cryptographically attested by the receiver. Membership never changes publication `allowedSigners`. Receiver-local publication may be designed later. This small message interface supports accessibility and security described in dialogue Q001 and participation through messages in Q006.

## Progress

- [x] 2026-11-15: Read repository instructions, current peer plans, dialogue Q001/Q006, inbox configuration/protocol/store/HTTP, deployment and packaging boundaries. Docker is available.
- [x] 2026-11-15: Wrote this plan before implementation.
- [x] 2026-11-15: Implemented canonical signed protocol, bounded snapshot configuration, isolated PostgreSQL tables and opt-in inbox routes.
- [x] 2026-11-15: Implemented offline exclusive synchronized prepare and explicit submit/status, operator guide, optional registry Compose mount, image whitelist and release/upgrader packaging.
- [x] 2026-11-15: Passed 27 focused peer/packaging tests, all 401 production tests on Node 24.22.3, 6 peer PostgreSQL integration tests and 9 existing inbox PostgreSQL tests. Built the pinned-base image and exercised its offline CLI and Compose overlay. Inspected the complete diff; non-Markdown budget is 702 added/deleted lines.

- [x] 2026-11-15 19:15Z: Reproduced review finding 4579794123 in unit and real PostgreSQL/CLI tests before fixing status recovery after lowering `maxTextBytes`. Passed 28 focused, 402 full production, 6 peer PostgreSQL and 9 inbox PostgreSQL tests on Node 26.12.1.

## Surprises & Discoveries

Status originally reused the current admission byte limit: after lowering `maxTextBytes` to 1 and restarting, the saved CLI envelope could no longer recover its retained receipt. The new unit test failed with `invalid_peer_envelope`, and the real PostgreSQL CLI status command exited 1 before the fix.

Review also caught UTF-8 decoder BOM stripping; bounded file reads now preserve exact text, with unit and real image-CLI coverage.

The first full suite exposed the packaging fixture’s exact file-list assertions; updated them for the new guide and overlay, and the rerun passed all 401 tests. Real PostgreSQL restart and a deliberately severed post-commit HTTP response preserve the original receipt.

The existing `/v1/jobs` path is a publication queue and cannot safely serve informational messages. The image copies only allowlisted `src` files; put the CLI under `src/peers` so a pinned image can run it without distributing host dependencies. Existing registry URLs end in `/v1/jobs`; the sender takes an explicit origin and does not follow registry URLs or fan out.

## Decision Log

- 2026-11-15 / Hermes: Use separate peer tables and modules, sharing only the PostgreSQL pool and existing HTTP admission bounds. This avoids worker/publication coupling and competing inbox-inspection work.
- 2026-11-15 / Hermes: Sign a fixed ordered JSON array prefixed with operation/domain/version. Include network ID, receiver public address, exact target, UUID, expiry, text and sender. Store an immutable normalized object and its SHA-256 digest. Status reuses that signature and requires current membership but permits expired envelopes.
- 2026-11-15 / Hermes: Retain until the later of signed expiry and acceptance plus configured retention. Serialize operations per target; enforce capacity before insert; prune only expired retention records. Persist network/receiver binding per target to reject wrong-context restarts. Receipt identity includes digest and all routing identities.
- 2026-11-15 / Hermes: Install a local plain registry snapshot at startup, without fetching or enrollment machinery. Changes require restart. Sender uses HTTPS (loopback HTTP for local tests), no credentials or redirects, bounded bodies and deadlines. Only offline prepare reads a sender key. No inbox signing key is introduced.

- 2026-11-15 / Hermes: Validate status against the existing 8,192-byte protocol ceiling rather than the operator’s current admission limit. Preserve signature/domain/receiver/target checks, current registry membership, retained-row lookup and exact digest matching. Admission still uses the configured limit.

## Outcomes & Retrospective

Initial implementation delivered reception and recovery end to end. Node 24.22.3 full production suite passes 401 tests; real Docker PostgreSQL peer integration passes 6 tests, and existing inbox integration passes 9. Local image build, protocol/client/schema smoke, network-disabled image CLI preparation and Compose mount checks pass. Independent review found no blockers and reran these suites, the image build and offline CLI checks. The complete diff and 702-line non-Markdown budget are checked. Human review and merge remain required. Releases, deployment and live peer sends require separate operator authorization.

Review follow-up fixes recovery when admission policy shrinks. Regression coverage checks an expired 8,192-byte UTF-8 envelope, rejects 8,193 bytes and invalid authentication before database access, and checks missing or mismatched receipts. Real PostgreSQL coverage accepts through the CLI, lowers the limit to 1, restarts the inbox, recovers the identical receipt and rejects resubmission; subsequent registry revocation still blocks status. All four validation suites pass without skips on Node 26.12.1. Independent review found no blockers and reran all 28 focused tests. The complete feature is 738 non-Markdown added/deleted lines against current main `6887779b531b54fa08dcb4bd436cbedbd8560e42` (PR merge base `7f40c242759eedad9aa079aad8f324a99f445db5`), below the 3,000-line ceiling.

## Context and Orientation

Production code lives in `node/production`. `src/inbox/main.mjs` loads configuration and PostgreSQL; `http.mjs` authenticates publication jobs and worker requests. `src/inbox/store.mjs` owns publication checkpoints and is not changed by this feature. `peers/testnet-directory.json` is the plain trusted `{nodeAddress,url,target}` list. The current direction is the first fifteen lines of `plans/peer-node-network-execplan.md`; everything below is superseded history. Optional batching is already separate work.

## Plan of Work

First add `src/peers/protocol.mjs`, `config.mjs`, `store.mjs` and `schema.sql`, plus minimal inbox parser/startup/route wiring. Add focused unit tests for exact bindings, immutable validation, unknown/revoked/self senders, expiry, bounds and disabled compatibility. Then add `client.mjs` and `cli.mjs`, with exclusive mode-0600 synchronized envelope persistence before any network request. Add the guide to release/upgrader allowlists and the modules to Docker inputs, and expose only the two exact peer routes in Caddy. Finally add a disposable PostgreSQL integration script proving CLI→HTTP→database, concurrency, recovery and no publication rows. Keep all non-Markdown added/deleted lines below 3,000 (aim 1,500–2,200).

## Concrete Steps

From repository root with Node 24, npm, Python 3 and Docker:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/peer-receive*.test.mjs
    npm --prefix node/production test
    node node/production/scripts/test-peer-receive.mjs
    git diff --check

Use `npm_config_loglevel=error` for validation to avoid npm notices affecting existing subprocess fixtures. Save complete validation logs outside the worktree. Integration starts only disposable loopback PostgreSQL with synthetic wallets, and cleans it up. No live RPC, IPFS service or real signing keys are needed.

## Validation and Acceptance

Tests must prove valid receipt and identical retry; conflicting same-ID payload; network/receiver/target/operation/signature tampering; unknown, revoked and self senders including explicitly publication-authorized peers; expiry and byte bounds; disabled routing; bounded registry and immutable snapshot; client timeout/redirect/response identity failure; exclusive private preparation and unchanged retry bytes. Real PostgreSQL must prove concurrent capacity, stable receipt after service/database restart and lost acknowledgement, wrong-context startup rejection, retention/pruning independent of publication checkpoints, and zero publication jobs for peer sends. Full production and packaging tests must pass.

## Idempotence and Recovery

Keep the original saved envelope after any submit error: a timeout may follow a committed acceptance. Query status or resubmit those exact bytes before expiry. After expiry use signed status while retained. A missing receipt after retention or database loss is unknown history, not proof of non-reception. Revocation blocks new admission and status immediately on deliberate restart. Re-enable only with an operator-approved list. Disable `peers` to stop peer routes without deleting records. Changing network or receiver requires a new target. Prune removes only retention-expired peer records and never publication checkpoints.

## Artifacts and Notes

Initial implementation validation: `node --test node/production/test/peer-receive.test.mjs node/production/test/publish-image.test.mjs` passes 27 tests; `npm --prefix node/production test` passes 401; `node node/production/scripts/test-peer-receive.mjs` passes 6; `node node/production/scripts/test-inbox.mjs` passes 9. All pass without skips. Local Docker build and image CLI preparation pass, including exact UTF-8/BOM preservation, mode-0600 output, and the read-only/no-create registry mount. `git diff --check` and shell syntax checks pass. Full validation logs and computed per-file budget are retained privately outside the worktree. Synthetic test identities are generated locally and disposable containers are removed. Public HTTPS deployment, real peer enrollment, automatic sending and publication are not exercised by this local milestone.

Review follow-up validation uses the same commands above: focused peer/packaging 28 passed, full production 402 passed, peer PostgreSQL 6 passed and inbox PostgreSQL 9 passed, all with no skips. Before the fix, the new unit regression and PostgreSQL CLI recovery failed; after the fix both pass. `git diff --check` passes.

## Interfaces and Dependencies

Optional inbox `peers` settings: `networkId`, `nodeAddress`, `registryFile`, `maxMessages` (default 1,000, maximum 100,000), `retentionMs` (default seven days, maximum thirty days). Existing target and text limit apply to admission. Status uses the 8,192-byte protocol ceiling so lowering the admission limit cannot hide retained receipts. Both paths retain authentication and membership checks. Registry reads are capped at 1 MiB and 1,000 records. Protocol expiry is at most seven days ahead. `POST /v1/peers/receive` returns HTTP 202; `POST /v1/peers/status` returns HTTP 200. Both require the signed envelope. No worker token is sent. Reuse installed ethers, pg and Node built-ins only.

## Next feature — candidate when capacity permits

`peer-local-publication-v1`: optional receiver-local selection of accepted informational messages for publication. Value: operators can log useful peer information without granting peer-controlled publication authority. Deliverable: explicit local policy and durable promotion bridge preserving original envelope identity and existing worker checkpoints. Acceptance: policy denial has no publication effects; allowed promotion survives crashes without duplicate logical jobs; revocation, changed context and transaction recovery remain safe. Components: peer store, local policy, bridge tests and guide. Estimate 1,800–2,600 added/deleted non-Markdown lines, re-estimate before selection. Depends on this receipt milestone and coordination with batching/inbox inspection. Security: registry membership alone never modifies `allowedSigners`; do not execute message text, automatically reply, forward, or invent receiver evidence. This is a candidate, not work in this feature.
