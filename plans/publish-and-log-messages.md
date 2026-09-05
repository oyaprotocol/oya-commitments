# Publish accepted messages and log their CIDs

This ExecPlan follows `PLANS.md` and covers the Ethereum and messages packages.

## Purpose / Big Picture

An allowlisted sender's authenticated message should be published to IPFS before
its CID is submitted to Logger. A host can configure one accepted-message
callback and receive publication details, the transaction hash, a successful
receipt, and the matching event. Failures after publication must retain enough
information to resume without blindly sending another transaction.

## Progress

- [x] 2026-09-05: Read repository/package instructions and audited ingress,
  publication, transaction submission, receipt polling, and Logger ABI helpers.
  The starting worktree is clean.
- [x] 2026-09-05: Added `logCid` with host-injected transaction preparation/signing, existing
  submission/polling utilities, event verification, and progress-bearing errors.
- [x] 2026-09-05: Added the sequential message publication/logging handler and package exports.
- [x] 2026-09-05: Proved authorization, payload preservation, ordering, failure recovery,
  cancellation, and receipt verification with 16 new injected-transport tests and type tests.
- [x] 2026-09-05: Updated docs and tracked output; all 184 package tests, both
  TypeScript consumer suites, package-root import checks, and whitespace checks
  passed inside the sandbox. Reviewed runtime, tests, dependency changes, and docs.

## Surprises & Discoveries

- Ingress already freezes the authorized message and invokes its callback once,
  awaiting completion. Rejected requests never reach that callback.
- The published payload is compact JSON with `text`, `signer`, and `signature`
  in that order. It preserves field values but not the HTTP body's whitespace or
  property order; this existing format is retained.
- The event's `node` is Logger's immediate caller, which can differ from the
  signed message's sender and from the outer Ethereum transaction's sender.
- Raw submission already retries identical signed bytes and supports duplicate
  recovery using a supplied transaction hash. Receipt polling already handles
  deadlines and aborts. No second orchestration retry loop is needed.
- The receipt timer validator is reused internally by `logCid` so invalid poll
  settings fail before signing or broadcasting. It is not a package-root export.
- Focused tests pass with a delayed upload, delayed signer, and delayed receipt:
  ingress stays pending until all stages complete. Cancellation of an uncooperative
  signer rejects the flow and prevents late signed bytes from being broadcast.

## Decision Log

- 2026-09-05 / Codex: Put `logCid(cid, options)` in
  `packages/ethereum/src/log-cid.ts` to keep network orchestration separate from
  the pure ABI helpers in `logger.ts`.
- 2026-09-05 / Codex: Require `prepareTransaction` to return signed
  `rawTransaction` and its `transactionHash`. The trusted host owns chain ID,
  nonce, fees, gas, keys, and wallet routing; the package owns broadcasting.
  Retaining the hash before broadcasting supports recovery from ambiguous failures.
- 2026-09-05 / Codex: Add `publishAndLogSignedMessage` in
  `packages/messages/src/handlers/publish-and-log.ts`, exposed at the package
  root for use in `onAcceptedMessage`. Await the existing publisher before
  calling `logCid`. Keep allowlist enforcement in the existing ingress authorizer.
- 2026-09-05 / Codex: Share one optional cancellation signal between publication,
  preparation, submission, and polling. Receipt timeout applies to receipt
  observation; the host bounds preparation/signing as appropriate.
- 2026-09-05 / Codex: Use typed errors carrying the completed publication,
  known transaction hash, logging stage, original cause, and receipt when known.
  No rollback, automatic full-flow retry, or durable storage is introduced.

## Outcomes & Retrospective

Complete. `logCid` and
`publishAndLogSignedMessage` are exported with their types and progress-bearing
errors. The message handler uses the existing publisher and allowlist ingress;
no alternate payload can be injected. Ten new Ethereum and six new message flow
tests pass, and all 184 package tests pass (64 Ethereum, 55 messages, 50 IPFS,
15 utils). Both consumer type suites, workspace build, package imports, and diff
checks pass. Documentation, lockfile, and generated artifacts are updated.

Validation used injected transports and opaque mock signer output, with the
existing independent message CID and ABI fixtures; it did not sign or send a
live transaction. The trusted host still owns transaction preparation, nonce
coordination, keys, durable progress, and finality policy. There is no remaining
implementation work in this plan and no deployment or host server was created.

## Context and Orientation

