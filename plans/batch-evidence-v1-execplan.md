# Bounded batch member evidence

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

A reviewer can retrieve one manifest and one selected original signed message, verify their content identifiers (CIDs), confirm membership and recover the message signer. An optional Ledger record is checked separately. This completes the publish/log/retrieve/review path described by dialogue Q006 without requiring peer publication work.

## Progress

- [x] 2026-11-15: Read root guidance, production architecture, producer, manifest formats and generic evidence implementation.
- [x] 2026-11-15: Implemented the library, read-only CLI, operator guidance and Docker allowlist.
- [x] 2026-11-15: Resumed unpublished work after fresh discovery at `f51fd93`. PRs #165 and #169 are merged. PR #173 is the only open substantial node feature and owns ordinary v1 registry-authorized publication.
- [x] 2026-11-15: Independent review passed 186 focused and 519 production tests with no failures/skips or code blockers. Parent reran all 519 production tests and passed syntax, whitespace, local image build and offline packaged import checks.
- [x] 2026-11-15: Inspected the cumulative diff and measured 799 changed code/test/config lines against the 3,000-line limit. Reconciled the next candidate with founder comments on #173.
- [x] 2026-11-15: PR #177 published. Assigned head `b843215748c04198bfb607761db24b117cfeda7d` had seven successful CI checks before this follow-up.
- [x] 2026-11-15: Applied founder correction: accept only CID lines, reject both unmerged JSON shapes, and remove obsolete metadata reporting and compatibility guidance.
- [x] 2026-11-15: Validated the correction: 186 focused and 519 production tests passed with no failures or skips. Source/CLI/test syntax and whitespace checks passed.
- [x] 2026-11-15: Reviewed the correction and its regression tests.
- [ ] Verify the published follow-up head and its CI.

## Surprises & Discoveries

The existing verifier already permits forwarding contracts and attributes `Log.node` to the immediate Ledger caller. The previous candidate's reference to transaction signer is incorrect. Manifests are plain LF-separated canonical CIDs. Founder pemulis clarified in PR #177 comment 6901968095 that the JSON format was never merged, so there are no historical JSON formats to support. Generic evidence intentionally permits arbitrary binary content and must remain unchanged.

## Decision Log

- 2026-11-15, Hermes: Select `batch-evidence-v1` from batch logging candidate revision 3. The producer and inspection work are merged in the assigned base. This delivers independently useful read-only review and avoids the peer-publication feature's transport decisions.
- 2026-11-15, Hermes: Reuse bounded transport, CID integrity, input reading and receipt verification from `ledger-evidence.mjs`. Require raw CID binding for both objects. Unsupported codecs produce partial results, never signature-only success. Optional Ledger verification re-reads the manifest using the generic verifier, preserving its independent checks.
- 2026-11-15, Hermes: Supersede the initial JSON-compatibility decision following founder comment 6901968095. Accept only newline-separated CIDs because neither proposed JSON format was merged. Reject both JSON shapes before member or Ledger reads. Select by CID, retain order and report all matching positions. Fetch no other members.

## Outcomes & Retrospective

The read-only review path is implemented and validated. It verifies the original signed member only after both raw CID bindings and manifest membership succeed. Optional Ledger evidence remains a distinct provider-snapshot check. The founder correction removes unneeded JSON parsing and metadata reports while retaining exact CID binding, signed-message validation, bounded reads and independent Ledger checks. The corrected implementation passes all 186 focused and 519 production tests. Remote verification and human review remain. The source implementation is not a deployment.

## Context and Orientation

`node/production/src/batch-logging.mjs` publishes signed message JSON independently, then publishes ordered CID lines and logs the manifest CID. `src/ledger-evidence.mjs` bounds input/network reads, verifies raw SHA-256 CIDs and checks Ledger receipts. `src/verify-ledger.mjs` exposes that generic verifier. New `src/batch-evidence.mjs` and `src/verify-batch.mjs` will compose the same read-only plumbing with the pinned message signature verifier. No signer, worker or journal is needed for review.

## Plan of Work

Expose reusable read/validation primitives without changing generic evidence behavior. Add strict manifest parsing, separate manifest/member/signature/membership checks and optional receipt evidence. Add a standalone CLI accepting two explicit files. Extend the packaged batch guide and Docker source allowlist. Tests will exercise actual signed original bytes and real HTTP with controlled IPFS/RPC transports, including the existing direct producer.

## Concrete Steps

