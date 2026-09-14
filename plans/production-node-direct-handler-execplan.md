# Simplify the production node to one publish-and-log operation at a time

This ExecPlan follows `PLANS.md`. **Status: both milestones implemented and validated; milestone 2 is ready for user review.** Work was executed one milestone at a time, with user agreement before proceeding. Further integrations and public deployment require a separate scope.

The subsequent [local operations plan](local-log-node-operations-execplan.md) covers deployment/reuse tooling and a complete separate-process sender-to-node validation through `npm --prefix node/production run test:local`. This plan's smoke remains the direct-handler regression test.

## Purpose / Big Picture

The production node should authenticate an HTTP message, call the existing kernel's `publishAndLogSignedMessage` operation directly from the HTTP adapter, and return its final success or failure. Process only one complete operation at a time, covering IPFS publication, transaction preparation, signing, submission, and receipt verification. Additional authenticated requests receive `503 node_busy`; there is no waiting queue.

Remove the host's publication journal, persisted intermediate progress, duplicate suppression, and startup replay. Keep ethers for local transaction signing. Reuse the existing kernel APIs without modification. Kernel signing support remains a separate future discussion.

This replaces the earlier concurrency proposal. No nonce override, nonce allocator, coordinator module, queue capacity settings, or kernel changes are needed.

## Progress

- [x] 2026-09-07 20:50Z: Inspected the current runtime and kernel interfaces and drafted the initial proposal.
- [x] 2026-09-07 21:17Z: Revised the plan at commit `6383770` on branch `09072026` to remove concurrent processing and waiting queues, following the user's request for simplification.
- [x] 2026-09-07: User approved the revised plan and authorized milestone 1.
- [x] 2026-09-07 21:50Z: Milestone 1: Use the direct combined handler with one active operation and remove host persistence; all 21 host tests pass.
- [x] 2026-09-07 22:17Z: Removed legacy `stateDir` support and the retained `202 Accepted` response following user review. All 20 remaining host tests and `git diff --check` pass.
- [x] 2026-09-07 23:01Z: User accepted milestone 1 and authorized milestone 2.
- [x] 2026-09-07 23:04Z: Milestone 2: Updated the local end-to-end smoke and operator documentation; 20 host tests, the contract build, the real Anvil/Kubo smoke, and `git diff --check` pass.

Milestone 2 authorizes the local smoke rewrite, validation against disposable Anvil/Kubo, and operator documentation. Public deployment and further integrations remain outside this plan.

## Surprises & Discoveries

- `packages/messages/src/handlers/publish-and-log.ts` already combines publication, Logger submission, and receipt verification. Its `PublishAndLogSignedMessageError` exposes the published artifact and any known transaction hash.
- `packages/messages/src/ingress.ts` invokes `onAcceptedMessage` after schema validation, signature verification, and allowlist authorization. This is the appropriate boundary for the active-operation guard.
- `packages/ethereum/src/transaction-preparer.ts` reads the account's pending nonce for each preparation. Serializing the complete operation lets the node use this existing behavior without assigning nonces itself.
- A receipt timeout can leave a transaction pending or mined. Even with a single active HTTP operation, an uncertain transaction must be accounted for before starting another operation with the same account.
- Removing persistence also removes durable deduplication and restart recovery. Returning an HTTP failure cannot roll back IPFS publication or blockchain submission.
- Milestone 1 temporarily left the smoke's store import and journal assertions incompatible with the runtime. Milestone 2 removed those imports and assertions; the real smoke now passes against the direct handler.
- Shutdown must explicitly await the host's active promise: an accepted request can outlive its disconnected HTTP client. Tests hold the receipt response after disconnect and prove `close()` waits for the final result. Replies issued during shutdown also close their connection to avoid an unnecessary keepalive wait.
- The user clarified that this runtime has no existing users or deployments requiring backward compatibility. Config deprecation handling, migration guidance, and preserving the old HTTP success status are unnecessary.
- The real smoke verifies busy admission only after Anvil reports a pending transaction, then checks the pending hash list and account nonce remain unchanged after two rejected requests. It subsequently verifies four mined publications, including distinct transactions for the same signed envelope and CID.
- CLI startup now runs in the default smoke. Its child environment removes inherited Oya keys and provider authorization values so the generated temporary `.env` determines the test identity, regardless of the operator's shell environment.

