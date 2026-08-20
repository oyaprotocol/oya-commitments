# Add Signed Text Message Ingress Package

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build `@oyaprotocol/messages` from a placeholder package into the first hardened message-ingress kernel for Oya nodes.

After this work, a node process should be able to accept a small HTTP JSON request from an authorized user, verify that the request contains a text message signed by the claimed Ethereum address, and receive an accepted-message object that the node can hand to its own implementation-specific logic. The node implementation defines what the text means and how to act on it.

The observable behavior after completion is:

1. a caller submits `POST /v1/messages`-style JSON with only `text`, `signer`, and `signature`;
2. `@oyaprotocol/messages` validates the body, verifies that the exact `text` is covered by the Ethereum signature, recovers the signer, checks the signer against an explicit allowlist, and returns an acceptance result;
3. malformed, unsigned, mis-signed, overlarge, or unauthorized messages produce structured rejection errors that a node can map to HTTP status codes.

The signed message is intentionally text-only. Its wire body contains exactly `text`, `signer`, and `signature`. The package preserves the text exactly and hands it to the node's implementation-specific logic after authentication and authorization.

## Progress

- [x] 2026-05-24: Reviewed `PLANS.md`, `packages/AGENTS.md`, current package docs, and the placeholder `packages/messages` implementation before drafting this plan.
- [x] 2026-05-24: Created this draft ExecPlan for user review before implementation.
- [x] 2026-05-26: Updated the proposed Ethereum signature implementation to use focused `@noble` crypto libraries instead of `viem`.
- [x] 2026-06-05: Incorporated review feedback to start with the smallest useful slice: strict schema validation before crypto dependencies or HTTP handling.
- [x] 2026-06-05: Implemented `validateSignedMessage(...)`, `SignedMessageValidationError`, schema exports, and focused schema tests in `packages/messages`.
- [x] 2026-06-07: Assigned message-size policy to the future ingress layer.
- [x] 2026-06-07: Focused the schema result on the validated wire fields.
- [x] 2026-06-07: Reused `@oyaprotocol/utils` for the shared plain-object check instead of duplicating it in `packages/messages`.
- [x] 2026-06-07: Renamed the schema API from `normalizeSignedMessage(...)` to `validateSignedMessage(...)` and stopped lowercasing the submitted signer address.
- [x] 2026-07-26: Added focused Noble dependencies and implemented `verifySignedMessage(...)` with EIP-191 hashing, secp256k1 recovery, case-insensitive signer comparison, structured verification errors, and fixed-vector tests.
- [x] 2026-07-28: Upgraded `@noble/curves` and `@noble/hashes` to 2.2.0, migrated to their ESM subpaths and recoverable-signature API, and declared the resulting Node.js 20.19.0 runtime floor.
- [x] 2026-07-28: Restricted signed-message text to the same ASCII byte policy as IPFS text reads and replaced the Unicode signature fixture with an ASCII recovery-bit fixture.
- [x] 2026-07-28: Documented signature-test provenance using public fixture values compatible with repository security policy.
- [x] 2026-07-28: Added standalone `authorizeMessageSigner(...)` allowlist authorization with case-insensitive address matching, fail-closed empty lists, structured `unauthorized_signer` errors, and focused tests.
- [x] 2026-08-15: Replaced the public signer-only helper with `authorizeSignedMessage(...)`, which verifies the signed message internally before checking allowlist membership.
- [x] 2026-08-15: Replaced per-call allowlist validation with `createSignedMessageAuthorizer(...)`, which snapshots a private normalized Set once and returns a frozen reusable authorizer.
- [x] 2026-08-15: Simplified `SignedMessageAuthorizer` to a direct frozen function type.
- [x] 2026-08-19: Focused the remaining plan on the implemented three-field signed-text protocol and functional HTTP-shaped handling.
- [x] 2026-08-19: Updated the ingress design so successful results carry the authenticated message and documented transport-body and message-text limit responsibilities.
- [x] 2026-08-19: Defined the complete handler request, option, byte-limit, content-type, and error-mapping contract and restored explicit replay-safety guidance for side-effecting consumers.
- [x] 2026-08-20 01:43Z: Implemented and exported functional HTTP-shaped handling with strict request/configuration validation, ordered request processing, frozen acceptance and rejection results, structured message-error mapping, and focused ingress tests.
- [x] 2026-08-20 01:43Z: Updated package documentation, rebuilt the kernel packages, smoke-imported the completed API, and passed all 109 hardened-kernel package tests.

## Surprises & Discoveries

- Observation: `@oyaprotocol/messages` was only a placeholder package shell when this plan began.
  Evidence: the initial `packages/messages/src/index.ts` exported `packageInfo` with `status: 'placeholder'`; the schema milestone subsequently removed it.

- Observation: Hardened package implementation and dependencies stay within the `packages/` area and its package-root exports.
  Evidence: `packages/AGENTS.md` defines `agent/`, `agent-library/`, `node/`, and `frontend/` as reference material for production-kernel packages.

