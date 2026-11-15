# Inspect the durable inbox without advancing work

This living ExecPlan follows `PLANS.md`. Feature ID: `inbox-queue-inspect-v1`.

## Purpose / Big Picture

An operator can inspect queue capacity, retained outcomes, expired queued work and the head-of-line processing checkpoint without possessing a client's saved signed job or claiming work. The new authenticated `POST /v1/worker/inspect` and `client.mjs inspect` command produce a bounded JSON snapshot. This supports the safe home-node operation in dialogue Q001 and reliable message logging in Q006. Inspection describes stored state, not worker liveness or independent chain evidence.

## Progress

- [x] 2026-11-15 15:27Z: Read current main instructions, dialogue, peer plans, PR #161 human corrections, #137 evidence history, open issues and discussions. Created isolated branch from main `bda9c5c`.
- [x] 2026-11-15 15:32Z: Implemented the read-only snapshot, target-bound authenticated route and bounded operator CLI.
- [x] 2026-11-15 15:37Z: Passed 12 focused HTTP/CLI tests, all 400 production tests on Node 24.22.3 and Node 26.12.1, and 12 PostgreSQL integration tests on Node 24.22.3. The integration includes the real CLI against the real database, restart, expiry, locks, deadlines and transaction recovery.
- [x] 2026-11-15 15:37Z: Completed operator documentation and implementation self-review.
- [x] 2026-11-15 15:39Z: Finalized measured budget and proposed PR text; prepared the completed implementation for local commit and parent independent review.

## Surprises & Discoveries

`GET /healthz` checks database reachability only. Signed `/v1/status` requires the original job. A processing row blocks later jobs even when its lease expires; unresolved transaction checkpoints must remain intact. Queued expiry is persisted only by `claim`, so inspection must distinguish expired queued rows without performing that sweep. Docker is available for real PostgreSQL validation. An exclusive table lock produced PostgreSQL error `57014` at the inspection deadline; rollback restored normal queries and transaction settings. A target row writer lock did not block the inspection. PostgreSQL serializes JSON timestamps with offsets, so client validation accepts those as well as UTC `Z`.

## Decision Log

- 2026-11-15 / Oya Gardener: Select queue inspection rather than batch evidence or peer publication. Optional batching is already pending in #165; its manifest cannot be a dependency. Peer receipt and receiver-local publication policy require a separate substantial transport design. Inspection supplies independent operator value and does not touch #165's files.
- 2026-11-15 / Oya Gardener: Reuse existing worker authentication and client entrypoint. The credential retains worker authority; this is a read-only operation, not a new read-only credential. No new grants, registry verification or deployment workflow.
- 2026-11-15 / Oya Gardener: Use one aggregate SQL statement in a read-only transaction, a two-second statement deadline and one in-flight inspection per server. Return only explicit operational columns; never payloads, raw transactions, lease identifiers or arbitrary errors. Avoid pagination/history export because capacity and the blocking head answer the first operational question with fixed response size.

## Outcomes & Retrospective

The operator can now retrieve a bounded, authenticated queue snapshot without a saved signed job or a claim. Real PostgreSQL tests demonstrate unchanged full rows, deterministic head ordering, capacity occupied by terminal records, expiry distinctions and safe retry after SQL timeout; the real CLI reads that database through HTTP. Existing transaction-loss recovery tests show the same saved checkpoint before completion and the next queued head afterward. All production regressions pass. Parent independent review and publication remain outside this implementation task.

## Context and Orientation

`node/production/src/inbox/store.mjs` owns PostgreSQL jobs and leases (temporary ownership of processing work). `schema.sql` defines six durable statuses and a unique processing row per target. A target identifies an installation's queue and fixed execution identity. `http.mjs` authenticates `/v1/worker/*` with the existing bearer token. `client.mjs` is shipped inside the image's existing `src` tree. `scripts/test-inbox.mjs` owns a disposable PostgreSQL Docker integration suite; `test/*.test.mjs` is the default unit suite. Root instructions apply; there is no closer AGENTS file. No dependency, schema, signing or environment-format change is needed.

