# Publish Signed Messages Through a Configured Handler

This ExecPlan is a living document maintained according to `PLANS.md`.

## Purpose / Big Picture

Let a host configure signed-message publication by importing `publishSignedMessage` from `@oyaprotocol/messages` and wrapping it as `onAcceptedMessage`. After authentication and authorization, the callback publishes and pins the signed envelope to IPFS and returns publication metadata, including its content identifier (CID), through `handleSignedMessageResult`.

The user approved one file per handler, starting with `packages/messages/src/handlers/publish.ts`. Public consumers import through the package root. The host supplies IPFS transport configuration and a fetch function; the messages package does not choose handlers from configuration strings or own a server.

## Progress

- [x] 2026-09-04: Read repository guidance, `PLANS.md`, package instructions, message ingress/verification, IPFS publication, and existing tests. Confirmed the worktree is clean and the callback milestone is complete.
- [x] 2026-09-04: Defined the publisher API, artifact encoding, verification boundary, and package dependency changes below.
- [x] 2026-09-04: Implemented and exported the publisher, added the IPFS dependency and TypeScript reference, and refreshed the workspace lockfile offline without adding external packages.
- [x] 2026-09-04: Added eight publication tests covering standalone upload, invalid-envelope rejection, callback integration, deterministic retry bytes, cancellation, and failure propagation. Added a package-root declaration fixture for callback compatibility, required options, and exact result inference. All 48 message tests and the declaration check passed.
- [x] 2026-09-04: Documented the artifact and host configuration, built all packages, smoke-imported the public API, passed all 76 other kernel package tests, reviewed source/generated exports and dependency changes, and checked whitespace with `git diff --check`.

## Surprises & Discoveries

- Observation: The existing `publishToIpfs` already performs add-and-pin with explicit retry, timeout, and cancellation settings.
  Evidence: `packages/ipfs/src/publish.ts` sends `/api/v0/add?cid-version=1&pin=true&progress=false` and returns CID, URI, pin status, byte length, and provider metadata. The handler can delegate all transport behavior.
- Observation: Built JavaScript, declarations, and source maps are tracked in this repository.
  Evidence: `git ls-files packages/messages/dist` lists existing compiled artifacts; the build must produce the new handler artifacts as part of this change.
- Observation: The existing generic ingress API retains the full IPFS result type without any ingress changes.
  Evidence: `packages/messages/test/publish-types.test.ts` passes against emitted package-root declarations and proves that the inferred callback result is exactly `PublishToIpfsResult | undefined` after acceptance.

## Decision Log

- Decision: Implement `publishSignedMessage(message, options)` in `packages/messages/src/handlers/publish.ts`, re-exported from the package root.
  Rationale: The user chose separate files for concrete handlers, while the existing public import policy requires package-root imports.
  Date/Author: 2026-09-04 / user and Codex.
- Decision: Require `config` and `fetch`, accept optional `signal`, and reuse the corresponding `PublishToIpfsOptions` fields and `PublishToIpfsResult` type.
  Rationale: The host can close over these dependencies in a one-argument callback without introducing a factory or duplicating transport configuration.
  Date/Author: 2026-09-04 / Codex.
- Decision: Verify and snapshot the message before every publication, including direct calls; leave allowlist authorization to ingress or the host.
  Rationale: The public publisher should reject malformed or falsely signed envelopes before upload even when invoked outside the authenticated callback path. This deliberately repeats verification when used after ingress.
  Date/Author: 2026-09-04 / Codex.
- Decision: Serialize compact JSON with exactly `text`, `signer`, and `signature`, in that order, with no trailing newline; use fixed filename `message.json` and media type `application/json`.
  Rationale: These are properties of the message artifact. The serializer preserves every field value, including text whitespace, address/signature casing, and recovery encoding. There is no timestamp or ordering field. The same exact field values yield the same file bytes regardless of input key order.
  Date/Author: 2026-09-04 / Codex.
- Decision: Add a messages-to-IPFS dependency and TypeScript project reference, with no changes to IPFS implementation or ingress behavior.
  Rationale: Message serialization belongs to messages, while generic publication remains in IPFS.
  Date/Author: 2026-09-04 / Codex.

## Outcomes & Retrospective

The publisher is complete in `packages/messages/src/handlers/publish.ts` and available through `@oyaprotocol/messages`. Hosts can configure publication with the agreed one-argument callback wrapper and read the CID through `handleSignedMessageResult`. The handler verifies direct calls, serializes the exact signed envelope deterministically, and delegates upload, pinning, retries, and cancellation to the existing IPFS package. No ingress or IPFS implementation changes were needed.