- Observation: Existing message ingress and publication logic in `agent/src/lib/` provides reference behavior for the package-local implementation.
  Evidence: `agent/src/lib/message-api.js`, `agent/src/lib/message-signing.js`, and `agent/src/lib/message-publication-api.js` illustrate signed requests, HTTP status mapping, and publication flows.

- Observation: The first implementation milestone removed the `packageInfo` placeholder export and replaced it with real schema-validation exports, before the later signature milestone added cryptographic verification.
  Evidence: `packages/messages/test/schema.test.js` covers schema behavior independently from `packages/messages/test/signature.test.js`.

- Observation: JavaScript string length cannot be used in the EIP-191 prefix because it counts UTF-16 code units rather than encoded message bytes.
  Evidence: the earlier fixed `Oya 🌱` ethers signature verified only when the prefix used the UTF-8 byte length produced by `utf8ToBytes(...)`. That fixture was removed when the package later restricted text to ASCII, but digest construction continues to use encoded byte length.

- Observation: The reviewed Noble versions expose the complete focused recovery surface used by this package.
  Evidence: `@noble/curves` 1.9.1 provides compact signature parsing, recovery-bit attachment, and secp256k1 public-key recovery; `@noble/hashes` 1.8.0 provides Keccak-256 and byte/hex utilities.

- Observation: Noble 2.2.0 changed both module and recovery conventions in ways that matter for EIP-191.
  Evidence: package subpaths require explicit `.js` extensions; recoverable signatures are encoded as `recovery || r || s` rather than Ethereum's `r || s || v`; and `secp256k1.recoverPublicKey(...)` defaults to SHA-256 prehashing, so recovery over the already-computed EIP-191 Keccak-256 digest must pass `{ prehash: false }`.

- Observation: The existing shared ASCII policy accepts the full ASCII byte range.
  Evidence: `assertAsciiBytes(...)` accepts every byte through `0x7f`, including control bytes and `0x7f`, and rejects higher UTF-8 byte values just like the IPFS text readers.

## Decision Log

- Decision: The v1 wire body contains exactly `text`, `signer`, and `signature`.
  Rationale: The node receives signed text and interprets it through its own implementation-specific logic. The three-field envelope keeps the wire contract small and auditable.
  Date/Author: 2026-05-24; reaffirmed 2026-08-19 / Codex.

- Decision: Use Ethereum signed text as the signature scheme.
  Rationale: The user clarified that signatures will follow Ethereum signing standards. The package can still avoid Ethereum-domain fields in the message body while using Ethereum address recovery for authentication.
  Date/Author: 2026-05-24 / Codex.

- Decision: The signed payload is exactly the `text` string.
  Rationale: This keeps the protocol understandable to users and compatible with common wallet `personal_sign` / EIP-191 signed-message behavior.
  Date/Author: 2026-05-24; reaffirmed 2026-08-19 / Codex.

- Decision: Implement built-in Ethereum signature verification in `@oyaprotocol/messages` using focused `@noble` crypto libraries.
  Rationale: `@noble/hashes` and `@noble/curves` provide the Keccak-256 hashing and secp256k1 public-key recovery primitives required for local verification.
  Date/Author: 2026-05-26 / Codex.

- Decision: Expose server-agnostic HTTP helper functions that map request-shaped input to HTTP-shaped results.
  Rationale: A node daemon can mount the package helper behind `POST /v1/messages` while supplying its own routing and process lifecycle.
  Date/Author: 2026-05-24 / Codex.

- Decision: Public function and type names should avoid repeating the word "Ingress".
  Rationale: The package name and documentation already establish that this work is about receiving signed messages. Shorter names such as `handleSignedMessage(...)` are clearer at call sites than `handleSignedMessageIngress(...)`.
  Date/Author: 2026-05-26 / Codex.

- Decision: Public function and type names should also avoid repeating the word "Text".
  Rationale: The v1 package contract already says messages contain a `text` field. Names such as `validateSignedMessage(...)` and `verifySignedMessage(...)` are shorter while remaining unambiguous inside `@oyaprotocol/messages`.
  Date/Author: 2026-05-26 / Codex.

- Decision: Evaluate every v1 submission from its current signed text and configured authorization policy.
  Rationale: The same signed text remains valid across repeated submissions and anywhere the signer is authorized.
  Date/Author: 2026-05-24; reaffirmed 2026-08-19 / Codex.

- Decision: Require side-effecting node consumers to apply durable replay/idempotency policy or make each operation idempotent.
  Rationale: EIP-191 verification proves signer identity and text integrity, while a previously valid signature remains valid when submitted again. Authentication therefore cannot serve as a freshness decision for non-idempotent effects.
  Date/Author: 2026-08-19 / Codex.

- Decision: Reject unknown top-level fields in the v1 signed message body.
  Rationale: The wire contract is intentionally small and audit-focused. Rejecting extra fields prevents callers from assuming hidden package semantics for fields such as `meta`, `chainId`, or `version`, and makes the node's responsibility for interpreting only `text` explicit.
  Date/Author: 2026-06-05 / Codex.