`packages/messages/src/ingress.ts` authorizes requests through an injected
`SignedMessageAuthorizer`. `createSignedMessageAuthorizer(allowedSigners)` supplies
the real schema/signature/allowlist check. The accepted-message callback receives
the frozen signed envelope. `handlers/publish.ts` validates and publishes that
envelope through the IPFS package using the canonical CID import profile.

`packages/ethereum/src/logger.ts` encodes `log(string)` and decodes the three-topic
Logger event. `transactions.ts` sends signed bytes and `receipts.ts` waits for
the first mined receipt. A receipt is the RPC report of transaction execution;
it does not establish finality. Package roots export their built `dist` artifacts.

## Plan of Work

Implement and test Ethereum orchestration first. Validate options before calling
the host signer, snapshot its returned signed bytes/hash, submit them, and require
a successful receipt containing the expected Logger emitter, node, and CID with
`removed !== true`. Reuse canonical CID and ABI validation. Then add the message
handler, a messages-to-Ethereum workspace dependency/reference, and error context
for failures after IPFS success. Exercise the configured ingress callback with
the public signed-message and Logger ABI fixtures already in the repository.
Document host composition and recovery, regenerate builds, and run final checks.

## Concrete Steps

Run from the repository root:

    npm --prefix packages install --package-lock-only --offline --ignore-scripts --no-audit --no-fund
    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js packages/ethereum/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    git diff --check

Smoke-import the new public functions/types' corresponding runtime exports from
`packages/` using Node with `--input-type=module`. Tests inject transports and
signing callbacks; no key, RPC endpoint, Kubo daemon, or Foundry is required.
No Solidity files are changed, so contract tests are outside this change.

## Validation and Acceptance

An actual `handleSignedMessage` call with the real allowlist authorizer must
upload exactly the signed envelope, await its CID, then prepare, send, poll,
and verify Logger success before returning 202. Unauthorized or malformed
messages must trigger neither upload nor signing. IPFS failure stops logging.
Submission, polling, and event failures retain publication and known transaction
identity; timeouts never claim the transaction failed. Cancellation prevents
later stages, including when the signer ignores the signal. Retry tests must
show one preparation and identical signed bytes. Reverts, unknown execution
status, removed/missing/wrong events, and mismatched hashes must never succeed.

## Idempotence and Recovery

Builds and tests are local and repeatable. No migration or deployment is needed.
IPFS and Ethereum cannot be rolled back together: successful publication remains
available if logging fails. Use a retained transaction hash to resume existing
receipt polling, then verify status and event. Retrying the whole handler may
create another event. Persist progress in the host if process-crash recovery is
required; returned errors only preserve progress in the running process.

## Artifacts and Notes

Use `packages/test/fixtures/cids.json`'s signed-message JSON and matching vectors
in `packages/ethereum/test/fixtures/logger-abi.json`. These are public test data.
Tests will record stage order and inspect exact multipart bytes and calldata.

## Interfaces and Dependencies

New Ethereum exports: `logCid`, `LogCidError`, and their options/result/signing
types. The signer receives a frozen request containing Logger `to`, encoded
`data`, `value: 0n`, and the optional caller `signal`. It must prepare and sign
without broadcasting. The result contains CID, transaction hash, receipt, and
decoded event. Errors distinguish prepare, submit, receipt, and verify stages.

The named types are `LogCidOptions`, `LogCidResult`, `LogCidStage`,
`LoggerTransactionRequest`, `PreparedLoggerTransaction`, and
`PrepareLoggerTransaction`. Configuration errors occur before preparation;
`LogCidError` wraps failures from preparation onward. Its `receipt` is populated
only after successful receipt parsing. Signed transaction content/hash correctness
is the trusted preparer's responsibility; no new transaction parser was added.

New messages exports: `publishAndLogSignedMessage`,
`PublishAndLogSignedMessageError`, and options/result types. Options provide
separate IPFS and Logger configuration plus a shared signal. The result is
`{ publication, logging }`. Add only the local `@oyaprotocol/ethereum` dependency;
no new external package or process/environment access is needed.

The named types are `PublishAndLogSignedMessageOptions` and
`PublishAndLogSignedMessageResult`. The outer error retains the successful
publication and copies the known transaction hash from a `LogCidError` cause;
other Logger validation errors leave the hash null. IPFS and message validation
errors propagate unchanged because no successful publication result is available.
