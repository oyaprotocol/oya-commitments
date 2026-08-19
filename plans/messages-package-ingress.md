# Add Signed Text Message Ingress Package

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build `@oyaprotocol/messages` from a placeholder package into the first hardened message-ingress kernel for Oya nodes.

After this work, a node process should be able to accept a small HTTP JSON request from an authorized user, verify that the request contains a text message signed by the claimed Ethereum address, and receive an accepted-message object that the node can hand to its own implementation-specific logic. The message package will not decide what the text means. A node may later choose to publish the text to IPFS, trigger an Ethereum transaction, ignore it, or route it to an agent-specific policy engine, but those actions are outside this package.

The observable behavior after completion is:

1. a caller submits `POST /v1/messages`-style JSON with only `text`, `signer`, and `signature`;
2. `@oyaprotocol/messages` validates the body, verifies that the exact `text` is covered by the Ethereum signature, recovers the signer, checks the signer against an explicit allowlist, and returns an acceptance result without generating an identifier or retaining request history;
3. malformed, unsigned, mis-signed, overlarge, or unauthorized messages produce structured rejection errors that a node can map to HTTP status codes.

The signed message is intentionally text-only. There is no separate identifier, protocol `version`, `meta`, chain ID, commitment address, Safe address, proposal kind, IPFS field, or instruction schema in the wire message. A caller that needs an identifier may include one inside `text`, where it is automatically covered by the signature. The package treats all such conventions as opaque text and retains no request history.

## Progress

- [x] 2026-05-24: Reviewed `PLANS.md`, `packages/AGENTS.md`, current package docs, and the placeholder `packages/messages` implementation before drafting this plan.
- [x] 2026-05-24: Created this draft ExecPlan for user review before implementation.
- [x] 2026-05-26: Updated the proposed Ethereum signature implementation to use focused `@noble` crypto libraries instead of `viem`.
- [x] 2026-06-05: Incorporated review feedback to start with the smallest useful slice: strict schema validation before crypto dependencies or HTTP handling.
- [x] 2026-06-05: Implemented `validateSignedMessage(...)`, `SignedMessageValidationError`, schema exports, and focused schema tests in `packages/messages`.
- [x] 2026-06-07: Removed schema-level text-size policy; message size will be handled by the future ingress layer.
- [x] 2026-06-07: Removed the exported `SignedMessage` interface and `textByteLength` from the schema result to keep the current API minimal.
- [x] 2026-06-07: Reused `@oyaprotocol/utils` for the shared plain-object check instead of duplicating it in `packages/messages`.
- [x] 2026-06-07: Renamed the schema API from `normalizeSignedMessage(...)` to `validateSignedMessage(...)` and stopped lowercasing the submitted signer address.
- [x] 2026-07-26: Added focused Noble dependencies and implemented `verifySignedMessage(...)` with EIP-191 hashing, secp256k1 recovery, case-insensitive signer comparison, structured verification errors, and fixed-vector tests.
- [x] 2026-07-28: Upgraded `@noble/curves` and `@noble/hashes` to 2.2.0, migrated to their ESM subpaths and recoverable-signature API, and declared the resulting Node.js 20.19.0 runtime floor.
- [x] 2026-07-28: Restricted signed-message text to the same ASCII byte policy as IPFS text reads and replaced the Unicode signature fixture with an ASCII recovery-bit fixture.
- [x] 2026-07-28: Removed the disposable test signer's private-key literal from signature-test provenance to comply with the repository's categorical no-committed-private-keys policy.
- [x] 2026-07-28: Added standalone `authorizeMessageSigner(...)` allowlist authorization with case-insensitive address matching, fail-closed empty lists, structured `unauthorized_signer` errors, and focused tests.
- [x] 2026-08-15: Replaced the public signer-only helper with `authorizeSignedMessage(...)`, which verifies the signed message internally before checking allowlist membership.
- [x] 2026-08-15: Replaced per-call allowlist validation with `createSignedMessageAuthorizer(...)`, which snapshots a private normalized Set once and returns a frozen reusable authorizer.
- [x] 2026-08-15: Simplified `SignedMessageAuthorizer` to a function type and removed the unused `allowedSignerCount` metadata from the returned authorization capability.
- [x] 2026-08-18: Revised the remaining protocol plan to require a caller-provided `identifier` covered by the signature, removed node-generated message keys, and kept request handling stateless and functional.
- [x] 2026-08-19: Removed the planned identifier field before implementation, restored the existing text-only signed payload, and left optional identifier conventions inside opaque signed text.
- [ ] Implement stateless HTTP-shaped handling and remaining tests in `packages/messages`.
- [ ] Update final package documentation and validation evidence after the full ingress implementation is complete.