- Decision: Preserve `text` exactly during schema validation and only reject the zero-length empty string.
  Rationale: The signed payload is exactly the `text` string, so trimming or canonicalizing whitespace would change what later signature verification must recover. A whitespace-only string can still be a signed text message; policy about usefulness belongs above the package.
  Date/Author: 2026-06-05 / Codex.

- Decision: Apply request-body limits while the node server reads the request, then apply configured body and text limits in the HTTP-shaped ingress flow before JSON parsing and signature verification respectively.
  Rationale: The server-side stream limit bounds buffering, the handler's body limit bounds JSON parsing, and the text limit bounds ASCII validation and cryptographic work.
  Date/Author: 2026-06-07; clarified 2026-08-19 / Codex.

- Decision: Return the authenticated frozen message as a distinct field on a successful HTTP-shaped result.
  Rationale: The node needs the authorized text for implementation-specific handling. Keeping `message` separate from the HTTP `body` gives the node a trusted handoff value while preserving a small response body for the remote caller.
  Date/Author: 2026-08-19 / Codex.

- Decision: Define `handleSignedMessage(request, options)` with a required `Uint8Array` body, a dedicated content-type value, an injected authorizer, and explicit positive byte limits.
  Rationale: One byte-oriented request representation makes size measurement and UTF-8 decoding deterministic. Required options preserve the hardened packages' explicit-config convention and move invalid configuration failures to a clear `TypeError` boundary.
  Date/Author: 2026-08-19 / Codex.

- Decision: The schema result contains exactly `text`, `signer`, and `signature`.
  Rationale: Future signature verification can compute byte length when building the EIP-191 prefix instead of carrying that value in the public schema result.
  Date/Author: 2026-06-07; reaffirmed 2026-08-19 / Codex.

- Decision: Schema validation preserves the submitted signer address casing.
  Rationale: Schema validation checks wire compatibility, while signature verification and allowlist checks perform case-insensitive comparisons internally.
  Date/Author: 2026-06-07 / Codex.

- Decision: `packages/messages` depends on `@oyaprotocol/utils` for shared validation helpers.
  Rationale: `isPlainObject` is already a public utility and is used by other kernel packages. Message-specific text, signer, signature, and structured error behavior remains local.
  Date/Author: 2026-06-07 / Codex.

- Decision: Keep `verifySignedMessage(...)` limited to cryptographic verification and apply allowlist authorization in the later ingress layer.
  Rationale: Separating signer recovery from node-supplied authorization policy makes the current milestone independently useful and keeps a valid signature distinct from an authorized request.
  Date/Author: 2026-07-26 / Codex.

- Decision: Return the unchanged validated message on successful verification and throw `SignedMessageVerificationError` with `invalid_signature` and status `401` for cryptographic failures.
  Rationale: Callers retain the exact signed fields while malformed wire data remains distinguishable as a schema validation error with status `400`.
  Date/Author: 2026-07-26 / Codex.

- Decision: Pin `@noble/curves` 1.9.1 and `@noble/hashes` 1.8.0 for the first signature-verification milestone. This decision was superseded on 2026-07-28.
  Rationale: These compatible versions are already represented in repository lockfiles, expose the required audited primitives, and avoid an unrelated major-version migration during this focused package change.
  Date/Author: 2026-07-26 / Codex.

- Decision: Upgrade both Noble dependencies to exact version 2.2.0 and declare Node.js 20.19.0 as the package runtime floor.
  Rationale: The user requested the current Noble releases. Both packages publish the same Node.js engine requirement, and the repository's Node 22 CI satisfies it. Exact pins preserve the package's existing deterministic dependency policy.
  Date/Author: 2026-07-28 / Codex.

- Decision: Restrict v1 message text to the same ASCII byte range accepted by IPFS text reads.
  Rationale: Reusing `assertAsciiBytes(...)` gives signed messages and retrieved text artifacts one narrow character policy, rejects Unicode normalization and display ambiguities before signature verification, and preserves submitted ASCII byte-for-byte.
  Date/Author: 2026-07-28 / Codex.

- Decision: Expose allowlist authorization as `authorizeMessageSigner(signer, allowedSigners)` rather than combining it with signature verification. This decision was superseded on 2026-08-15.
  Rationale: The signer-only name made the trust boundary explicit: callers passed the signer from `verifySignedMessage(...)`, and the future ingress layer could reuse the helper independently.
  Date/Author: 2026-07-28 / Codex.

- Decision: Treat a valid but non-allowlisted signer as `unauthorized_signer` with status `403`, while treating malformed signer or allowlist inputs as `TypeError`. The malformed-signer portion of this decision was superseded on 2026-08-15.
  Rationale: Membership failure is an authorization result suitable for HTTP mapping. Invalid address shapes and non-array allowlists are caller configuration or API-use errors represented by `TypeError`. Empty arrays are valid and intentionally deny every signer.
  Date/Author: 2026-07-28 / Codex.