Validation passed under Node.js v23.10.0: package build, package-root smoke import (`function function`), emitted-declaration checks, 48 message tests (including eight new publication tests), and 76 utils/IPFS/Ethereum regressions, for 124 passing runtime tests. Transport tests inspect real multipart upload bodies using an injected fetch implementation; no live Kubo service or onchain transaction was used. The standalone publisher's verification deliberately repeats ingress verification, while allowlist policy stays with ingress/host. No required work remains in this milestone. Onchain Logger work is deferred.

## Context and Orientation

`packages/messages/src/ingress.ts` accepts HTTP-shaped inputs, authenticates with an injected authorizer, freezes a three-field message snapshot, awaits the optional `onAcceptedMessage`, and returns its settled value separately from the HTTP response body. Rejected requests do not invoke the callback. Callback exceptions propagate unchanged.

`packages/messages/src/ethereum-signature.ts` exports `verifySignedMessage`, which first validates the schema and then verifies an Ethereum EIP-191 signature over exactly the ASCII text. It returns a frozen snapshot. `packages/ipfs/src/publish.ts` exports `publishToIpfs`, which uploads bytes or text to Kubo (the IPFS HTTP service) and pins the resulting content so it is retained. Both functions are available through package-root exports.

The earlier ingress milestone is recorded in `plans/messages-package-ingress.md`. Its prohibition on adding a publisher applied to that completed milestone; this user-authorized follow-on adds the concrete handler. The future onchain Logger for CID discovery and publication ordering remains separate.

## Plan of Work

First add the small handler, options type, public exports, package dependency, and build reference. Serialize an explicit object from the verified snapshot so property order and artifact fields are stable. Let all errors from verification and IPFS propagate.

Then add focused tests using existing public signature fixtures and an injected fetch function that inspects the actual multipart JSON file sent by `publishToIpfs`. Exercise full ingress with the real authorizer and publisher, including invalid and unauthorized requests that must produce no upload. Verify publication metadata inference through the emitted package declarations. Use no live network or private keys.

Finally document direct invocation and callback configuration, the verification/authorization boundary, artifact format, runtime requirements, retry semantics, and the deferred Logger. Build all packages, smoke-import the package root, and run the focused and package regression suites.

## Concrete Steps

Run these commands from the repository root:

    npm --prefix packages install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json

Run the following smoke import from `packages/`, so Node resolves the workspace package link. It should print `function function`:

    node --input-type=module -e "import('@oyaprotocol/messages').then(m => console.log(typeof m.publishSignedMessage, typeof m.handleSignedMessage))"

Run regression tests from the repository root:

    node --test packages/utils/test/*.js packages/ipfs/test/*.js packages/ethereum/test/*.js
    git diff --check

## Validation and Acceptance

The new publisher must be importable from `@oyaprotocol/messages` and usable with `onAcceptedMessage: message => publishSignedMessage(message, { config, fetch })`. Its type declarations require both transport dependencies, infer the full publication result through ingress, and accept an optional abort signal.

Tests must inspect the actual uploaded file for fixed JSON field order and metadata, preservation of signed values, deterministic bytes across input key orders and retries, and resistance to caller mutation while publication is pending. Invalid schema/signatures fail before fetch. Full ingress tests prove rejected requests never upload, successful requests return CID metadata only through the internal handler-result property, repeated requests publish again, and transport errors reject the ingress call. Cancellation must reach the IPFS primitive.

Build, declaration checks, root smoke import, all message tests, and package regression tests must pass. Network behavior is exercised through injected transports; a live Kubo deployment is not required for this composition change.

## Idempotence and Recovery

The publisher delegates retries to IPFS and adds no second retry loop or deduplication cache. Retrying the same exact envelope uploads the same file bytes again. Signing the same text with different signature bytes or changing address casing can change the artifact bytes. CID assignment remains the IPFS provider's responsibility. No publication-order claim is made.

Builds and local tests are repeatable and do not contact a live service. Reverting this feature requires reverting its source, tests, metadata, docs, and matching generated artifacts together.

## Artifacts and Notes

Expected host configuration:

    import { publishSignedMessage } from '@oyaprotocol/messages';
    const onAcceptedMessage = message =>
      publishSignedMessage(message, { config: ipfsConfig, fetch });

The host selects the callback and validates any configured handler name at startup. This feature adds no handler registry.

## Interfaces and Dependencies

New public API: `publishSignedMessage(message: Readonly<SignedMessageInput>, options: PublishSignedMessageOptions): Promise<PublishToIpfsResult>`. `PublishSignedMessageOptions` selects `config`, `fetch`, and `signal` from `PublishToIpfsOptions`. Reuse the IPFS result type without introducing another result shape.

Add `@oyaprotocol/ipfs: 0.0.0` to `packages/messages/package.json` and the corresponding workspace lockfile entry, and reference `../ipfs` in `packages/messages/tsconfig.json`. `packages/messages/src/index.ts` re-exports the function and options type. No new external dependency or runtime environment variable is introduced.