## Surprises & Discoveries

- Observation: `@oyaprotocol/messages` was only a placeholder package shell when this plan began.
  Evidence: the initial `packages/messages/src/index.ts` exported `packageInfo` with `status: 'placeholder'`; the schema milestone subsequently removed it.

- Observation: The hardened package area must not import legacy runtime code.
  Evidence: `packages/AGENTS.md` says existing code under `agent/`, `agent-library/`, `node/`, and `frontend/` is reference material only for production-kernel packages.

- Observation: Existing message ingress and publication logic in `agent/src/lib/` can inform the design but must not be reused by import.
  Evidence: `agent/src/lib/message-api.js`, `agent/src/lib/message-signing.js`, and `agent/src/lib/message-publication-api.js` already contain useful reference behavior for signed requests, HTTP status mapping, and publication flows, but package rules prohibit importing that code into `packages/messages`.

- Observation: The first implementation milestone removed the `packageInfo` placeholder export and replaced it with real schema-validation exports, before the later signature milestone added cryptographic verification.
  Evidence: `packages/messages/test/schema.test.js` covers schema behavior independently from `packages/messages/test/signature.test.js`.

- Observation: JavaScript string length cannot be used in the EIP-191 prefix because it counts UTF-16 code units rather than encoded message bytes.
  Evidence: the earlier fixed `Oya 🌱` ethers signature verified only when the prefix used the UTF-8 byte length produced by `utf8ToBytes(...)`. That fixture was removed when the package later restricted text to ASCII, but digest construction continues to use encoded byte length.

- Observation: The reviewed Noble versions already used elsewhere in this repository expose the complete recovery surface without a higher-level Ethereum dependency.
  Evidence: `@noble/curves` 1.9.1 provides compact signature parsing, recovery-bit attachment, and secp256k1 public-key recovery; `@noble/hashes` 1.8.0 provides Keccak-256 and byte/hex utilities.

- Observation: Noble 2.2.0 changed both module and recovery conventions in ways that matter for EIP-191.
  Evidence: package subpaths require explicit `.js` extensions; recoverable signatures are encoded as `recovery || r || s` rather than Ethereum's `r || s || v`; and `secp256k1.recoverPublicKey(...)` defaults to SHA-256 prehashing, so recovery over the already-computed EIP-191 Keccak-256 digest must pass `{ prehash: false }`.

- Observation: The existing shared ASCII policy is a byte-range check, not a printable-text policy.
  Evidence: `assertAsciiBytes(...)` rejects bytes greater than `0x7f`, so message validation now rejects all non-ASCII UTF-8 encodings while preserving every ASCII byte, including control bytes and `0x7f`, just like the IPFS text readers.

- Observation: A node-generated fingerprint cannot distinguish a retry from an intentional second submission of identical text.
  Evidence: A key derived from signer, signature, and text identifies an exact signed artifact, while the caller alone knows whether two identical instructions are one retried request or two intended requests.

- Observation: A separate caller identifier is also unnecessary when the package is stateless and treats signed text as opaque.
  Evidence: A caller can include an identifier in `text` when its application needs one, and the existing EIP-191 signature then authenticates it automatically. The package has no storage or interpretation behavior that requires the identifier to be a distinct wire field.

## Decision Log

- Decision: The v1 wire body contains only `text`, `signer`, and `signature`. This decision was temporarily superseded on 2026-08-18 and reinstated on 2026-08-19.
  Rationale: The user wants signed text messages without an overloaded envelope. The node should interpret text according to its own internal rules, not according to package-level commitment or transaction fields.
  Date/Author: 2026-05-24; reinstated 2026-08-19 / Codex.

- Decision: The v1 wire body contains exactly `identifier`, `text`, `signer`, and `signature`. This decision was superseded on 2026-08-19 before implementation.
  Rationale: A caller-provided identifier lets retries reuse one identifier while intentional duplicate instructions use different identifiers. Rejecting all other fields preserves the small, auditable envelope.
  Date/Author: 2026-08-18 / Codex.