- Decision: Export `authorizeSignedMessage(input, allowedSigners)` as the authorization boundary and keep raw signer membership checking private. The per-call API portion of this decision was superseded later on 2026-08-15.
  Rationale: Documentation alone cannot enforce that a signer came from `verifySignedMessage(...)`. Composing schema validation, EIP-191 verification, and membership checking prevents callers from accidentally authorizing the unverified `signer` field from a request while preserving the lower-level `verifySignedMessage(...)` API for verification-only use cases.
  Date/Author: 2026-08-15 / Codex.

- Decision: Preserve `SignedMessageValidationError` and `SignedMessageVerificationError` from the composed authorization API, and reserve `TypeError` for malformed allowlist configuration.
  Rationale: The complete message is untrusted request input and should retain the package's structured request-error behavior. The allowlist remains caller-supplied configuration, so an invalid container or address entry is a programming/configuration failure.
  Date/Author: 2026-08-15 / Codex.

- Decision: Prevalidate authorization policy with `createSignedMessageAuthorizer(allowedSigners)` and expose request-time authorization through the returned object's `authorize(input)` method. The returned-object shape was superseded later on 2026-08-15 by a directly callable function.
  Rationale: Node allowlists are normally static configuration reused across requests. Validating and normalizing once moves configuration failures to startup, avoids rebuilding a Set on every request, snapshots the caller's array, and keeps the mutable Set private inside a closure. Freezing the returned object prevents its public capability from being replaced or reconfigured at runtime.
  Date/Author: 2026-08-15 / Codex.

- Decision: Represent `SignedMessageAuthorizer` as a function type and have `createSignedMessageAuthorizer(...)` return that function directly.
  Rationale: A named function type preserves dependency injection and the private normalized allowlist closure with a compact call surface.
  Date/Author: 2026-08-15 / Codex.

- Decision: Implement request handling as a function of the current request and immutable validated authorization configuration.
  Rationale: This gives callers consistent results for the same request and configuration and lets node processes reuse one prevalidated authorizer.
  Date/Author: 2026-08-18 / Codex.

## Outcomes & Retrospective

The first schema milestone is complete. `@oyaprotocol/messages` gained a real package-root API for validating the v1 `{ text, signer, signature }` body before the signature-verification milestone. The implementation preserves exact text and signer bytes, preserves the submitted signature string, rejects unknown fields, returns only the three validated wire fields, and throws structured `SignedMessageValidationError` instances for request-shape failures.

Validation run on 2026-06-05:

    npm --prefix packages run build
    node --test packages/messages/test/schema.test.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.validateSignedMessage, typeof m.SignedMessageValidationError, Object.hasOwn(m, 'packageInfo')))"
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js

The schema test reported 6 passing tests, and the smoke import printed `function function false`.
The broader package regression tests also passed: 11 utils tests, 45 IPFS tests, and 20 Ethereum tests.

The EIP-191 verification milestone is complete. `verifySignedMessage(...)` validates the wire body, hashes exactly the encoded message bytes with the Ethereum signed-message prefix, accepts recovery values encoded as `27`/`28` or `0`/`1`, recovers the secp256k1 public key, derives its Ethereum address with Keccak-256, preserves submitted signer casing, and compares addresses case-insensitively. Fixed ASCII vectors generated with ethers v6 cover both recovery bits while runtime verification uses the focused Noble dependencies.

Validation run on 2026-07-26:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.validateSignedMessage, typeof m.verifySignedMessage, typeof m.SignedMessageVerificationError))"

The combined schema and signature suite reported 13 passing tests, and the smoke import printed `function function function`.
Package-area regression validation also passed: 11 utils tests, 45 IPFS tests, and 20 Ethereum tests. Together with the 13 message tests, all 89 hardened-kernel package tests passed.

The Noble 2.2.0 migration preserves that behavior while adapting the implementation to ESM `.js` subpaths and the v2 recovered-signature byte layout. Recovery explicitly disables Noble's default SHA-256 prehash because `createEthereumSignedMessageDigest(...)` already supplies the EIP-191 Keccak-256 digest. The package now declares Node.js 20.19.0 or newer to match both Noble dependencies.

Validation run on 2026-07-28:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.validateSignedMessage, typeof m.verifySignedMessage, typeof m.SignedMessageVerificationError))"

The build succeeded, the smoke import printed `function function function`, and all 89 hardened-kernel tests passed: 13 messages, 11 utils, 45 IPFS, and 20 Ethereum.

ASCII-policy validation run on 2026-07-28 used the same build, package test, and smoke-import commands above. All 89 hardened-kernel tests passed again. Message tests now cover the full accepted ASCII byte boundary, rejection of emoji, accented text, `U+0080`, and lone surrogates, propagation of `invalid_text` through `verifySignedMessage(...)`, and fixed ASCII signatures for both recovery bits.

The initial standalone authorization milestone introduced `authorizeMessageSigner(...)` for case-insensitive membership checks, fail-closed empty arrays, and structured authorization errors. The composed authorization API later superseded it by running signature verification internally and guaranteeing signer provenance.

Authorization validation run on 2026-07-28:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.authorizeMessageSigner, typeof m.SignedMessageAuthorizationError))"

The build succeeded, the smoke import printed `function function function`, and all 92 hardened-kernel tests passed: 16 messages, 11 utils, 45 IPFS, and 20 Ethereum.