## Decision Log

- Decision: Call `publishAndLogSignedMessage` from the HTTP adapter's accepted-message callback. Rationale: reuse the existing complete kernel operation. Date/Author: 2026-09-07 / user requirement, recorded by Codex.
- Decision: Remove the publication journal, stored signed transactions, and startup replay. Rationale: the host should return the operation's final result without persisting intermediate progress. Date/Author: 2026-09-07 / user requirement.
- Decision: Process one full operation at a time. Rationale: the user withdrew the concurrency requirement to simplify the design. Date/Author: 2026-09-07 / user requirement.
- Decision: Return `503 node_busy` for additional authenticated requests instead of retaining a waiting queue. Rationale: match the original one-operation behavior and remove scheduling configuration and queue lifecycle code. Date/Author: 2026-09-07 / Codex, approved by user.
- Decision: Keep ethers in the runtime and make no kernel or dependency changes. Rationale: host signing is accepted for now, and serialization removes the proposed need for a kernel nonce override. Date/Author: 2026-09-07 / user requirements and revised design.
- Decision: Treat repeated valid messages as independent submissions, and pause further work after a transaction outcome becomes uncertain. Rationale: use the combined handler's existing semantics without rebuilding persistence or retry orchestration. Date/Author: 2026-09-07 / Codex, approved by user.
- Decision: Return a `{ server, close }` runtime from `createNodeServer`; `startNode` constructs the preparer and starts that server. Rationale: keep the single-operation guard and its shutdown drain together. Optional transport and final-result logging callbacks let tests use the real kernels and ethers signer without live providers or changes to globals. Date/Author: 2026-09-07 / Codex.
- Decision: Remove the `stateDir` option, its warning callback, and its compatibility tests; return HTTP `200` with `status: "logged"` after verified completion. Rationale: this new runtime needs no backward compatibility. The kernel ingress's internal `202` result remains part of its existing API and is mapped by the host to completed HTTP success. Date/Author: 2026-09-07 / user clarification, implemented by Codex.
- Decision: Decode actual Logger events with ethers assertions in the smoke and check CLI startup on every smoke run. Rationale: validate the deployed contract's event fields independently of the runtime's kernel verification and make the ordinary validation command cover the real entrypoint. `--keep-running` only changes whether the validated services remain available. Date/Author: 2026-09-07 / Codex.

## Outcomes & Retrospective

Milestone 1 is implemented. The HTTP accepted-message callback calls `publishAndLogSignedMessage` directly, admits one operation at a time, returns its final result, and holds admission through response preparation. The host no longer imports or contains `src/publication.mjs` or `src/store.mjs`; both were deleted. Startup retains chain/bytecode validation and now constructs the kernel transaction preparer directly. Ethers signing, all dependencies and lockfiles, kernel sources and build output, and contracts are unchanged.

All 20 current host tests pass using actual loopback HTTP and the real kernels/preparer/signer with controlled IPFS and RPC responses. User review removed the legacy-state test and compatibility handling, and changed completed HTTP success to `200` / `logged`. The tests cover authentication and request bounds, full-operation exclusion, independent duplicate submissions, definite and uncertain failures, deadlines, shutdown/disconnects, startup checks, and config validation. Tests also verify sanitized failures and no host recovery calls. `git diff --check` passes.

Milestone 2 is complete. The real smoke deployed Logger on disposable Anvil, published and retrieved four signed envelopes through offline Kubo, verified the exact Logger event fields, rejected busy requests without adding a transaction, admitted the rejected request after completion, and created a new event for an identical completed message. Invalid-signature rejection, startup chain/bytecode checks, and the actual CLI entrypoint also passed. The contract build succeeded with Logger runtime size 395 bytes. All services created by this smoke were stopped; no public network or user credentials were used.

The operator guide now describes the direct handler, exclusive signing account, busy responses, deadlines and partial outcomes, independent repeated submissions, absence of persistence, and ethers signing. `node/README.md` and the historical implementation plan point to the current behavior. This milestone changes only the smoke and documentation; kernel APIs, runtime implementation, dependencies, signer, and contracts remain unchanged. Both milestones meet the plan's acceptance criteria and are ready for review.

