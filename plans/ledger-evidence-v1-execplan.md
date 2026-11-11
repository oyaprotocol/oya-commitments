# Read-only Ledger evidence for saved inbox jobs

This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator can run the inbox client's `evidence` command with a saved signed job and independently supplied Ledger identity and read endpoints. It reports verified snapshot consistency, contradictory evidence, or unavailable evidence without a signing key. A verified report binds the expected signed message to a logged CID and the expected publishing node at an observed block.

## Progress

- [x] 2026-11-10: Read repository guidance, Q001, inbox protocol/status/client, receipt parser and Ledger decoder; installed pinned production dependencies with scripts disabled.
- [x] 2026-11-10 18:49Z: Implemented bounded read-only evidence module and client command.
- [x] 2026-11-10 18:49Z: Added adversarial and real-loopback CLI tests, a signing/file/environment access guard, and operator docs.
- [x] 2026-11-10 18:51Z: Focused tests passed (93/93) and full production suites passed (402/402) on both Node 24.22.2 and Node 26.12.1.
- [x] 2026-11-10: Independent review found one input-classification issue; malformed readable JSON/UTF-8 now returns mismatch, with CLI regression coverage. Final Node 24 focused/full suites passed (93/402 tests).
- [x] 2026-11-10: Reviewed the original evidence diff for human PR review.
- [x] 2026-11-11 20:59Z: Added the checksum-aware Ethereum kernel helper, package-root export, generated files and unit tests; retained the existing ethers evidence caller and added address-input regressions.
- [x] 2026-11-11 20:59Z: Node 24.22.2 clean installs, all-kernel build, 212 kernel tests, standalone type checks, package-root smoke and independent archive-consumer checks passed. Production used published ethereum 0.2.0: 95 focused and 404 full tests passed.
- [ ] After a maintainer-authorized kernel release, separately upgrade the production exact dependency and lockfile, migrate the evidence caller, and rerun clean-install validation.

## Surprises & Discoveries

The current public status has no target field: it is scoped by the original signed envelope sent to the operator-approved inbox origin. It includes a request ID and independent checkpoint/result CID and transaction hash. The existing kernel exports a read-only receipt reader and Ledger decoder; its receipt parser checks receipt/log block and transaction identity. The original evidence implementation needed no kernel changes; founder review subsequently requested a reusable address normalizer.

The first success test failed at receipt parsing because the kernel reader expects complete retry/deadline settings. Explicit `maxRetries: 0`, `retryDelayMs: 0` and a bounded timeout fixed it; the adapter parses the already bounded RPC result without further network access. CLI tests also revealed that Node's loader uses public filesystem reads: the preload guard permits runtime module loading while denying private file reads, file mutations, signing and OYA environment access. All guarded CLI exit-code cases now pass.

The existing `.dockerignore` already includes `src/inbox/*.mjs`, and the release bundle already includes `README.md` and `inbox-api.md`. No packaging changes are required; the full suite includes packaging/upgrade regressions.

## Decision Log

- 2026-11-11 / Oya Gardener: Stage the kernel addition separately from its caller migration. At 20:53Z, founder pemulis confirmed that the existing caller can remain in the kernel release and migrate in a follow-up. Production stays pinned to published `@oyaprotocol/ethereum@0.2.0`, whose root has no `getAddress` export. Keep the ethers import until maintainers publish the reviewed kernel and a subsequent change updates the exact production dependency/lockfile. No package publication is part of this change.
- 2026-11-11 / Oya Gardener: Preserve hex and direct ICAP compatibility in the pure helper, validate checksums before normalizing, and use the existing pinned Noble dependency. Zero remains valid in the kernel; evidence retains its nonzero policy.

- 2026-11-10 / Oya Gardener: Compared merged PR #142's full peer-network plan (including the official Git-hosted testnet directory) with #137's evidence candidate against current main. Choose usable evidence checks for existing operators first: full peer delivery couples membership, authorization/preflight, maintenance, durable fanout and destination safety. The next bounded candidate is an offline official directory validator/inspector with revision checks; runtime enrollment remains later. The current development policy removes separate plan approval, while human PR review and deployment authorization remain required.
- 2026-11-10 / Hermes: Use the existing read-only receipt kernel with a bounded transport, no retry, and decodeLedgerEvent. Reuse validateJob with checkExpiry false. Avoid importing the processor or worker.
- 2026-11-10 / Hermes: Supply trusted identity and endpoints through a strict separate JSON settings file, never status-derived URLs or environment credentials. Require independent target, chain, Ledger and node values. This keeps the command usable and dependency surface small, following dialogue Q001's accessibility/security emphasis.
- 2026-11-10 / Hermes: Implement snapshot consistency rather than peer availability. Trust the chosen RPC/Kubo; do not claim finality, trustless UnixFS CID verification, or causal proof that this request caused the transaction. Peer directory, fanout and authorization policy remain separate work.

## Outcomes & Retrospective

The command now produces working JSON reports and distinct exit codes, exercised through real loopback HTTP servers and child-process CLI runs. Both signed envelope layers are checked, including historical expiry; independent chain/Ledger/node identity, receipt/log location and exact retrieved fields are enforced. Request and body limits, deadlines, redirect refusal, credential isolation and sanitized errors have permanent failure coverage. Existing client APIs remain intact. The staged follow-up adds a pure kernel address helper while retaining the working ethers caller. Production dependencies and lockfile remain unchanged; the caller migration awaits a maintainer release.

Validation uses local simulated RPC/Kubo/status responses with real cryptographic signatures and the published receipt/event parsers. No live-chain, actual Kubo/PostgreSQL container integration or Docker image build was run for this feature; production ESM has no build step. The trust/availability limitations are explicit in the operator guide. Kernel publication requires separate maintainer authorization.