The first hardened authorization boundary exported `authorizeSignedMessage(...)`. It validated and verified the complete signed message before testing the recovered signer against a newly normalized allowlist on every call. The composed verification behavior remains, but the per-call configuration API was superseded by a reusable authorizer factory.

Composed-authorization validation run on 2026-08-15:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.authorizeSignedMessage, typeof m.SignedMessageAuthorizationError, Object.hasOwn(m, 'authorizeMessageSigner')))"

The build succeeded, the smoke import printed `function function function false`, and all 93 hardened-kernel tests passed: 17 messages, 11 utils, 45 IPFS, and 20 Ethereum. The authorization tests include changed signed text to prove that signature verification cannot be skipped through the public authorization API.

The current authorization boundary exports `createSignedMessageAuthorizer(...)`. Factory creation validates every address, normalizes case, removes duplicates, and snapshots the input into a private Set. The returned frozen function preserves the composed validation, verification, and membership-checking sequence while keeping allowlist representation encapsulated.

Prevalidated-authorizer validation run on 2026-08-15:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => { const authorize = m.createSignedMessageAuthorizer([]); console.log(typeof m.createSignedMessageAuthorizer, typeof authorize, Object.isFrozen(authorize), Object.hasOwn(m, 'authorizeSignedMessage'), Object.hasOwn(m, 'authorizeMessageSigner')); })"

The build succeeded, the smoke import printed `function function true false false`, and all 94 hardened-kernel tests passed: 18 messages, 11 utils, 45 IPFS, and 20 Ethereum. Tests also confirm that case-variant duplicates collapse, authorizer policy is snapshotted at creation, and the normalized allowlist remains encapsulated.

The existing three-field schema and text-only EIP-191 verification are the intended protocol.

The HTTP-shaped ingress milestone is complete. `handleSignedMessage(...)` validates options before request input, enforces the required method, content type, body bytes, UTF-8 JSON, and text bytes in the documented order, calls the injected authorizer only after the transport checks pass, and returns frozen HTTP-shaped results. Successful results keep the exact authenticated message separate from the small remote response body. Expected validation, verification, and authorization errors preserve their structured status, code, message, and optional details, while unexpected authorizer failures propagate.

Final validation run on 2026-08-20:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js

The build succeeded, the smoke import printed `function function`, and all 109 hardened-kernel package tests passed: 33 messages, 11 utils, 45 IPFS, and 20 Ethereum. The 15 ingress tests cover successful authenticated handoff, repeated submissions, separately signed identical text, exact content-type handling, processing order, byte limits, invalid UTF-8 and JSON, body-shape delegation, structured error preservation, unexpected exception propagation, strict container fields and types, positive integer configuration, and frozen results.

This ExecPlan is complete for the `@oyaprotocol/messages` package. A later plan can mount the handler in a node process and define downstream IPFS publication and onchain Logger behavior without changing this package's authentication boundary.

## Context and Orientation

The hardened package workspace lives under `packages/`.

The relevant files at the start of this plan are:

- `packages/messages/src/index.ts`: exports the package-root validation, verification, and authorization APIs.
- `packages/messages/src/schema.ts`: validates the v1 signed text message shape and defines structured schema errors.
- `packages/messages/src/ethereum-signature.ts`: verifies EIP-191 text signatures and defines structured cryptographic verification errors.
- `packages/messages/src/authorization.ts`: prevalidates and snapshots allowlists into reusable authorizers that verify signed messages and authorize their recovered signers.
- `packages/messages/src/ingress.ts`: validates HTTP-shaped request/configuration input, enforces transport and text limits, maps expected message errors, and returns frozen acceptance or rejection results.
- `packages/messages/test/schema.test.js`: covers schema acceptance, exact text preservation, unknown-field rejection, text limits, Ethereum address shape, and signature shape.
- `packages/messages/test/signature.test.js`: covers fixed ASCII EIP-191 vectors, recovery-value normalization, mismatch failures, and malformed signature scalars.
- `packages/messages/test/authorization.test.js`: covers configuration-time validation, policy snapshotting, private normalized membership, composed verification and authorization, fail-closed empty lists, preserved validation and verification errors, and structured authorization failures.
- `packages/messages/test/ingress.test.js`: covers the complete HTTP-shaped handler contract, error mapping, processing order, immutable results, repeated requests, and runtime misuse.
- `packages/messages/README.md`: documents the three-field schema, EIP-191 verification, allowlist authorization, HTTP-shaped handling, repeated-submission behavior, and Internet-facing limits.
- `packages/messages/package.json`: exposes the package root through `dist/index.js` and `dist/index.d.ts`.
- `packages/package.json`: owns the TypeScript build command for all kernel packages.
- `packages/AGENTS.md`: local instructions that scope hardened package code and dependencies to the `packages/` area.
- `packages/utils`: available shared helpers for validation, HTTP status errors, and async retry/abort behavior. Use it only when a helper is genuinely shared and already public through `@oyaprotocol/utils`.

Reference implementation files:

