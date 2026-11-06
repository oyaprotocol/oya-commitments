# Verify durable Ledger outcomes against the execution identity

This ExecPlan follows `PLANS.md`. Feature: `testnet-ledger-cid-v1`. Next proposal: `ledger-evidence-v1` (not approved or implemented).

## Purpose / Big Picture

An authorized inbox message already publishes to IPFS, checkpoints a signed transaction, broadcasts it, and verifies a Ledger event. Reuse this implementation. Close a reporting gap: an RPC receipt with the right hash/event but a different sender, destination, or contract-creation address must not complete the job, even as reverted. Add focused recovery evidence and a testnet acceptance guide without deploying anything.

## Progress

- [x] 2026-11-05: Audited main, node processor/protocol/worker, kernel receipt parser/event decoder, Ledger contract, and open PRs #22, #135, #136. No prior marked substantial-feature PR; these PRs do not implement receipt validation.
- [x] 2026-11-05: Installed locked production dependencies in an isolated worktree.
- [x] 2026-11-05: Baseline new suite: 17 expected failures (16 identity cases and worker false completion), 15 passing controls.
- [x] 2026-11-05: Added guard; all 32 new tests and 232 production tests passed on Node 26.12.1. Existing lost-checkpoint-ack coverage retained.
- [x] 2026-11-05: Final production suite: 232 passed; independent focused review: 49 passed. Inspected full diff and PR text; code budget 173 changed lines, overall 281. Prepared review PR with `ledger-evidence-v1` proposal; publication/CI/approval evidence is tracked outside Git.

## Surprises & Discoveries

The requested pipeline exists; duplicating it is unnecessary. `checkLedger` checks chain ID and nonempty bytecode, not implementation authenticity. `validateTransaction` binds signed bytes to chain, node, Ledger and CID. The kernel validates receipt hash and log block/transaction consistency, but only the shapes of receipt sender/destination/creation fields. The processor did not compare these fields with its execution identity.

## Decision Log

2026-11-05 / Oya Gardener: keep the correction in `node/production/src/inbox/processor.mjs`, since this worker requires direct EOA-to-Ledger calls. Do not impose this restriction on generalized kernel users that may use contract wallets. Check identity before both success and revert handling. On inconsistency, retain the existing retry/reconciliation behavior, never discard the durable transaction or sign a replacement. No schema or result-shape change.

## Outcomes & Retrospective

The worker now rejects contradictory receipt identities without marking the job terminal or replacing its transaction. Independent review found no blocking defect; 49 focused inbox/packaging tests passed independently. Added testnet acceptance guidance and bundled it with release assets. Full-suite validation uses mock transports and does not replace hosted Docker/PostgreSQL integration. This is RPC consistency hardening, not proof of an exploit against an honest chain. No real testnet outcome is claimed.

## Context and Orientation

`processWork` validates signed jobs, publishes through the messages kernel, and saves CID and transaction before broadcasting. `runOne` maps exceptions to the inbox retry endpoint. The database retains transaction checkpoints so a later lease resumes the same hash. `packages/ethereum/src/receipt-utils.ts` parses receipts; `ledger.ts` decodes `Log(address,bytes32,string)`. `contracts/src/Ledger.sol` emits that event without authenticating content. The transport fixture runs real signing and kernels but mocks RPC/IPFS.

## Plan of Work

Add a processor regression suite using the existing transport fixture. Cover initial receipt lookup and post-broadcast polling. Reject inconsistent sender/destination/creation fields before terminal results. Exercise honest receipt controls, malformed events, authorization and chain failures, uncertain submission, duplicate broadcast, lost checkpoint acknowledgment and restart. Document a separate testnet-only installation and its acceptance evidence in `node/production/testnet-ledger.md`; link from the task directory.

## Concrete Steps

From repository root: `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`; run `node --test node/production/test/inbox-ledger.test.mjs` before and after the guard; run `npm_config_loglevel=error npm --prefix node/production test`; run `git diff --check`. Measure cumulative additions/deletions against current `origin/main` with `git diff --numstat`, separating Markdown prose from code. Hard limit: 3,000 changed code lines.

## Validation and Acceptance

The new identity tests must fail on baseline and pass with the guard, for both receipt retrieval paths and success/revert statuses. Inconsistent receipts never complete work; retry reuses checkpointed bytes without signing/uploading again. Correct reverted receipts produce failed, never logged. Missing/wrong/removed Ledger events cannot produce logged. Unauthorized jobs do not upload/sign/broadcast. Chain mismatch/empty code prevents signing/broadcast. Full production tests must pass or baseline failures must be identified. Existing Docker/PostgreSQL integration remains the durable-storage gate; mock checkpoint tests are not database tests.

## Idempotence and Recovery

Only an acknowledged transaction checkpoint permits broadcast. Retrying after unknown outcomes must reuse the same raw transaction/hash, not create a new request. Never alter a running inbox identity, queue, deployment, or signer. Roll back software only after stopping the dedicated test worker and reconciling its transaction. No migrations are introduced.

## Artifacts and Notes

No private installation records, RPC credentials, raw signed transactions or operator-specific paths belong in this plan or PR. Docker and Anvil are absent from this local tool PATH; routine verification uses isolated mock transports. Hosted integration CI is checked separately. Live testing remains blocked on explicit testnet selection/RPC, verified Ledger address, exclusive signing credentials, testnet funds and broadcast authorization.

## Interfaces and Dependencies

Keep published kernel versions and public worker result schemas unchanged. The added guard compares normalized `receipt.from`/`receipt.to` with `executionIdentity`, and requires null `receipt.contractAddress`. Signature/allowlist validation, deadlines, queue leases, checkpoints and retry policy remain unchanged. The subsequent read-only evidence-verifier proposal (`ledger-evidence-v1`) is approval-gated, not part of implementation. It would compare a saved signed job and inbox-reported result against independently configured RPC/Kubo evidence, with explicit trusted-provider and no-finality limitations.