- Decision: The signature scheme is Ethereum signed text, not a generic multi-scheme signature abstraction.
  Rationale: The user clarified that signatures will follow Ethereum signing standards. The package can still avoid Ethereum-domain fields in the message body while using Ethereum address recovery for authentication.
  Date/Author: 2026-05-24 / Codex.

- Decision: The signed payload is exactly the `text` string. This decision was temporarily superseded on 2026-08-18 and reinstated on 2026-08-19.
  Rationale: This keeps the protocol understandable to users and compatible with common wallet `personal_sign` / EIP-191 signed-message behavior. It also avoids hidden canonical JSON fields that would make the message look simple while signing something larger.
  Date/Author: 2026-05-24; reinstated 2026-08-19 / Codex.

- Decision: The EIP-191 signed payload covers both `identifier` and `text` using one domain-separated, length-prefixed string produced by `createSignedMessagePayload(...)`. This decision was superseded on 2026-08-19 before implementation.
  Rationale: The identifier must be authenticated to support reliable caller correlation. Domain separation prevents a new structured message from being confused with the legacy text-only payload, and byte-length prefixes avoid collisions or parsing ambiguity when either field contains delimiters.
  Date/Author: 2026-08-18 / Codex.

- Decision: The canonical payload is the UTF-8 encoding of `oya-message-v1\n${identifierByteLength}:${identifier}\n${textByteLength}:${text}`, where both lengths are base-10 UTF-8 byte counts with no leading zeroes. This decision was superseded on 2026-08-19 before implementation.
  Rationale: This encoding is deterministic, independently reproducible by non-JavaScript callers, and does not depend on JSON property order or serializer escaping choices. `createSignedMessagePayload(...)` must be exported so JavaScript callers can construct exactly the bytes that verification expects.
  Date/Author: 2026-08-18 / Codex.

- Decision: Implement built-in Ethereum signature verification in `@oyaprotocol/messages` using focused `@noble` crypto libraries rather than a higher-level Ethereum client package such as `viem`.
  Rationale: A message-ingress package should be able to verify messages by itself, but it only needs Keccak-256 hashing and secp256k1 public-key recovery. `@noble/hashes` and `@noble/curves` keep the dependency surface narrower than a full Ethereum client while avoiding hand-rolled cryptography.
  Date/Author: 2026-05-26 / Codex.

- Decision: The package may expose server-agnostic HTTP helper functions, but it must not start a server or own routing.
  Rationale: The goal is Internet ingress, but `packages/` must avoid app wiring, daemon startup, environment loading, and repo-specific process behavior. A node daemon can mount the package helper behind `POST /v1/messages`.
  Date/Author: 2026-05-24 / Codex.

- Decision: Public function and type names should avoid repeating the word "Ingress".
  Rationale: The package name and documentation already establish that this work is about receiving signed messages. Shorter names such as `handleSignedMessage(...)` are clearer at call sites than `handleSignedMessageIngress(...)`.
  Date/Author: 2026-05-26 / Codex.

- Decision: Public function and type names should also avoid repeating the word "Text".
  Rationale: The v1 package contract already says messages contain a `text` field. Names such as `validateSignedMessage(...)` and `verifySignedMessage(...)` are shorter while remaining unambiguous inside `@oyaprotocol/messages`.
  Date/Author: 2026-05-26 / Codex.

- Decision: No cryptographic freshness or replay protection is part of v1.
  Rationale: The same signed text remains valid anywhere the signer is authorized. The stateless package cannot distinguish a retry from an intentional repeated instruction and should accept either. Any stateful replay or deduplication policy belongs to a higher-level consumer.
  Date/Author: 2026-05-24; reaffirmed 2026-08-19 / Codex.

- Decision: Reject unknown top-level fields in the v1 signed message body.
  Rationale: The wire contract is intentionally small and audit-focused. Rejecting extra fields prevents callers from assuming hidden package semantics for fields such as `meta`, `chainId`, or `version`, and makes the node's responsibility for interpreting only `text` explicit.
  Date/Author: 2026-06-05 / Codex.

- Decision: Preserve `text` exactly during schema validation and only reject the zero-length empty string.
  Rationale: The signed payload is exactly the `text` string, so trimming or canonicalizing whitespace would change what later signature verification must recover. A whitespace-only string can still be a signed text message; policy about usefulness belongs above the package.
  Date/Author: 2026-06-05 / Codex.