## Plan of Work

Add a focused inspection module with snapshot SQL and bounded token-file reading for the client. Expose it through `InboxStore.inspect()` and a target-bound worker route that accepts exactly `{target}`. Add the existing client's `inspect INBOX_URL TARGET TOKEN_FILE` command, using HTTPS except loopback, redirect rejection, bounded responses and generic failures. Add tests for admission/authentication, query failure cleanup, concurrent inspection rejection, token handling and actual PostgreSQL queue transitions. Extend the existing inbox API guide rather than modifying release assets or deployment guides.

## Concrete Steps

From repository root with Node 24+ and Docker:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/inbox-inspect.test.mjs
    npm --prefix node/production run test:inbox
    npm_config_loglevel=error npm --prefix node/production test
    git diff --check

The integration script creates and removes only its unique disposable PostgreSQL container. No live node, IPFS or chain is required. After implementation an operator runs, from repository root:

    node node/production/src/inbox/client.mjs inspect https://inbox.example.org my-target TOKEN_FILE

`TOKEN_FILE` is an operator-supplied protected file containing only the existing worker token. Exit zero means snapshot retrieval, not queue health; errors exit one without dumping inputs.

## Validation and Acceptance

Assert all six counts, capacity including retained terminal jobs, ready versus expired queued counts, deterministic processing-first head selection and lease/backoff/checkpoint indicators. In PostgreSQL, compare full rows before/after inspection, inspect while a writer holds the target lock, exercise timeout and subsequent recovery, and observe retained checkpoints across worker retry and completion. Confirm another target's records are excluded. HTTP tests reject missing/bad token, wrong target and extra fields before storage; concurrent inspection must not block ordinary worker routes. CLI tests execute the real entrypoint with a local test server and assert no token or remote error leakage, no signing/claim/upload/broadcast and clean retry after failure. Run full production regression tests. Measure all non-Markdown added/deleted lines against the 3,000 cap.

## Idempotence and Recovery

Inspection may be repeated; it does not claim, expire, prune, retry or reset jobs. On SQL failure, roll back and release the connection; destroy a connection whose rollback fails. An HTTP failure requires only a later inspection attempt, not a worker restart. The snapshot can become stale immediately. A stored transaction checkpoint means reconcile using the existing worker/evidence workflow, never clear it or sign a replacement. Rollback consists of reverting the code/image under ordinary operator approval; database state and schema are unchanged.

## Artifacts and Notes

Validation evidence: `npm_config_loglevel=error npm --prefix node/production test` passed 400/400 on Node 24.22.3 and Node 26.12.1. `npm --prefix node/production run test:inbox` passed 12/12 on Node 24.22.3 (11 lifecycle subtests plus their parent). `node --test node/production/test/inbox-inspect.test.mjs` passed 12/12. The PostgreSQL database, HTTP service and client process are real; IPFS/Ethereum in existing recovery fixtures remain controlled transports with real signatures. No live-chain evidence is claimed.

The parent owns publication and independently reviews the local commit. No push, PR, release, deployment, onchain send or automatic merge belongs to this task. Proposed PR text and validation logs remain outside Git in feature-local state. #161's minimal trusted address book and explicit receiver-local policy remain intact.

## Interfaces and Dependencies

`InboxStore.inspect()` returns `{target, observedAt, capacity, counts, queued, head}`. `head` is null when no processing or unexpired queued row exists. Counts describe stored statuses; `queued.expiredPendingSweep` explains rows that the next claim would expire. Checkpoint is `none`, `cid`, or `transaction`; lease state is `active`, `backoff`, or `available`. The snapshot uses the database statement clock. PostgreSQL and existing `pg`, Node builtins and existing HTTP client are sufficient. The published image already copies the entire `src` directory, so the new command and module need no release-script change.