- `agent/src/lib/message-api.js`: current runtime HTTP endpoint for signed user messages.
- `agent/src/lib/message-signing.js`: current EIP-191-style canonical message helper for legacy agent user messages.
- `agent/src/lib/signed-published-message.js`: current publication-specific signed-message helper.
- `agent/scripts/send-signed-message.mjs`: current CLI for sending legacy agent messages.

Definitions:

- Text message: the user-authored string in the `text` field. The package preserves it exactly for caller-defined interpretation.
- Signer: the Ethereum account address claimed in the request body.
- Signature: the Ethereum signed-message signature over exactly the `text` string.
- Authorized signer: a signer address included in the allowlist supplied by the node.

The intended HTTP JSON body is:

    {
      "text": "Please withdraw 100 USDC.",
      "signer": "0x1111111111111111111111111111111111111111",
      "signature": "0x..."
    }

## Plan of Work

First, expose a small public API centered on signed text message ingress. Keep the package focused on message shape, signature verification, allowlist authorization, and HTTP-friendly result objects.

Second, add package-local TypeScript modules under `packages/messages/src/` instead of putting all behavior in `index.ts`. A likely source layout is:

- `schema.ts` for the wire body and validation helpers.
- `ethereum-signature.ts` for Ethereum address normalization and EIP-191 text-signature verification.
- `authorization.ts` for allowlist normalization and membership checks.
- `ingress.ts` for a server-agnostic request/body handler that returns HTTP-shaped status and JSON bodies for a node server to mount.
- `errors.ts` for structured error classes or error result shapes that keep status-code mapping consistent.
- `index.ts` for package-root exports only.

Third, add focused tests under `packages/messages/test/`. Tests should use locally generated or fixed Ethereum signed-message vectors. If a deterministic private key is used in tests, it must be a public test-only key documented in the test file, never a secret.

Fourth, update `packages/messages/README.md` so consumers understand the minimal wire protocol, exact text preservation, repeated-submission behavior, safe Internet-facing body and text limits, and how a node can mount the helper behind `POST /v1/messages`.

Implement this milestone under `packages/messages`. A follow-on plan can adopt the finished package in a node daemon.

## Concrete Steps

Work from the repository root unless a command says otherwise.

1. Review the messages package and package workspace.

    Command:

        sed -n '1,160p' packages/messages/src/index.ts
        sed -n '1,160p' packages/messages/package.json
        sed -n '1,120p' packages/AGENTS.md

    Expected result: confirm the current package-root exports and package-local dependency scope.

2. Add focused Ethereum signature dependencies to `packages/messages/package.json`. This step is complete.

    Pinned dependencies:

        "@noble/curves": "2.2.0"
        "@noble/hashes": "2.2.0"

    Use `npm --prefix packages install` after editing package metadata so `packages/package-lock.json` records the workspace dependency. Request network approval if registry access requires it.

3. Implement strict schema validation. This step is complete.

    The existing public validator is:

        validateSignedMessage(input)

    The validator should require:

    - `text` is a non-empty ASCII string preserved exactly.
    - `signer` is a valid Ethereum address.
    - `signature` is a 0x-prefixed Ethereum signature hex string.
    - unknown top-level fields are rejected; the only accepted fields are `text`, `signer`, and `signature`.

    Internet-facing node servers cap request bytes while reading the request stream. The ingress helper also checks configured body size before JSON parsing and configured text size before authorization.

4. Implement Ethereum signed-text verification. This step is complete.

    The public function is:

        verifySignedMessage(input)

    `verifySignedMessage(...)` should:

    - validate the body;
    - compute the EIP-191 Ethereum signed-message digest for exactly `text` using the prefix `"\x19Ethereum Signed Message:\n" + byteLength(text) + text`;
    - recover the secp256k1 public key from the digest and signature using `@noble/curves`;
    - derive the Ethereum address as the last 20 bytes of Keccak-256 over the uncompressed public-key bytes after the leading `0x04`, using `@noble/hashes`;
    - normalize common signature recovery IDs, including `v` values `27`/`28` and `0`/`1`;
    - compare the recovered address to `signer` case-insensitively;
    - return the unchanged validated message.

    `createSignedMessageAuthorizer(...)` composes this verification with the prevalidated signer allowlist.