- Decision: Require `identifier` to be a non-empty ASCII string, preserve it exactly, and assign no UUID, ordering, or global-uniqueness semantics in the package. This decision was superseded on 2026-08-19 before implementation.
  Rationale: ASCII avoids Unicode normalization ambiguity and supports common UUID, ULID, hash, and application-defined identifiers. The caller owns identifier generation and meaning; the stateless node validates and authenticates it without tracking prior values.
  Date/Author: 2026-08-18 / Codex.

- Decision: Do not define a separate identifier field or identifier format in the package.
  Rationale: The package neither interprets nor stores identifiers. Applications that need correlation can place an identifier inside the opaque signed `text` using their own convention, while callers that do not need one avoid an unnecessary field.
  Date/Author: 2026-08-19 / Codex.

- Decision: Schema validation does not enforce text-size limits.
  Rationale: The package should keep low-level shape validation separate from node-specific ingress policy. The future HTTP-shaped helper should own operational size limits together with request body limits.
  Date/Author: 2026-06-07 / Codex.

- Decision: The schema result contains only `text`, `signer`, and `signature`. This decision was temporarily superseded on 2026-08-18 and reinstated on 2026-08-19.
  Rationale: Future signature verification can compute byte length when building the EIP-191 prefix instead of carrying that value in the public schema result.
  Date/Author: 2026-06-07; reinstated 2026-08-19 / Codex.

- Decision: The schema result contains only `identifier`, `text`, `signer`, and `signature`. This decision was superseded on 2026-08-19 before implementation.
  Rationale: These are the complete wire fields. Both caller-controlled content fields are preserved for signature verification and returned unchanged; derived fields are unnecessary.
  Date/Author: 2026-08-18 / Codex.

- Decision: Schema validation preserves the submitted signer address casing.
  Rationale: Schema validation should only check wire compatibility and should not assume downstream canonicalization policy. Signature verification and allowlist checks can perform case-insensitive comparisons internally when needed.
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
  Rationale: Reusing `assertAsciiBytes(...)` gives signed messages and retrieved text artifacts one narrow character policy, rejects Unicode normalization and display ambiguities before signature verification, and preserves exact submitted ASCII without trimming or normalization.
  Date/Author: 2026-07-28 / Codex.

- Decision: Expose allowlist authorization as `authorizeMessageSigner(signer, allowedSigners)` rather than combining it with signature verification. This decision was superseded on 2026-08-15.
  Rationale: The signer-only name makes the trust boundary explicit: callers must pass the signer from `verifySignedMessage(...)`. The helper can remain independently reusable by the future ingress layer without changing the existing verification API or implying that arbitrary message objects have been cryptographically checked.
  Date/Author: 2026-07-28 / Codex.

- Decision: Treat a valid but non-allowlisted signer as `unauthorized_signer` with status `403`, while treating malformed signer or allowlist inputs as `TypeError`. The malformed-signer portion of this decision was superseded on 2026-08-15.
  Rationale: Membership failure is an authorization result suitable for HTTP mapping. Invalid address shapes and non-array allowlists are caller configuration or API-use errors, not authentication outcomes. Empty arrays are valid and intentionally deny every signer.
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
  Rationale: After removing unused allowlist-count metadata, a one-method object added no useful public behavior. A named function type preserves dependency injection and the private normalized allowlist closure with a smaller call surface.
  Date/Author: 2026-08-15 / Codex.

- Decision: Do not generate or return a node-computed message key.
  Rationale: A derived key cannot express whether identical instructions are retries or intentionally separate submissions, and the stateless package has no deduplication behavior that needs such a key. Higher-level conventions may embed identifiers in signed text when correlation is useful.
  Date/Author: 2026-08-18; reaffirmed 2026-08-19 / Codex.

- Decision: Treat statelessness as the absence of request history or request-dependent mutation; immutable validated configuration such as the authorizer's private allowlist snapshot is allowed.
  Rationale: A functional handler needs stable authorization policy but should return its result from only the current request and fixed configuration. It must not remember accepted messages or prior responses between calls.
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

The EIP-191 verification milestone is complete. `verifySignedMessage(...)` validates the wire body, hashes exactly the encoded message bytes with the Ethereum signed-message prefix, accepts recovery values encoded as `27`/`28` or `0`/`1`, recovers the secp256k1 public key, derives its Ethereum address with Keccak-256, and compares it to the submitted signer without changing signer casing. Fixed ASCII vectors generated with ethers v6 cover both recovery bits without making ethers a package dependency.

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

