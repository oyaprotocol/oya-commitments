# Job-independent Ledger evidence verification

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

Validate a particular Ledger log using its chain, contract, transaction hash and log index, regardless of the submitting application. No saved job, inbox, signature or node installation is required. The reusable verifier and standalone CLI distinguish Ledger record correctness, content availability, byte integrity and application semantics. They provide a foundation for a later node/job reconciliation adapter without implementing that adapter now.

## Progress

- [x] 2026-11-11: Read contribution instructions, existing verifier, receipt/event kernels, operator guides and packaging rules. Created an isolated worktree at the reviewed PR head.
- [x] 2026-11-11: Recorded founder pemulis's scope correction from review comment 4543630696 in thread 4532389443 (21:56:20Z).
- [x] 2026-11-11: Replaced job/status coupling with log selection, generic bounded byte retrieval and explicit correctness levels; updated both CLI paths, docs and Docker allowlist.
- [x] 2026-11-11: Node 24.22.2 clean install passed; 71 focused and 380 full production tests passed, including both guarded CLIs and packaging regressions. Published ethereum 0.2.0 compatibility probe passed. Kernel build, 90 Ethereum tests and standalone Ethereum type check passed without generated drift.
- [x] 2026-11-11: Inspected cumulative source, tests, docs and retained generated kernel artifacts; prepared local commit and publication drafts for parent review.
- [ ] Parent independent review and any publication; kernel release and later caller migration remain separately authorized maintainer work.

## Surprises & Discoveries

Ledger attributes a log to its immediate caller, which can be a contract wallet. Requiring receipt sender/destination to equal the event node/Ledger incorrectly excludes forwarded calls. The published receipt kernel validates receipt/log location; its event decoder supports canonical CIDv1 lowercase Base32 SHA-256 identifiers. Ledger itself accepts opaque strings, so other CID formats remain a documented format limitation, not a claim that those onchain records cannot exist.

The first refactor test run caught a CLI test-guard argument offset and an overly broad import assertion matching the package namespace. Both test harness issues were fixed, then the complete production suite passed.

The production dependency is published `@oyaprotocol/ethereum@0.2.0`, without the new `getAddress` export. Its existing ethers address caller must remain until maintainers release the kernel. Existing kernel helper source, generated artifacts and tests remain in this PR.

## Decision Log

- 2026-11-11 / Hermes: Replace the primary interface in this same PR per founder request. Select exactly one transaction/log index, verify the emitting Ledger and optional expected caller/CID, and allow relay/contract callers. Endpoint settings are independent from record identity.
- 2026-11-11 / Hermes: Treat content as arbitrary bounded bytes. Verify raw CIDv1 SHA-256 bytes directly, or compare an independently supplied `contentSha256` for any supported CID codec. For a non-raw CID without that independent expectation, report `partial`, never verified content. A cat response alone is availability evidence, not a UnixFS DAG proof. Byte integrity does not establish application semantics or truth.
- 2026-11-11 / Hermes: Use only bounded, redirect-refusing RPC and Kubo cat reads, with no retry. Do not implement arbitrary validator plugins or DAG traversal in this bounded change.
- 2026-11-11 / Oya Gardener: Preserve the staged kernel address helper and production ethers import. Founder confirmed the caller may migrate after the maintainer-authorized release; publication is separate work.
- 2026-11-10 / Oya Gardener: The next informational candidate remains an offline official peer-directory validator/inspector with revision checks. Runtime enrollment/fanout is later work. This is not an approval gate and is not implemented here.

## Outcomes & Retrospective

The standalone CLI and reusable module now verify a chosen Ledger record without a job or inbox. Tests exercise binary/JSON/empty/boundary content, forwarded calls, exact log selection, explicit partial integrity, mismatch/unavailable separation, and isolated read-only execution. The previous job-dependent command and its status/signature assumptions are superseded rather than retained as a parallel primary API. Kernel helper files are retained unchanged from the reviewed head, and production still uses published dependencies.

Validation uses real loopback HTTP and spawned CLI processes with simulated RPC/Kubo data, not a live chain or Kubo daemon. Docker packaging inputs and release/upgrade regressions passed; no Docker image build, deployment or publication was performed. Non-raw CID binding, application semantics and future job reconciliation remain explicit limitations rather than inferred successes.