## Context and Orientation

The runtime is an independent package at `node/production/`. After milestone 1, `src/main.mjs` loads configuration and the ethers signer, checks the chain and Logger bytecode, constructs the kernel transaction preparer, and starts the server. `src/server.mjs` owns HTTP stream bounds, kernel ingress, the direct combined callback, admission, and draining. The former publication coordinator and JSON store are deleted. `src/signer.mjs` signs locally and does not broadcast. `test/runtime-fixture.mjs` supplies mock transports shared by the HTTP tests; production still uses global fetch by default.

The relevant kernel entrypoints are `@oyaprotocol/messages`, `@oyaprotocol/ipfs`, and `@oyaprotocol/ethereum`. The combined handler accepts IPFS options, Logger options including a `TransactionPreparer`, and one optional cancellation signal. Its successful result contains publication metadata and a checked Logger receipt. Continue authenticating through `handleSignedMessage`; the combined helper alone does not enforce the node's allowlist.

### Request flow

The server bounds and reads the request, then invokes `handleSignedMessage`. Inside `onAcceptedMessage`, reject with `503 node_busy` if another operation is active. Otherwise set the guard before the first await and call `publishAndLogSignedMessage` exactly once with the configured IPFS/RPC dependencies and existing transaction preparer. Hold the guard through the entire operation, including receipt verification and final response preparation. HTTP parsing and health requests can still be served while the operation runs; publication operations do not overlap.

Return HTTP `200` with `status: "logged"` after checked mined execution. Map the kernel ingress's internal successful `202` result to this completed HTTP response. Keep the small `publication` summary: `status: "logged"`, CID, IPFS URI, transaction hash, decimal block number, node address, and Logger address. Remove the stored-message `messageId`. Do not expose raw provider responses, signed transaction bytes, or unconverted receipt `bigint` values.

Use the current `createTransactionPreparer` with the current ethers signer. Let the kernel select the pending nonce for every call. Do not intercept RPC requests, override signing nonces, add an outer retry loop, split publication from logging, or duplicate Logger-event verification in the host.

### Failure, timeout, and shutdown policy

Preserve kernel validation/authentication statuses. Busy and shutdown rejections occur before publication and may include `started: false` plus a short `Retry-After`. For attempted operations, return sanitized `502` responses for upstream failures and `504` for operation or receipt deadlines, with any known CID/hash and an accurate indication of whether logging is known to have failed or its outcome is unknown. Unexpected programming faults remain `500`. Do not advise automatic full-request retries after work has started.

A failure before transaction preparation/submission can release the guard normally. A kernel-validated mined receipt establishes nonce consumption even if execution reverted or the expected event is absent; that operation returns failure, and later requests may proceed. Determine this from the typed error's already-parsed receipt, without adding another host receipt query or event-verification routine.

If the combined handler reports a known transaction hash without a validated mined receipt, return failure with an unknown logging outcome, clear the active promise, and latch an in-memory unavailable state. Subsequent authenticated requests receive `503 transaction_outcome_unknown`; health reports unavailable. Do not automatically resume, replay, rebroadcast, or replace the transaction. The operator must reconcile it and deliberately restart before reusing the account. This small failure flag is retained because serialization alone does not resolve an ambiguous submission. Unexpected errors that cannot establish whether submission occurred should also fail closed.

Keep the existing body/transport/receipt timeouts. Use `operationTimeoutMs`, default 180000, as the overall deadline passed via the combined helper's top-level signal. A disconnected client does not release the active guard or cancel an already-started operation: finish it or reach its deadline and emit a final sanitized result. This prevents disconnects from allowing overlapping transactions.

SIGINT/SIGTERM stops admission and drains the active operation within its deadline, including when its client has disconnected. There are no queued jobs to cancel and no state lock to release. Health reports ready, busy, or transaction-outcome-unknown; it is not a continuous RPC/IPFS health probe.

### Operational consequences

- Repeating a valid request is another operation and can create another Logger event and gas charge, even when the same signed envelope produces the same IPFS CID. Durable duplicate suppression is removed with the journal.
- An HTTP error or lost connection is not proof that nothing happened. Use returned CID/hash information to inspect uncertain outcomes before retrying. There is no rollback or exactly-once guarantee.
- One process must exclusively use the node signing account. There is no coordination with other processes or wallets using that account.
- Restart loses in-memory work and the failure flag. It is not a reconciliation mechanism and does not restore the result of a lost HTTP request. Additional confirmation depth and chain-reorganization handling remain outside this change.