From repository root:

    npm_config_loglevel=error npm ci --prefix node/production --ignore-scripts
    node --test node/production/test/batch-evidence.test.mjs node/production/test/ledger-evidence.test.mjs node/production/test/batch-logging.test.mjs
    npm_config_loglevel=error npm --prefix node/production test
    node --check node/production/src/batch-evidence.mjs
    node --check node/production/src/verify-batch.mjs
    git diff --check
    git diff --numstat

Keep test logs outside Git. Publish the correction on the existing PR #177 branch after review and validation. Verify the exact remote head and current-head CI.

## Validation and Acceptance

Prove exact CID/byte binding before parsing/signature claims; strict CID-line parsing and rejection of both unmerged JSON shapes; bounded count/bytes/time; no URL traversal or recursive member fetching; invalid membership, signature and bytes failures; optional chain/contract/event/caller expectations; forwarding caller distinct from transaction sender; sanitized reports and guarded read-only CLI exit statuses. A local test must publish real signed messages through the production producer, log the manifest using real signed transaction bytes with a controlled RPC, retrieve the preserved originals and review through the CLI. Mocked storage/chain responses do not establish live Kubo, public availability, EVM execution or finality. Run the entire production suite. Cumulative added/deleted code, tests, scripts and config must stay below 3,000 lines.

## Idempotence and Recovery

Review makes bounded reads only and can be repeated. No retries, state writes or ambient key/config loading. Local test directories are disposable and cleaned on exit. Revert the local commit to remove the feature; publication state is unchanged.

## Artifacts and Notes

Before the founder correction, on Node 26.12.1, the focused command passed 186 tests and the production command passed 519, with zero failures or skips. Independent review reran both. Parent independently reran all 519 production tests, both syntax checks and `git diff --cached --check`. A local build from `node/production` using `docker build -t oya-batch-evidence-check .` succeeded. Offline container imports of the library and CLI passed and invalid settings failed closed. These packaging checks do not exercise a live IPFS or EVM service.

Before the founder correction, cumulative code/test/config budget was 799 additions + 0 deletions = 799 lines. The controlled-transport end-to-end test publishes two genuinely signed messages through production HTTP, preserves actual uploaded bytes, prepares/signs one manifest transaction, then runs the guarded CLI to retrieve and review the original message. Transport-provided receipt data is synthetic, not EVM execution or public-chain evidence.

Correction validation on Node 26.12.1: `npm ci --prefix node/production --ignore-scripts` succeeded. The focused and full production commands above passed 186 and 519 tests respectively, with zero failures, cancellations or skips. Syntax checks for the library, CLI and test module and `git diff --check` passed. Docker and live-service checks were not rerun for this correction. Cumulative code/test/config changes now total 782 lines, below the 3,000-line budget. The next feature candidate below is unchanged.

## Interfaces and Dependencies

`verifyBatchEvidence(record, settings)` returns JSON with independent checks and the existing exit status mapping (verified 0, mismatch 2, unavailable 3, partial 4). Record requires `manifestCid`, `memberCid` and optionally `signer`, `ledger: { transactionHash, logIndex, nodeAddress? }`. Settings require explicit `ipfsUrl`, optional authorization/timeouts and optional `ledger: { chainId, ledgerContract, rpcUrl, rpcAuthorization? }`. Ledger settings and record must appear together. No dependencies are added.

## Next feature — candidate when capacity permits

`bounded-node-test-loop-v1`: after PR #173 settles, provide an opt-in bounded operator command that sends normal v1 signed jobs and checks resulting onchain logs and retrieved signed content. This follows founder comments 6901246015 and 6901487008 on that PR. Use the ordinary inbox client, not special peer envelopes or messaging receipts. The current inbox worker logs individual messages and does not support batching. Batch-member review is an optional direct-runtime path, not a dependency of peer acceptance.

Value: expose failures across publication, logging and retrieval. Deliverable: explicit command with finite iteration/time/byte budgets and a JSON summary. Acceptance: keep submission/status observations distinct from verified Ledger/content evidence, preserve saved jobs after uncertain results, and stop safely at configured limits. Components: operator command, ordinary v1 client, generic Ledger evidence, optional batch evidence and focused tests. Estimate 1,000–1,800 changed code/test lines. Dependencies: settled PR #173 and separately authorized destinations/signing for live execution. Tests: isolated local transports, identity failures, interruption, unavailable content and exhausted budgets. Security: explicit signing consent, no ambient funding, automatic public-chain test, arbitrary remote URL traversal or inference of named-peer storage from gateway retrieval.