## Context and Orientation

Production ESM code lives in `node/production/src/inbox/`. `client.mjs` already creates signed jobs and calls status. `protocol.mjs` verifies the message signature and enclosing request signature. `store.mjs` returns public status for the exact signed job, even after expiry. `@oyaprotocol/ethereum` exports receipt parsing through ethGetTransactionReceipt and validates Ledger Log events through decodeLedgerEvent. The receipt is a transaction's mined result; its logs carry the emitting contract, node address and CID (IPFS content identifier).

## Plan of Work

The staged review follow-up adds `getAddress(value: unknown): string` in `packages/ethereum/src/address.ts`, exports it from the package root, rebuilds tracked `dist` files, and tests ERC-55 checksums and direct ICAP (base-36 address encoding). Retain `node/production/src/inbox/evidence.mjs` unchanged and add invalid-address and alternate-spelling regressions against its existing ethers implementation. After the helper is published, migrate that caller in a separately validated follow-up.

Add `evidence.mjs` for strict input validation, bounded HTTP reads, RPC/status/content checks, and sanitized reports. Add an `evidence JOB_FILE SETTINGS_FILE` branch to the existing client while preserving its APIs. Add `test/ledger-evidence.test.mjs` using real signatures, adversarial responses and local HTTP servers. Document the command in the existing packaged inbox API guide and task index.

## Concrete Steps

Use Node.js 24 for this follow-up. From the repository root run `npm --prefix packages ci --ignore-scripts --no-audit --no-fund`, `npm --prefix packages run build`, and `node --test packages/{ethereum,messages,ipfs,utils}/test/*.test.js`. Run `node packages/node_modules/typescript/bin/tsc -p packages/ethereum/tsconfig.type-test.json` and the equivalent `packages/messages/tsconfig.type-test.json` command. From `packages/ethereum`, smoke-import the package root with `node --input-type=module -e "import { getAddress } from '@oyaprotocol/ethereum'; console.log(getAddress('0x8ba1f109551bd432803012645ac136ddd64dba72'))"`. Run `npm --prefix packages run test:release` for independent archive-consumer validation; its temporary installation is separate from production.

Clean-install production from its unchanged lockfile using the command below. Confirm its installed Ethereum package is registry `0.2.0`, lacks `getAddress`, and still loads the evidence module. Do not replace production dependencies with a local packed kernel.

From the repository root run `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`, then `node --test node/production/test/ledger-evidence.test.mjs`, then `npm --prefix node/production test`. No build script exists for this ESM runtime. Use Node 24 if installed. Run `git diff --check` and inspect all changed/new files before local commit. Tests must use disposable fixtures and loopback servers, never production endpoints.

## Validation and Acceptance

Valid and historically expired envelopes verify. Invalid inner/outer signatures fail before HTTP. Wrong target/request/chain/node/contract/hash/CID/content, malformed/removed logs and inconsistent block data report mismatch. Missing receipts/content, pending/publication-only states, transport failure/timeouts/oversize report unavailable. Real CLI tests assert JSON output and distinct exit codes, no raw payloads/errors/credentials, and exact read-only routes/methods with no retries. Body/file caps and deadlines include body streaming; redirects are rejected.

## Idempotence and Recovery

The command only reads saved files and performs status, receipt, block and Kubo cat reads. Repeating it obtains a new snapshot and cannot submit jobs, upload content, sign, or broadcast. A failed check requires operator inspection rather than automatic retries. Remove these feature files and the client/docs additions to revert; no persisted state migration is required.

## Artifacts and Notes

Staged follow-up, Node 24.22.2/npm 11.19.1: clean kernel and production installs added 7 and 30 packages; build, 212 kernel tests, both standalone type checks, package-root smoke, and independent archive-consumer validation passed. The focused evidence suite passed 95 tests and the full production suite passed 404, with zero failures/skips. A separate compatibility probe compared 256 deterministic addresses across seven spellings (1,792 comparisons) with installed ethers. It also confirmed production resolves the published Ethereum 0.2.0 tarball, has no new export, and successfully imports the unchanged evidence module. Production tests never used a packed replacement. The next informational candidate remains the offline official peer-directory validator/inspector described in the Decision Log.

Original evidence validation (before this follow-up):

Pinned install completed: 30 packages added with `npm ci --ignore-scripts --no-audit --no-fund` in `node/production`. Focused command `node --test node/production/test/ledger-evidence.test.mjs` passed 93 tests on each of Node 24.22.2 and 26.12.1. Full command `npm --prefix node/production test` passed 402 tests on each version, with zero failures or skips. After the final test-guard tightening, the focused suite passed again on both versions. `git diff --check` passed. Code/test churn is 610 additions plus 2 deletions (612 lines), below the 3,000-line limit. Independent review found no blocking security defect; its malformed-input classification finding was fixed, with final Node 24 focused/full reruns passing 93/402 tests.

## Interfaces and Dependencies

Keep existing pinned dependencies. The source kernel gains `getAddress(value: unknown): string`, using existing `@noble/hashes@2.2.0`; it is not present in published ethereum 0.2.0. Production continues using ethers `getAddress` until the maintainer release and follow-up migration. Export `verifyLedgerEvidence(job, settings)` and a bounded JSON file reader for the client. Reports carry schema version, status/reason/stage, observation time and checked block identity, plus only validated public identifiers. Exit codes: 0 verified, 2 mismatch, 3 unavailable. Settings contain target, inboxUrl, chainId, ledgerContract, nodeAddress, rpcUrl, ipfsUrl, optional endpoint authorization and bounded timeout settings. No signer configuration is accepted.