## Plan of Work

### Milestone 1: Direct HTTP composition with one active operation

After approval, update `node/production/src/server.mjs` so its accepted-message callback directly calls `publishAndLogSignedMessage`, guarded across the complete operation. Keep stream bounds and kernel authorization. Implement the success/error mapping, uncertainty flag, deadline, and active-operation draining described above. Keep these as small host responsibilities rather than a new publication coordinator.

Update `src/main.mjs` to construct the existing kernel transaction preparer and pass it to the HTTP adapter. Remove `openStore` and startup replay. Preserve chain/bytecode startup checks and the ethers signing adapter. Remove `src/publication.mjs` and `src/store.mjs` after their runtime consumers are removed.

Update `src/config.mjs` and `config.example.json` for `operationTimeoutMs` and remove `stateDir` entirely. Existing strict config validation rejects unsupported fields; add no special checks, warnings, or migration behavior for removed options. Keep the submission script's success check and the documented response example aligned with HTTP `200` / `logged`.

Revise `test/runtime.test.mjs` and replace the journal-dependent tests in `test/publication.test.mjs` with tests of the combined HTTP flow. Cover success, auth rejection, busy rejection before side effects, release after a definite failure, unknown-outcome blocking, separate events for repeated messages, client disconnects, and shutdown. Remove tests for deleted store/replay behavior.

Review this milestone's diff and host test results before proceeding. Kernel source, built package output, package manifests, lockfiles, signer code, and contracts should remain unchanged.

### Milestone 2: End-to-end evidence and operator documentation

Update `scripts/smoke-local.mjs` to remove store imports, manual journal edits, duplicate-suppression assertions, and restart-recovery assertions. Preserve real Anvil, Kubo, signed HTTP intake, IPFS retrieval, Logger-event checks, invalid-signature rejection, and chain/bytecode startup checks.

Disable automining and submit one valid message. Wait until its Logger transaction is pending, then submit a different valid message and assert `503 node_busy` without another publication or signing operation. Mine the first transaction and verify its `200` / `logged` response. Resubmit the previously rejected request and verify it now succeeds. Separately submit an identical completed message and verify a new Logger event. Unit tests should verify no side-effect callback was invoked for the busy request; the real smoke should verify no second transaction was submitted while the first operation was active.

Update `node/production/README.md`, affected setup references, and the earlier ExecPlan's current-behavior pointer. Explain single-operation processing, busy responses, timeout/partial-result behavior, independent repeated submissions, removed persistence, dedicated-account ownership, and the continued ethers signer. Do not change the Logger ABI or deployment script, add a kernel signing API, or deploy to a public network.

Review the updated smoke evidence and documentation before marking implementation complete.

## Concrete Steps

Run from the repository root. Both milestones' commands have passed. If dependencies are not installed, follow the runtime README setup first; no dependency or package rebuild changes are required by this refactor.

After milestone 1:

    npm --prefix node/production test
    git diff --check

After milestone 2:

    npm --prefix node/production test
    forge build --root contracts --sizes
    npm --prefix node/production run smoke:local
    git diff --check

The smoke uses disposable Anvil chain 31337, an isolated Kubo repository, and generated local accounts. It supplies `LOGGER_CHAIN_ID=31337` and `LOGGER_DEPLOYER_PK` to the existing Foundry deployment script through the child environment. No existing user credentials or live funds are required. Loopback sockets may require workspace escalation. Stop the temporary validation services when done; do not start another persistent stack unless requested.

## Validation and Acceptance

The HTTP adapter must visibly call the combined kernel handler; removed journal modules must have no remaining imports. Milestones 1 and 2 removed those imports from runtime, tests, and smoke. Normal operation creates no state directory or journal files. Invalid and unauthorized requests cause no publication or signing. A busy rejection performs no side effects. At most one combined call is active, including while waiting for a receipt or draining after a client disconnect.