5. Implement HTTP-shaped message helper.

    Add this public function:

        handleSignedMessage(request, options)

    Use these exact input shapes:

        interface HandleSignedMessageRequest {
          readonly method: string;
          readonly contentType: string | undefined;
          readonly body: Uint8Array;
        }

        interface HandleSignedMessageOptions {
          readonly authorize: SignedMessageAuthorizer;
          readonly maxBodyBytes: number;
          readonly maxTextBytes: number;
        }

    `request` and `options` must be plain objects with own properties matching the interfaces above; reject missing or unsupported own properties with `TypeError`. Every property is required, including `contentType`, whose value is `undefined` when the HTTP header was absent. Use `<container>.<field> is required.` for a missing property. `body` is always the raw request bytes after the node server has applied its streaming limit. Both byte limits are required positive integers and have no defaults. Validate `options` before `request`. Throw `TypeError` for a non-function `options.authorize`, a byte limit that is not a positive integer, a non-string method, a `contentType` value other than string or `undefined`, or a body that is not `Uint8Array`. Use field-specific messages such as `options.maxBodyBytes must be a positive integer.` and `request.body must be a Uint8Array.` Use `Unsupported options field: <field>.` and `Unsupported request field: <field>.` for extra own properties.

    Process a well-typed request in this exact order:

    1. Require `request.method === "POST"`. Return status `405` with code `method_not_allowed` otherwise.
    2. Require `request.contentType` to match `/^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*)?$/i`. This accepts `application/json` with an optional `charset=utf-8` parameter and horizontal whitespace. Return status `415` with code `unsupported_content_type` for a missing value, another parameter, or another media type.
    3. Compare `request.body.byteLength` to `options.maxBodyBytes`. Return status `413` with code `body_too_large` before decoding or parsing when it exceeds the limit.
    4. Decode the bytes as UTF-8 with `new TextDecoder("utf-8", { fatal: true })`, then call `JSON.parse(...)`. Map invalid UTF-8 and JSON syntax failures to status `400` with code `invalid_json`.
    5. If the parsed value has an own string `text` field, measure `new TextEncoder().encode(text).byteLength`. Return status `413` with code `text_too_large` before authorization when it exceeds `options.maxTextBytes`. Let `options.authorize(...)` produce the normal schema error for missing or non-string text.
    6. Call `options.authorize(parsedValue)`. Map `SignedMessageValidationError`, `SignedMessageVerificationError`, and `SignedMessageAuthorizationError` to their existing status, code, message, and optional details. Propagate unexpected exceptions so programming and infrastructure failures remain visible.

    Use frozen result and body objects. Rejections have this shape:

        {
          status: 400 | 401 | 403 | 405 | 413 | 415,
          body: {
            error: string,
            code: string,
            details?: Readonly<Record<string, unknown>>
          }
        }

    Use these stable package-owned messages for the new HTTP-layer errors:

    - `method_not_allowed`: `Method must be POST.`
    - `unsupported_content_type`: `Content-Type must be application/json with optional charset=utf-8.`
    - `body_too_large`: `Request body exceeds the configured byte limit.`
    - `invalid_json`: `Request body must be valid UTF-8 JSON.`
    - `text_too_large`: `text exceeds the configured byte limit.`

    For a valid message, return the HTTP response values together with the exact frozen message returned by the configured authorizer:

        {
          status: 202,
          body: { status: "accepted", signer: message.signer },
          message
        }

    `message` is the trusted handoff value for the node's implementation-specific logic. The HTTP adapter sends only `status` and `body` to the remote caller. Repeating the same valid request with the same configuration returns an equivalent acceptance result.

6. Add package tests.

    Suggested test files:

        packages/messages/test/schema.test.js
        packages/messages/test/signature.test.js
        packages/messages/test/ingress.test.js

    Tests should cover:

    - accepts a valid signed text message from an authorized signer;
    - rejects invalid JSON and invalid body shape;
    - rejects empty or overlarge text;
    - rejects invalid Ethereum addresses and malformed signatures;
    - rejects signatures that do not recover to `signer`;
    - rejects valid signatures from signers outside the allowlist;
    - throws `TypeError` for malformed request/options containers, invalid request field types, a non-function authorizer, zero, negative, fractional, `NaN`, or infinite byte limits;
    - accepts the exact supported content-type forms and rejects missing or unsupported forms with `415` and `unsupported_content_type`;
    - rejects non-`POST` methods with `405` and `method_not_allowed`;
    - maps invalid UTF-8 and JSON syntax to `400` and `invalid_json`;
    - returns the exact validated, frozen, authorized message on acceptance;
    - keeps the trusted `message` handoff separate from the HTTP response `body`;
    - rejects an overlarge body before decoding or JSON parsing and overlarge text before invoking an injected authorizer;
    - preserves structured validation, verification, and authorization statuses, codes, messages, and details;
    - propagates unexpected authorizer exceptions;
    - freezes accepted and rejected result and body objects;
    - returns the same acceptance result for repeated calls with the same signed text and configuration;
    - accepts separately signed identical text;
    - produces HTTP-shaped statuses suitable for a node endpoint.

7. Update documentation.

    Update `packages/messages/README.md` and, if needed, `packages/README.md` to say `@oyaprotocol/messages` now exposes functional signed text ingress APIs.