## Context and Orientation

`node/production/src/ledger-evidence.mjs` exposes `verifyLedgerEvidence(record, settings)`. A record identifies a transaction and block-global log index. Settings identify the expected chain and Ledger and operator-approved RPC/Kubo endpoints. `src/verify-ledger.mjs` provides the standalone command; the existing inbox client's `evidence` subcommand is an alias, not an inbox-dependent implementation. Published kernel exports parse receipts and decode events. `packages/ethereum/src/address.ts` is the previously staged checksum helper, not yet usable from production's registry dependency.

## Plan of Work

First extract and refactor the bounded transport and receipt verifier. Add exact log selection, remove sender/destination restrictions, and check receipt-block consistency. Report availability separately from integrity even for corrupt retrieved bytes. Implement raw CID SHA-256 and independent expected-digest checks; explicitly mark unsupported integrity and unassessed semantics. Then replace job fixtures with source-independent binary/JSON/log fixtures, retain negative transport/CLI isolation coverage, and update packaged documentation and Docker input allowlists.

## Concrete Steps

Use Node.js 24. From the repository root run `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`, `node --test node/production/test/ledger-evidence.test.mjs`, and `npm --prefix node/production test`. Confirm production resolves registry ethereum 0.2.0 with no `getAddress` export. Run `npm --prefix packages ci --ignore-scripts --no-audit --no-fund`, `npm --prefix packages run build`, and `node --test packages/ethereum/test/*.test.js` for the retained kernel addition. Run `node packages/node_modules/typescript/bin/tsc -p packages/ethereum/tsconfig.type-test.json`. Check generated outputs for drift. All service fixtures use loopback HTTP; no chain broadcast, release, deployment or GitHub write is authorized.

## Validation and Acceptance

A standalone command must verify bytes for a raw CID with no inbox, job, signature or private key. Forwarded calls, multiple logs and arbitrary binary content must work. Optional expected CID, caller and content digest must be enforced. Missing/duplicate/wrong log identity, invalid input, malformed receipts/events, reverted transactions, inconsistent blocks, wrong bytes, unavailable services, streaming size/deadline violations, redirects and credential isolation must have regression tests. Non-raw content without independent digest must produce an explicit partial result. Both commands must print sanitized JSON with exit codes 0 verified, 2 mismatch, 3 unavailable and 4 partial. Production must test its published dependency, not a local packed replacement. Packaging must include both new runtime modules.

## Idempotence and Recovery

Verification reads two explicit bounded JSON files and at most four HTTP responses. Kubo cat may fetch/cache content as part of retrieval. The command never uploads, pins, signs, submits a job or broadcasts. Repeat explicitly for a fresh observation. No persisted-state migration is involved; revert the feature files to remove it.

## Artifacts and Notes

Detailed test logs and publication drafts are kept outside Git for the parent reviewer. Final Node 24.22.2/npm 11.19.1 clean production install added 30 packages; 71 focused and 380 full tests passed, with zero failures/skips. The reduced count versus the former 95/404 suite reflects removal of job/status/signature-only cases, replaced by source-independent identity, byte-integrity and transport cases. Clean kernel install/build, 90 Ethereum tests and Ethereum type checks passed, with no generated-file drift. Production resolved the registry ethereum 0.2.0 tarball, had no getAddress export, and imported the new module successfully.

Cumulative code/test/generated/executable-config churn is 983 lines, below the 3,000-line cap. All-file totals are recorded separately in the handoff evidence. The upstream advance since this branch point only adds dialogue documentation; it is not removed by this PR. The next informational candidate remains the offline official peer-directory inspector, without a separate approval gate.

## Interfaces and Dependencies

`verifyLedgerEvidence(record, settings)` returns a versioned report with sanitized status/reason/stage, UTC observation time, validated identifiers and explicit `checks`. Record requires `transactionHash` and integer `logIndex`; optional `cid`, `nodeAddress`, `contentSha256` are independent expectations. Settings require `chainId`, `ledgerContract`, `rpcUrl`, `ipfsUrl`, with optional endpoint authorization and bounded deadlines. Unknown fields are rejected before network access. Content correctness is byte identity only; semantic truth and job association remain unassessed. Keep existing package pins and ethers address normalization until the reviewed kernel has been published by maintainers.