Test an IPFS failure, publication followed by preparation failure, an uncertain submission/receipt timeout, and a mined failed transaction. Verify correct guard release or unavailable status and safe partial-result fields. Ensure a client disconnect cannot clear the guard early. Confirm duplicate submissions are independent and shutdown waits for the active operation.

The real smoke must prove signed-message authentication, retrieved IPFS content, and checked Logger execution, as well as busy rejection while a transaction is pending and successful processing after it completes. There must be no kernel API, dependency, or contract changes.

## Idempotence and Recovery

The endpoint has no durable idempotency or automatic restart recovery. Retrying a busy rejection is safe because the operation did not begin. Retrying after a timeout or other attempted operation can create another event and spend gas again. Existing kernel transport retries remain; the host does not retry the combined operation.

The unavailable flag for an uncertain transaction is in memory only. Resolve the transaction externally before restarting; the new process cannot infer every previous ambiguous submission from its startup checks. Source changes are reversible and should be reviewed milestone by milestone.

## Artifacts and Notes

This plan replaces the previously proposed multi-worker queue and nonce-coordination design. It is named `plans/production-node-direct-handler-execplan.md` to reflect the simplified scope. Busy rejection, the overall operation deadline, independent repeated requests, and unknown-outcome blocking were approved and implemented in milestone 1.

Milestone 1 validation on 2026-09-07 21:50Z:

    npm --prefix node/production test
    tests 21; pass 21; fail 0; cancelled 0; skipped 0

    git diff --check
    (no output; exit 0)

Validation after the compatibility cleanup on 2026-09-07:

    npm --prefix node/production test
    tests 20; pass 20; fail 0; cancelled 0; skipped 0

    git diff --check
    (no output; exit 0)

The HTTP success response is `200` with `status: "logged"`, its signer, and a `publication` summary marked `logged`. Attempted failures include `started: true` and `loggingOutcome` (`not_submitted`, `failed`, or `unknown`), plus available CID/URI/hash/block fields. Expected upstream failures use `502 publication_failed`; deadlines use `504 operation_timeout` or `504 receipt_timeout`; unexpected faults use sanitized `500 internal_error`. Busy and shutdown rejections use `started: false` and `Retry-After: 5`. Unknown-outcome rejections omit automatic retry advice. Only final public result fields are emitted in `message_result` logs.

Milestone 2 validation on 2026-09-07 23:04Z:

    npm --prefix node/production test
    tests 20; pass 20; fail 0; cancelled 0; skipped 0

    forge build --root contracts --sizes
    exit 0; Logger runtime 395 bytes; initcode 427 bytes

    npm --prefix node/production run smoke:local
    smoke_passed; exit 0; temporary services stopped

    git diff --check
    (no output; exit 0)

Evidence file: `/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-local-5C4qrz/evidence.json`. This is an artifact directory, not host publication state. Logger was deployed at `0xea0cc0efbee797d8f03dddf6a6b1542b6797aeca` on disposable chain 31337, deployment transaction `0x1234e853ecb2e9585887edf80587abdaac02653114db1842d81cedf0f4be215d`. The four checked publication results were mined in blocks 2, 3, 4, and 5. Both busy requests returned `503 node_busy` while exactly one transaction remained pending. The original and repeated message shared CID `bafkreiditauy4q4ttxxhrojgwe74im2rxifokgqg4gfobisyd5dg4whn6u` but had different transaction hashes, recorded in the evidence file.

Loopback permission was used for host tests and the smoke. Local test keys were generated in memory and written only to the temporary `.env` with mode `0600`; none appear in this plan or source. No public deployment, package rebuild, dependency install, or commit was performed.

## Interfaces and Dependencies

Use existing package-root APIs: `createSignedMessageAuthorizer`, `handleSignedMessage`, `publishAndLogSignedMessage`, `PublishAndLogSignedMessageError`, `createTransactionPreparer`, `requestEthereumJsonRpc`, and typed logging errors. Pass the host operation deadline through `PublishAndLogSignedMessageOptions.signal`.

The HTTP adapter owns its active-operation guard, draining promise, uncertainty flag, and response formatting. The kernel owns publication, transaction preparation, broadcasting, and receipt verification. The existing ethers signer retains `{ address, signTransaction }`; environment variable names remain unchanged. There is no new kernel API, nonce allocator, waiting queue, persistence mechanism, or npm dependency.