The initial standalone authorization milestone introduced `authorizeMessageSigner(...)` for case-insensitive membership checks, fail-closed empty arrays, and structured authorization errors. The public signer-only API was later superseded because it could not enforce that its signer argument came from signature verification.

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

The current authorization boundary exports `createSignedMessageAuthorizer(...)`. Factory creation validates every address, normalizes case, removes duplicates, and snapshots the input into a private Set. The returned frozen function preserves the composed validation, verification, and membership-checking sequence without exposing allowlist metadata or storage.

Prevalidated-authorizer validation run on 2026-08-15:

    npm --prefix packages run build
    node --test packages/messages/test/*.js
    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => { const authorize = m.createSignedMessageAuthorizer([]); console.log(typeof m.createSignedMessageAuthorizer, typeof authorize, Object.isFrozen(authorize), Object.hasOwn(m, 'authorizeSignedMessage'), Object.hasOwn(m, 'authorizeMessageSigner')); })"

The build succeeded, the smoke import printed `function function true false false`, and all 94 hardened-kernel tests passed: 18 messages, 11 utils, 45 IPFS, and 20 Ethereum. Tests also confirm that case-variant duplicates collapse, mutating the original array does not alter authorization policy, and the private Set is not exposed.

On 2026-08-18, the remaining design was revised before HTTP ingress implementation to consider a required caller-provided identifier. On 2026-08-19, that proposal was removed before any source implementation because identifiers can be embedded in opaque signed text when a higher-level application needs them. The node-generated message-key proposal also remains removed. The existing three-field schema and text-only EIP-191 verification are therefore already the intended protocol; the remaining implementation is limited to functional HTTP-shaped handling with no request history.

## Context and Orientation

The hardened package workspace lives under `packages/`.

The relevant files at the start of this plan are:

- `packages/messages/src/index.ts`: exports the package-root schema API and no longer exports placeholder metadata.
- `packages/messages/src/schema.ts`: validates the v1 signed text message shape and defines structured schema errors.
- `packages/messages/src/ethereum-signature.ts`: verifies EIP-191 text signatures and defines structured cryptographic verification errors.
- `packages/messages/src/authorization.ts`: prevalidates and snapshots allowlists into reusable authorizers that verify signed messages and authorize their recovered signers.
- `packages/messages/test/schema.test.js`: covers schema acceptance, exact text preservation, unknown-field rejection, text limits, Ethereum address shape, and signature shape.
- `packages/messages/test/signature.test.js`: covers fixed ASCII EIP-191 vectors, recovery-value normalization, mismatch failures, and malformed signature scalars.
- `packages/messages/test/authorization.test.js`: covers configuration-time validation, policy snapshotting, private normalized membership, composed verification and authorization, fail-closed empty lists, preserved validation and verification errors, and structured authorization failures.
- `packages/messages/README.md`: documents the three-field schema, EIP-191 verification, allowlist authorization, replay limitations, and remaining stateless HTTP work.
- `packages/messages/package.json`: exposes the package root through `dist/index.js` and `dist/index.d.ts`.
- `packages/package.json`: owns the TypeScript build command for all kernel packages.
- `packages/AGENTS.md`: local instructions for package code, including no imports from legacy runtime directories.
- `packages/utils`: available shared helpers for validation, HTTP status errors, and async retry/abort behavior. Use it only when a helper is genuinely shared and already public through `@oyaprotocol/utils`.

Reference-only code that may be read but not imported:

- `agent/src/lib/message-api.js`: current runtime HTTP endpoint for signed user messages.
- `agent/src/lib/message-signing.js`: current EIP-191-style canonical message helper for legacy agent user messages.
- `agent/src/lib/signed-published-message.js`: current publication-specific signed-message helper.
- `agent/scripts/send-signed-message.mjs`: current CLI for sending legacy agent messages.

Definitions:

- Text message: the user-authored string in the `text` field. The package treats it as opaque text.
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

First, replace the placeholder export with a small public API centered on signed text message ingress. Keep the package focused on message shape, signature verification, allowlist authorization, and HTTP-friendly result objects. The package must not create identifiers, interpret optional identifier conventions inside text, or retain request history.

Second, add package-local TypeScript modules under `packages/messages/src/` instead of putting all behavior in `index.ts`. A likely source layout is:

- `schema.ts` for the wire body and validation helpers.
- `ethereum-signature.ts` for Ethereum address normalization and EIP-191 text-signature verification.
- `authorization.ts` for allowlist normalization and membership checks.
- `ingress.ts` for a server-agnostic request/body handler that returns HTTP-shaped status and JSON bodies without starting a server.
- `errors.ts` for structured error classes or error result shapes that keep status-code mapping consistent.
- `index.ts` for package-root exports only.

Third, add focused tests under `packages/messages/test/`. Tests should use locally generated or fixed Ethereum signed-message vectors. If a deterministic private key is used in tests, it must be a public test-only key documented in the test file, never a secret.

Fourth, update `packages/messages/README.md` so consumers understand the minimal wire protocol, the fact that text is opaque, the stateless replay limitation, the option for higher-level conventions to embed identifiers inside signed text, and how a node can mount the helper behind `POST /v1/messages`.

Do not modify `node/` or `agent/` in this first package milestone unless the user explicitly asks for integration. This plan is to make the package capable of receiving and verifying messages; daemon adoption can be a follow-on plan.

## Concrete Steps

Work from the repository root unless a command says otherwise.

1. Review the messages package and package workspace.

    Command:

        sed -n '1,160p' packages/messages/src/index.ts
        sed -n '1,160p' packages/messages/package.json
        sed -n '1,120p' packages/AGENTS.md

    Expected result: confirm the current package-root exports and that package-local instructions still prohibit importing legacy runtime code.

2. Add focused Ethereum signature dependencies to `packages/messages/package.json`. This step is complete.

    Pinned dependencies:

        "@noble/curves": "2.2.0"
        "@noble/hashes": "2.2.0"

    Use `npm --prefix packages install` after editing package metadata so `packages/package-lock.json` records the workspace dependency. If the environment blocks registry access, request normal network approval rather than vendoring code or copying dependencies from another workspace.

3. Implement strict schema validation. This step is complete.

    The existing public validator is:

        validateSignedMessage(input)

    The validator should require:

    - `text` is a non-empty ASCII string after no implicit semantic parsing.
    - `signer` is a valid Ethereum address.
    - `signature` is a 0x-prefixed Ethereum signature hex string.
    - unknown top-level fields are rejected; the only accepted fields are `text`, `signer`, and `signature`.

    Message size limits are not part of schema validation. The future ingress helper should make maximum request body size and, if needed, maximum text size configurable by the node.

4. Implement Ethereum signed-text verification. This step is complete.

    The public function is:

        verifySignedMessage(input)

    `verifySignedMessage(...)` should:

    - validate the body;
    - compute the EIP-191 Ethereum signed-message digest for exactly `text` using the prefix `"\x19Ethereum Signed Message:\n" + byteLength(text) + text`;
    - recover the secp256k1 public key from the digest and signature using `@noble/curves`;
    - derive the Ethereum address as the last 20 bytes of Keccak-256 over the uncompressed public key without its `0x04` prefix, using `@noble/hashes`;
    - normalize common signature recovery IDs, including `v` values `27`/`28` and `0`/`1`;
    - compare the recovered address to `signer` case-insensitively;
    - return the unchanged validated message.

    Allowlist authorization is implemented separately by `createSignedMessageAuthorizer(...)`. No message identifier or message-key step follows verification.

5. Implement HTTP-shaped message helper.

    Add a public helper with a name close to:

        handleSignedMessage(request, options)

    Keep it server-agnostic. It may accept method, headers, and already-read body text or bytes, then return:

        { status: 202, body: { status: "accepted", signer } }

    for valid messages. It should return structured rejection bodies for:

    - wrong method, if method is supplied;
    - unsupported content type;
    - body too large;
    - invalid JSON;
    - invalid shape;
    - invalid signature;
    - unauthorized signer.

    The package must not call `http.createServer(...)`, read environment variables, generate identifiers or message keys, write storage, remember accepted messages, enqueue messages, publish to IPFS, or trigger Ethereum transactions. Repeating the same valid request must return the same acceptance result; the helper must not reject it based on prior calls because it has no request history.

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
    - accepts repeated calls with the same signed text without retaining state;
    - accepts separately signed identical text without trying to classify it as a retry or duplicate;
    - does not expose or return a caller identifier or node-generated message key;
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

- `@oyaprotocol/messages` no longer exposes only placeholder metadata.
- The package root exports the signed text message validation and verification functions through `dist/index.js` and `dist/index.d.ts`.
- A valid request body containing `text`, `signer`, and `signature` verifies successfully when `signature` is an Ethereum signed-message signature over exactly `text`.
- The same valid signed text is rejected when the signer is not in the explicit allowlist.
- A changed `text`, changed `signer`, or changed `signature` fails verification.
- Repeating the same valid request does not depend on or mutate package state, and separately signed identical text is accepted without duplicate classification.
- No caller identifier or node-generated message key appears in the wire schema, public API, or accepted response.
- The HTTP-shaped helper can be mounted by a node process without the package owning server startup.
- No package source imports from `agent/`, `agent-library/`, `node/`, or `frontend/`.
- The package README documents that text is opaque, callers may embed application-specific identifiers inside it, and the stateless package does not provide freshness, replay protection, or deduplication.

Required commands from the repository root:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"

Broader package regression commands:

    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js

No RPC endpoint, private key, IPFS daemon, or production secret should be required for validation. Tests that need a signer should use deterministic public test-only keys or static signature fixtures.

## Idempotence and Recovery

This work is package-local and should be safe to retry.

If dependency installation fails because network access is unavailable, leave the source changes uncommitted and record the missing install command in `Outcomes & Retrospective`. Do not copy dependencies from another package's `node_modules`.

If a chosen dependency is rejected during review, revert only the dependency and the package-local verification adapter, then replace it with either a different focused Ethereum signature dependency or an injected verifier interface. The schema, ingress helper, tests around malformed input, and docs can remain mostly intact.

If the package API names change during review, update `packages/messages/README.md`, tests, and smoke-import commands in this plan in the same change. The package root `exports` surface should remain the only public import path.

If later node integration needs storage, queues, rate limiting, IPFS publication, or Ethereum transaction execution, add that in `node/` or another explicit package plan. Do not fold app runtime behavior into `@oyaprotocol/messages`.

If a future stateful consumer needs idempotency, it may define an identifier convention inside signed text and enforce that convention in its own durable store. Do not retrofit an identifier field, in-memory replay Set, or node-generated key into this package without a new concrete protocol requirement; those additions are unnecessary for the stateless handler and process-local state would not survive restarts or multiple replicas.

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

Draft accepted response body:

    {
      "status": "accepted",
      "signer": "0x1111111111111111111111111111111111111111"
    }

Draft rejection body:

    {
      "error": "Invalid signature.",
      "code": "invalid_signature"
    }

Optional higher-level identifier convention inside signed text:

    request-id: 01K2ZJ5R7M3R6J6F6J8Q2N7W9P

    Please withdraw 100 USDC.

Replay and state note for docs:

    The package signs and verifies the exact opaque `text`. A caller may place an application-specific identifier inside that text, but the package does not parse or store it. A valid signed request can be replayed, and the stateless handler accepts each valid submission without duplicate classification.

## Interfaces and Dependencies

Public package entrypoint:

- `@oyaprotocol/messages`

Current exported functions and types:

- `validateSignedMessage(input)`
- `verifySignedMessage(input)`
- `createSignedMessageAuthorizer(allowedSigners)`
- `SignedMessageAuthorizer`
- `SignedMessageInput`
- `SignedMessageValidationError`
- `SignedMessageVerificationError`
- `SignedMessageAuthorizationError`

Planned exported functions and types:

- `handleSignedMessage(request, options)`
- `AcceptedSignedMessage`
- `HandleSignedMessageOptions`
- `HandleSignedMessageResult`
- structured error types or error result codes for body and content-type failures

Runtime dependency:

- `@noble/hashes` for Keccak-256 hashing.
- `@noble/curves` for secp256k1 public-key recovery.
- The package should use these dependencies only for EIP-191 signed-text verification and Ethereum address derivation. It should not add a higher-level Ethereum client dependency for this work.

Internal package dependency:

- `@oyaprotocol/utils` may be used for already-public validation helpers if they fit. Do not add shared helpers to `utils` unless duplication across packages becomes real.

External services:

- None. Verification is local and deterministic.

Environment variables:

- None. The caller supplies allowlists and limits as explicit options.

Non-goals for this package:

- no HTTP server process;
- no caller identifier field or node-generated message key;
- no accepted-message storage or replay cache;
- no persistent queue;
- no rate limiter;
- no IPFS publishing;
- no Ethereum transaction execution;
- no interpretation of the text;
- no commitment, chain, Safe, proposal, or agent-specific fields in the wire body;
- no imports from legacy runtime directories.