8. Build and smoke-import.

    Commands:

        npm --prefix packages run build
        node --test packages/messages/test/*.test.js
        node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"

    Expected result: TypeScript build succeeds, all message tests pass, and the smoke import prints `function function`.

9. Run package-area regression checks.

    Commands:

        node --test packages/utils/test/*.js
        node --test packages/ipfs/test/*.js
        node --test packages/ethereum/test/*.js

    Expected result: existing package tests still pass. If dependency or package-lock changes affect the workspace, rerun `npm --prefix packages run build` after any fix.

## Validation and Acceptance

The implementation is accepted when all of the following are true:

- `@oyaprotocol/messages` exports functional signed-message validation, verification, and authorization APIs.
- The package root exports the signed text message validation and verification functions through `dist/index.js` and `dist/index.d.ts`.
- A valid request body containing `text`, `signer`, and `signature` verifies successfully when `signature` is an Ethereum signed-message signature over exactly `text`.
- The same valid signed text is rejected when the signer is not in the explicit allowlist.
- A changed `text`, changed `signer`, or changed `signature` fails verification.
- A successful handler result exposes the exact validated, frozen, authorized message through `result.message` for implementation-specific logic.
- The accepted HTTP `body` remains separate from the trusted `message` handoff value.
- The node server caps request bytes while reading, and the handler applies configured body and text limits before JSON parsing and signature verification.
- The handler contract fixes request and option field types, requires explicit positive byte limits, defines content-type and UTF-8 behavior, and maps every expected rejection to a stable status and code.
- Repeating the same valid request with the same configuration returns the same acceptance result, and separately signed identical text is accepted.
- The HTTP-shaped helper accepts request data and returns status and JSON body values suitable for mounting in a node process.
- Package source dependencies resolve through hardened package-root exports.
- The package README documents exact text preservation, Internet-facing request-body and text limits, and the replay/idempotency requirement for non-idempotent side effects.

Required commands from the repository root:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"

Broader package regression commands:

    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js

Validation runs locally with deterministic public test fixtures or static signature vectors.

## Idempotence and Recovery

This work is package-local and should be safe to retry.

If dependency installation is interrupted, rerun `npm --prefix packages install` and record the result in `Outcomes & Retrospective`.

If a chosen dependency is rejected during review, revert only the dependency and the package-local verification adapter, then replace it with either a different focused Ethereum signature dependency or an injected verifier interface. The schema, ingress helper, tests around malformed input, and docs can remain mostly intact.

If the package API names change during review, update `packages/messages/README.md`, tests, and smoke-import commands in this plan in the same change. The package root `exports` surface should remain the only public import path.

Implement later node integration in `node/` or another explicit package plan after this package API is complete.

## Artifacts and Notes

Historical placeholder evidence from the start of this plan:

    packages/messages/src/index.ts exports:
    packageInfo = Object.freeze({ name: '@oyaprotocol/messages', status: 'placeholder' })

Draft wire body:

    {
      "text": "Please withdraw 100 USDC.",
      "signer": "0x1111111111111111111111111111111111111111",
      "signature": "0x..."
    }

Draft accepted handler result:

    {
      "status": 202,
      "body": {
        "status": "accepted",
        "signer": "0x1111111111111111111111111111111111111111"
      },
      "message": {
        "text": "Please withdraw 100 USDC.",
        "signer": "0x1111111111111111111111111111111111111111",
        "signature": "0x..."
      }
    }

Draft rejection body:

    {
      "error": "Invalid signature.",
      "code": "invalid_signature"
    }

Repeated-submission note for docs:

    An EIP-191 signature authenticates the signer and exact `text`; it does not establish freshness. The same valid signature remains valid across repeated submissions and anywhere the signer is authorized. Before performing a non-idempotent side effect, a node consumer must apply a durable replay/idempotency policy or make the operation itself idempotent.

## Interfaces and Dependencies

Public package entrypoint:

- `@oyaprotocol/messages`

Current exported functions and types:

- `validateSignedMessage(input)`
- `verifySignedMessage(input)`
- `createSignedMessageAuthorizer(allowedSigners)`
- `handleSignedMessage(request, options)`
- `SignedMessageAuthorizer`
- `SignedMessageInput`
- `SignedMessageValidationError`
- `SignedMessageVerificationError`
- `SignedMessageAuthorizationError`
- `HandleSignedMessageRequest`, with required `method: string`, `contentType: string | undefined`, and `body: Uint8Array`
- `AcceptedSignedMessage`, containing status `202`, the HTTP response `body`, and the authenticated `Readonly<SignedMessageInput>` as `message`
- `RejectedSignedMessage`, containing status `400 | 401 | 403 | 405 | 413 | 415` and a structured error `body`
- `HandleSignedMessageOptions`, with required `authorize: SignedMessageAuthorizer`, `maxBodyBytes: number`, and `maxTextBytes: number`
- `HandleSignedMessageResult = AcceptedSignedMessage | RejectedSignedMessage`
- `SignedMessageHttpErrorCode = "method_not_allowed" | "unsupported_content_type" | "body_too_large" | "invalid_json" | "text_too_large"`

Runtime dependency:

- `@noble/hashes` for Keccak-256 hashing.
- `@noble/curves` for secp256k1 public-key recovery.
- The runtime dependency surface uses these focused packages for EIP-191 signed-text verification and Ethereum address derivation.

Internal package dependency:

- `@oyaprotocol/utils` provides already-public shared validation helpers; add further shared helpers when multiple packages establish the shared requirement.

Configuration inputs:

- The caller supplies signer allowlists through `createSignedMessageAuthorizer(...)` and passes the resulting function as `options.authorize`.
- The caller supplies `maxBodyBytes` and `maxTextBytes` as explicit positive integer byte limits.
