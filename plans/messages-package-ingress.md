# Add Signed Text Message Ingress and Accepted-Message Handling

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

The ingress and accepted-message callback milestones are complete. The user-authorized IPFS publisher follow-on is tracked in `plans/messages-ipfs-handler.md`; its implementation starts at `packages/messages/src/handlers/publish.ts`.

## Purpose / Big Picture

Build `@oyaprotocol/messages` from a placeholder package into the first hardened message-ingress kernel for Oya nodes, then extend that kernel with one optional configured function that can act on an authenticated message.

After this work, a trusted host—normally the Oya node—should be able to pass a small HTTP-shaped JSON request from an authorized message sender, verify that the request contains a text message signed by the claimed Ethereum address, and optionally have `handleSignedMessage(...)` invoke one host-configured accepted-message handler. The host-configured function defines what happens next, such as publishing the authenticated message to IPFS, while the messages package remains independent of sockets, environment loading, process lifecycle, and any particular downstream action.

The observable behavior after completion is:

1. a remote message sender submits `POST /v1/messages`-style JSON with only `text`, `signer`, and `signature` to the host;
2. `@oyaprotocol/messages` validates the body, verifies that the exact `text` is covered by the Ethereum signature, recovers the signer, and checks the signer against an explicit allowlist;
3. after successful ingress, `handleSignedMessage(...)` optionally awaits one configured function with the frozen authenticated message and exposes that function's return value as `handleSignedMessageResult` on the accepted result;
4. malformed, unsigned, mis-signed, overlarge, or unauthorized messages produce structured rejection errors without invoking the configured function, while an exception or rejected promise from that function propagates to the host.

The signed message is intentionally text-only. Its wire body contains exactly `text`, `signer`, and `signature`. The package preserves the text exactly and passes a frozen snapshot of those authenticated fields to the optional host-configured function after authentication and authorization.

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
- [x] 2026-08-19: Defined the complete handler request, option, byte-limit, content-type, and error-mapping contract and documented the downstream publication boundary.
- [x] 2026-08-20 01:43Z: Implemented and exported functional HTTP-shaped handling with strict request/configuration validation, ordered request processing, frozen acceptance and rejection results, structured message-error mapping, and focused ingress tests.
- [x] 2026-08-20 01:43Z: Updated package documentation, rebuilt the kernel packages, smoke-imported the completed API, and passed all 109 hardened-kernel package tests.
- [x] 2026-08-26: Simplified the ingress type surface after review by exporting only the request, options, and result types; rebuilt the package and passed all 33 message tests.
- [x] 2026-08-26: Removed the package-level Node.js engine declaration and documented the ECMAScript and Web Platform APIs required by the runtime-neutral message package.
- [x] 2026-08-26: Fixed message error statuses as literal 400, 401, and 403 values, removed validation-status customization and the ingress cast, added an injected-error regression, and passed all 34 message tests.
- [x] 2026-08-26: Mapped recognized errors to fixed statuses by runtime class in ingress, expanded the regression to cover direct status mutation on all three exported error classes, and passed all 34 message tests.
- [x] 2026-08-26: Replaced the authorizer-owned success reference with a frozen three-field snapshot, added a post-acceptance mutation regression, and passed all 34 message tests.
- [x] 2026-08-26: Assigned public publication ordering to the future onchain Logger record rather than the ingress layer or IPFS artifact.
- [x] 2026-08-26: Reopened this ExecPlan for the focused accepted-message handler change and specified the async callback, result, error, test, and documentation contracts.
- [x] 2026-08-30: Distinguished the remote message sender from the trusted host/node and standardized callback-configuration references on "host" terminology.
- [x] 2026-08-30: Standardized the configured function's returned-value field as `handleSignedMessageResult` throughout this plan.
- [x] 2026-08-30: Corrected the proposed type contract so overloads correlate callback presence with a required callback-result property and callback-absent calls do not infer `unknown`.
- [x] 2026-08-30: Added a last-position fallback overload for runtime-selected callbacks without weakening the two precise overloads.
- [x] 2026-08-31 02:14Z: Added the callback-present, callback-absent, and dynamically optional option shapes, the three ordered `handleSignedMessage(...)` overloads, and the consistently asynchronous implementation.
- [x] 2026-08-31 02:14Z: Added focused ingress tests for callback ordering, awaiting, result propagation, rejection bypass, repeated invocation, and failure propagation; all 39 message tests pass.
- [x] 2026-08-31 02:14Z: Added a compile-time test against the emitted package declarations proving callback-result inference, callback-absent property exclusion, and dynamic-option narrowing under `exactOptionalPropertyTypes`.
- [x] 2026-08-31 02:14Z: Updated package documentation, rebuilt the package area, smoke-imported the public API, and passed all 76 utils, IPFS, and Ethereum regression tests.
- [x] 2026-09-01 02:36Z: Corrected the callback-result declaration to expose `Awaited<TResult>`, added an explicitly `Promise<T>`-typed handler regression, rebuilt the package, and re-passed all message and package regressions.
- [x] 2026-09-01 02:52Z: Restricted `onAcceptedMessage` to an own options property, normalized omission to an own `undefined` snapshot, added inherited function/non-function regressions, and passed all 40 message tests.
- [x] 2026-09-01 03:06Z: Replaced the three correlated options interfaces and overloads with one optional `HandleSignedMessageOptions<TResult>` interface, one function signature, and one honest accepted-result union requiring property-presence narrowing.
- [x] 2026-09-01 03:06Z: Rewrote the emitted-declaration fixture and README for the single-interface API, rebuilt and smoke-imported the package, passed all 40 message tests and the declaration test, and passed all 76 broader package regressions.
- [x] 2026-09-04: Replaced the two accepted-result interfaces with one generic `AcceptedSignedMessage<TResult>` interface whose `handleSignedMessageResult?: Awaited<TResult>` property permits direct reads after acceptance. Updated declaration tests and documentation; the package build, declaration test, package-root smoke import, and all 40 message tests passed.

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

- Observation: Before the accepted-message milestone, the ingress helper was synchronous and accepted an exact three-field options object.
  Evidence: The prior `packages/messages/src/ingress.ts` allowed only `authorize`, `maxBodyBytes`, and `maxTextBytes`; the completed milestone adds the optional handler and makes every path Promise-based.

- Observation: The existing authenticated message snapshot is already the narrow trust boundary needed by a configurable downstream function.
  Evidence: successful ingress copies `text`, `signer`, and `signature` into a new frozen object before returning it, so the callback does not need the parsed request body or an authorizer-owned reference.

- Observation: The initial callback declaration was unsound when a consumer explicitly instantiated `AcceptedSignedMessageHandler<Promise<T>>`.
  Evidence: the callback type accepted the async function and the overload exposed `Promise<T>`, while runtime `await` recursively unwrapped the callback value to `T`; the emitted-declaration fixture now covers this case.

- Observation: Checking the external options object for an own callback is insufficient if the normalized package-owned options object omits the property.
  Evidence: with `Object.prototype.onAcceptedMessage` defined, the first own-property guard ignored it but the later read from a normalized plain object inherited it again; materializing an own `undefined` snapshot closes both reads.

- Observation: An optional accepted-result property preserves precise handler-result inference without requiring a second accepted interface.
  Evidence: The emitted-declaration fixture permits direct reads as `Awaited<TResult> | undefined`, rejects assigning an unchecked optional result to a required value, and preserves exact inference after a presence check under `exactOptionalPropertyTypes`.

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

- Decision: Keep publication ordering out of the ingress package and the pre-publication IPFS artifact.
  Rationale: EIP-191 verification proves signer identity and text integrity. The future onchain Logger will provide the authoritative public publication record, with block and log positions establishing when and in what order each published CID was recorded.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Reject unknown top-level fields in the v1 signed message body.
  Rationale: The wire contract is intentionally small and audit-focused. Rejecting extra fields prevents message senders from assuming hidden package semantics for fields such as `meta`, `chainId`, or `version`, and makes the host's responsibility for interpreting only `text` explicit.
  Date/Author: 2026-06-05 / Codex.

- Decision: Preserve `text` exactly during schema validation and only reject the zero-length empty string.
  Rationale: The signed payload is exactly the `text` string, so trimming or canonicalizing whitespace would change what later signature verification must recover. A whitespace-only string can still be a signed text message; policy about usefulness belongs above the package.
  Date/Author: 2026-06-05 / Codex.

- Decision: Apply request-body limits while the node server reads the request, then apply configured body and text limits in the HTTP-shaped ingress flow before JSON parsing and signature verification respectively.
  Rationale: The server-side stream limit bounds buffering, the handler's body limit bounds JSON parsing, and the text limit bounds ASCII validation and cryptographic work.
  Date/Author: 2026-06-07; clarified 2026-08-19 / Codex.

- Decision: Return the authenticated frozen message as a distinct field on a successful HTTP-shaped result.
  Rationale: The node needs the authorized text for implementation-specific handling. Keeping `message` separate from the HTTP `body` gives the node a trusted handoff value while preserving a small response body for the remote message sender.
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

- Decision: Upgrade both Noble dependencies to exact version 2.2.0 and declare Node.js 20.19.0 as the package runtime floor. The package-level engine declaration was superseded on 2026-08-26; the exact dependency pins remain current.
  Rationale: The user requested the current Noble releases. Both packages publish the same Node.js engine requirement, and the repository's Node 22 CI satisfies it. Exact pins preserve the package's existing deterministic dependency policy.
  Date/Author: 2026-07-28 / Codex.

- Decision: Restrict v1 message text to the same ASCII byte range accepted by IPFS text reads.
  Rationale: Reusing `assertAsciiBytes(...)` gives signed messages and retrieved text artifacts one narrow character policy, rejects Unicode normalization and display ambiguities before signature verification, and preserves submitted ASCII byte-for-byte.
  Date/Author: 2026-07-28 / Codex.

- Decision: Expose allowlist authorization as `authorizeMessageSigner(signer, allowedSigners)` rather than combining it with signature verification. This decision was superseded on 2026-08-15.
  Rationale: The signer-only name made the trust boundary explicit: API consumers passed the signer from `verifySignedMessage(...)`, and the future ingress layer could reuse the helper independently.
  Date/Author: 2026-07-28 / Codex.

- Decision: Treat a valid but non-allowlisted signer as `unauthorized_signer` with status `403`, while treating malformed signer or allowlist inputs as `TypeError`. The malformed-signer portion of this decision was superseded on 2026-08-15.
  Rationale: Membership failure is an authorization result suitable for HTTP mapping. Invalid address shapes and non-array allowlists are host configuration or API-use errors represented by `TypeError`. Empty arrays are valid and intentionally deny every signer.
  Date/Author: 2026-07-28 / Codex.

- Decision: Export `authorizeSignedMessage(input, allowedSigners)` as the authorization boundary and keep raw signer membership checking private. The per-call API portion of this decision was superseded later on 2026-08-15.
  Rationale: Documentation alone cannot enforce that a signer came from `verifySignedMessage(...)`. Composing schema validation, EIP-191 verification, and membership checking prevents API consumers from accidentally authorizing the unverified `signer` field from a request while preserving the lower-level `verifySignedMessage(...)` API for verification-only use cases.
  Date/Author: 2026-08-15 / Codex.

- Decision: Preserve `SignedMessageValidationError` and `SignedMessageVerificationError` from the composed authorization API, and reserve `TypeError` for malformed allowlist configuration.
  Rationale: The complete message is untrusted request input and should retain the package's structured request-error behavior. The allowlist remains host-supplied configuration, so an invalid container or address entry is a programming/configuration failure.
  Date/Author: 2026-08-15 / Codex.

- Decision: Prevalidate authorization policy with `createSignedMessageAuthorizer(allowedSigners)` and expose request-time authorization through the returned object's `authorize(input)` method. The returned-object shape was superseded later on 2026-08-15 by a directly callable function.
  Rationale: Node allowlists are normally static configuration reused across requests. Validating and normalizing once moves configuration failures to startup, avoids rebuilding a Set on every request, snapshots the host-supplied array, and keeps the mutable Set private inside a closure. Freezing the returned object prevents its public capability from being replaced or reconfigured at runtime.
  Date/Author: 2026-08-15 / Codex.

- Decision: Represent `SignedMessageAuthorizer` as a function type and have `createSignedMessageAuthorizer(...)` return that function directly.
  Rationale: A named function type preserves dependency injection and the private normalized allowlist closure with a compact call surface.
  Date/Author: 2026-08-15 / Codex.

- Decision: Implement request handling as a function of the current request and immutable validated authorization configuration. The deterministic-result portion of this decision is superseded for configurations that include `onAcceptedMessage`.
  Rationale: Ingress rejection and authentication behavior remains determined by the request and authorization configuration. A configured downstream function may intentionally return different results or perform a new action for each otherwise identical successful submission.
  Date/Author: 2026-08-18 / Codex.

- Decision: Export only `HandleSignedMessageRequest`, `HandleSignedMessageOptions`, and `HandleSignedMessageResult` for the ingress API; keep accepted and rejected result variants internal and remove the incomplete transport-only error-code type. The three-type limit is superseded by the focused export of `AcceptedSignedMessageHandler`.
  Rationale: Consumers can narrow the result union by status without importing its branches, while a type that covered only transport codes did not accurately describe every possible rejection code. The later handler-function type is itself a public configuration contract and therefore warrants one additional named export.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Do not declare a Node.js engine requirement for `@oyaprotocol/messages`.
  Rationale: The package uses ESM plus standard ECMAScript and Web Platform primitives without importing Node-specific APIs. Runtime compatibility should be expressed through those required APIs and proven with runtime-specific smoke tests; pinned dependencies retain their own runtime metadata.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Ingress maps validation, verification, and authorization errors by runtime class to statuses 400, 401, and 403 rather than trusting their status properties.
  Rationale: The result status is its public discriminator, so injected authorizers must not be able to escape the documented rejection union or create rejection bodies with successful HTTP statuses by mutating JavaScript error instances.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Successful ingress results contain a frozen value snapshot of the authorizer's three message fields rather than the authorizer-owned object reference.
  Rationale: Downstream consumers must receive the message values accepted at authorization time, and the response signer must remain consistent with that immutable handoff even if another reference to the authorizer's object is later mutated.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Add one optional `onAcceptedMessage` function to `HandleSignedMessageOptions` instead of hard-coding IPFS publication or adding a list of package-owned actions.
  Rationale: One injected function lets the host/node select publication or another future behavior while keeping `@oyaprotocol/messages` runtime-neutral. A host that needs several ordered actions can compose them inside that single function without making ingress own an action registry or execution policy.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Pass the frozen authenticated `Readonly<SignedMessageInput>` to `onAcceptedMessage`, not the raw parsed request or the HTTP response body.
  Rationale: The three-field snapshot is the value that passed schema validation, signature verification, and authorization. Passing only that value keeps the callback on the authenticated side of the trust boundary and avoids coupling downstream behavior to transport response formatting.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Give `onAcceptedMessage` exactly one argument in this milestone and do not add transport context, an abort signal, or an action array.
  Rationale: The focused requirement is configurable post-authentication behavior. Cancellation semantics and ordered multi-action orchestration require concrete downstream policy; the host can currently close over dependencies and compose several operations inside its one configured function.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Make `handleSignedMessage(...)` consistently asynchronous and await the configured function before returning an accepted result.
  Rationale: Downstream actions such as IPFS publication are asynchronous. Always returning a Promise gives the API one stable calling convention and prevents the host from observing acceptance before the configured action settles.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Preserve the configured function's return value as an internal `handleSignedMessageResult` field on the accepted result and propagate synchronous throws or rejected promises unchanged.
  Rationale: A publication function must be able to return its CID metadata to the host, while infrastructure and programming failures must remain visible rather than being misclassified as request rejections. The existing HTTP `status` and `body` remain ingress-owned and do not absorb arbitrary callback output.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Keep the accepted-message handler optional and invoke it once for every successful call.
  Rationale: Omitting the function preserves authentication-only usage. When it is configured, ingress should not add deduplication, publication ordering, or action-specific policy; repeated valid submissions each produce one callback invocation, and future onchain Logger behavior remains responsible for the public publication record.
  Date/Author: 2026-08-26 / user and Codex.

- Decision: Export the generic `AcceptedSignedMessageHandler<TResult>` function type and make `HandleSignedMessageOptions<TResult>` and `HandleSignedMessageResult<TResult>` generic over its return value.
  Rationale: Future package-root functions such as an IPFS publisher should be able to declare compatibility with the configured hook without duplicating its signature, and host integrations should retain the concrete type of publication metadata or another configured-handler result after property-presence narrowing. The generic options design was temporarily superseded by correlated option shapes on 2026-08-30 and restored as the single public options interface on 2026-09-01.
  Date/Author: 2026-08-26; restored 2026-09-01 / user and Codex.

- Decision: Correlate statically known callback presence with accepted-result shape through two option types and two precise public `handleSignedMessage(...)` overloads.
  Rationale: A callback-present call has a runtime guarantee that the accepted result owns `handleSignedMessageResult`, so that property must be required and exactly the recursively settled `Awaited<TResult>` after narrowing `status === 202`. A callback-absent call must use the non-generic overload and return an accepted variant with no such property. The source retains one implementation signature, while emitted declarations expose these correlated overloads before the broader fallback.
  Date/Author: 2026-08-30; clarified and superseded 2026-09-01 / user and Codex.

- Decision: Apply `Awaited<TResult>` at the accepted-result boundary without changing the accepted-message handler signature.
  Rationale: This is the smallest backward-compatible correction: `AcceptedSignedMessageHandler<T>` continues accepting synchronous `T` and asynchronous `PromiseLike<T>` returns, while explicitly promise-wrapped generic arguments now describe the recursively awaited runtime value accurately.
  Date/Author: 2026-09-01 / Codex.

- Decision: Treat `onAcceptedMessage` as configured only when it is an own options property and always materialize the validated value as an own normalized property.
  Rationale: The public options contract is own-field based. Ignoring inherited values prevents prototype extensions or pollution from invoking an unintended handler or rejecting an otherwise callback-absent call, while the normalized own snapshot prevents a second prototype-chain lookup inside ingress.
  Date/Author: 2026-09-01 / Codex.

- Decision: Define `HandleSignedMessageResult<TResult = never>` so its default describes callback-absent handling and its generic form describes callback-present handling.
  Rationale: The prior function signature declared `TResult` without a default, so calls with no callback had no inference candidate and could fall back to `unknown`. The non-generic overload now returns `HandleSignedMessageResult` using its `never` default, while the generic overload infers `TResult` from the required callback and returns `HandleSignedMessageResult<TResult>`.
  Date/Author: 2026-08-30; superseded 2026-09-01 / user and Codex.

- Decision: Add a third, last-position overload for dynamically optional accepted-message handlers.
  Rationale: A host may select its callback from runtime configuration, leaving either the options object typed as a callback-present/callback-absent union or its `onAcceptedMessage` property typed as `AcceptedSignedMessageHandler<TResult> | undefined`. Neither value satisfies one specific overload even though the implementation supports both runtime branches. The fallback accepts the broader optional-handler shape and truthfully returns the union of the two possible result shapes. Keeping it after the precise overloads preserves exact inference for statically callback-present and callback-absent calls.
  Date/Author: 2026-08-30; superseded 2026-09-01 / user and Codex.

- Decision: Use one optional `HandleSignedMessageOptions<TResult = unknown>` interface and one `handleSignedMessage(...)` signature.
  Rationale: The narrower interfaces and overloads improved call-site precision but added public surface, conditional default machinery, overload tests, and maintenance risk without changing runtime safety. The single interface truthfully returns both accepted shapes for every call. Hosts narrow `status === 202` and then property presence before reading the exact `Awaited<TResult>` value.
  Date/Author: 2026-09-01; result-shape requirement superseded 2026-09-04 / user and Codex.

- Decision: Use one generic accepted-result interface with optional `handleSignedMessageResult?: Awaited<TResult>`.
  Rationale: Callers may read the property after checking acceptance and handle `undefined` normally. A presence check remains available to distinguish an omitted handler from a handler that returned `undefined`. The generic preserves the settled handler-result type, and the runtime behavior does not change.
  Date/Author: 2026-09-04 / user and Codex.

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

The Noble 2.2.0 migration preserves that behavior while adapting the implementation to ESM `.js` subpaths and the v2 recovered-signature byte layout. Recovery explicitly disables Noble's default SHA-256 prehash because `createEthereumSignedMessageDigest(...)` already supplies the EIP-191 Keccak-256 digest. The dependencies retain their own runtime metadata; `@oyaprotocol/messages` no longer duplicates that metadata with a Node-only package engine declaration.

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

The initial accepted-message handler milestone made `handleSignedMessage(...)` always return a Promise. A configured handler receives the frozen authenticated snapshot after authorization, is awaited exactly once per accepted call, and contributes its exact settled value through the required `handleSignedMessageResult` property. Rejections bypass the handler, while authorizer and handler failures reject the Promise unchanged. The initial public type surface used three correlated overloads; the later simplification recorded below replaced them with one optional interface and one honest union result.

Validation run on 2026-08-31:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"
    node --test packages/utils/test/*.js packages/ipfs/test/*.js packages/ethereum/test/*.js

The build and emitted-declaration type test succeeded, the smoke import printed `function function`, all 39 message tests passed, and all 76 broader package tests passed. The completed milestone remains local to `packages/messages`; it adds no dependency on `@oyaprotocol/ipfs`, does not import from `node/` or `agent/`, and does not implement IPFS publication or onchain Logger behavior.

A focused type-soundness follow-up on 2026-09-01 changed the callback-present accepted property from `TResult` to `Awaited<TResult>`. This preserves ordinary synchronous and asynchronous inference while making an explicit `AcceptedSignedMessageHandler<Promise<T>>` expose `T`, matching the existing runtime `await`. The package build, 39 message tests, emitted-declaration type test, `function function` smoke import, and all 76 broader package regressions passed again.

A prototype-safety follow-up on 2026-09-01 made callback configuration own-property-only. `validateOptions(...)` now reads `onAcceptedMessage` only when `Object.hasOwn(...)` succeeds and returns a normalized object that always owns the snapshotted callback value, including `undefined`. A regression installs inherited function and non-function values on `Object.prototype`, proves neither affects acceptance, and restores the original descriptor. All 40 message tests pass.

A public-surface simplification on 2026-09-01 removed `HandleSignedMessageBaseOptions`, `HandleSignedMessageOptionsWithHandler`, `HandleSignedMessageOptionsWithOptionalHandler`, all three overload declarations, the `never` default, and the conditional result branch. At that stage, the package exported one `HandleSignedMessageOptions<TResult = unknown>` interface and one generic function signature returning the rejection branch plus both accepted shapes. Every accepted call therefore required property-presence narrowing before reading `handleSignedMessageResult`, while the narrowed value retained its exact `Awaited<TResult>` type. The build, 40 message tests, emitted-declaration type test, `function function` smoke import, and all 76 broader package regressions passed.

The accepted-result simplification on 2026-09-04 replaced both accepted interfaces with `AcceptedSignedMessage<TResult = unknown>` and an optional `handleSignedMessageResult?: Awaited<TResult>`. Callers can now read the property immediately after narrowing acceptance, including through optional chaining. Presence checks still distinguish callback omission from an explicit `undefined` result, and retain precise inference with `exactOptionalPropertyTypes`. Runtime code was unchanged. The package build, emitted-declaration fixture, package-root smoke import from `packages/`, and all 40 message tests passed. No work remains for this follow-up.

## Context and Orientation

The hardened package workspace lives under `packages/`.

The relevant files at the start of this plan are:

- `packages/messages/src/index.ts`: exports the package-root validation, verification, and authorization APIs.
- `packages/messages/src/schema.ts`: validates the v1 signed text message shape and defines structured schema errors.
- `packages/messages/src/ethereum-signature.ts`: verifies EIP-191 text signatures and defines structured cryptographic verification errors.
- `packages/messages/src/authorization.ts`: prevalidates and snapshots allowlists into reusable authorizers that verify signed messages and authorize their recovered signers.
- `packages/messages/src/ingress.ts`: validates HTTP-shaped request/configuration input, enforces transport and text limits, maps expected message errors, optionally awaits the host-configured accepted-message handler, and returns frozen acceptance or rejection results through a Promise.
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

- Message sender: the remote party that submits the signed HTTP request. The message sender does not configure or invoke the accepted-message handler.
- Host: the trusted runtime code—normally the Oya node—that constructs the optional handler options, invokes `handleSignedMessage(...)`, and selects any `onAcceptedMessage` function.
- Text message: the user-authored string in the `text` field. The package preserves it exactly for host-defined interpretation.
- Signer: the Ethereum account address claimed in the request body.
- Signature: the Ethereum signed-message signature over exactly the `text` string.
- Authorized signer: a signer address included in the allowlist supplied by the node.
- Accepted-message handler: one optional host-supplied function invoked only after successful validation, verification, and authorization. It receives the frozen authenticated message and may return a value or a Promise.
- Handle-signed-message result: the exact value produced by the configured accepted-message handler after it settles, exposed as `handleSignedMessageResult` separately from the ingress-owned HTTP response body.

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

Fourth, update `packages/messages/README.md` so consumers understand the minimal wire protocol, exact text preservation, repeated-submission behavior, safe Internet-facing body and text limits, and how an external runtime adapter can mount the helper behind `POST /v1/messages`.

The focused follow-up extends `handleSignedMessage(...)` with one optional `onAcceptedMessage` function. Validate this option alongside the existing immutable configuration, convert the public handler to an `async` function, invoke the callback only after the authenticated message snapshot exists, await it, and return its exact settled value as `handleSignedMessageResult`. Rejected ingress requests must bypass the callback entirely. Callback failures must propagate unchanged.

Keep this milestone under `packages/messages`. Do not add `@oyaprotocol/ipfs` as a dependency and do not implement `publishSignedMessage(...)` yet. A later focused change can provide an IPFS-backed function matching the accepted-message handler type, and the host/node can select that function in its configuration.

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

5. Extend the HTTP-shaped message helper with optional accepted-message handling.

    The public function is consistently asynchronous and exposes one generic signature whose result truthfully includes rejection, callback-absent acceptance, and callback-present acceptance:

        function handleSignedMessage<TResult = unknown>(
          request: HandleSignedMessageRequest,
          options: HandleSignedMessageOptions<TResult>
        ): Promise<HandleSignedMessageResult<TResult>>;

    Use these exact input shapes:

        interface HandleSignedMessageRequest {
          readonly method: string;
          readonly contentType: string | undefined;
          readonly body: Uint8Array;
        }

        type AcceptedSignedMessageHandler<TResult = unknown> = (
          message: Readonly<SignedMessageInput>
        ) => TResult | PromiseLike<TResult>;

        interface HandleSignedMessageOptions<TResult = unknown> {
          readonly authorize: SignedMessageAuthorizer;
          readonly maxBodyBytes: number;
          readonly maxTextBytes: number;
          readonly onAcceptedMessage?:
            | AcceptedSignedMessageHandler<TResult>
            | undefined;
        }

        interface AcceptedSignedMessage<TResult = unknown> {
          readonly status: 202;
          readonly body: Readonly<{
            status: "accepted";
            signer: string;
          }>;
          readonly message: Readonly<SignedMessageInput>;
          readonly handleSignedMessageResult?: Awaited<TResult>;
        }

        type HandleSignedMessageResult<TResult = unknown> =
          | RejectedSignedMessage
          | AcceptedSignedMessage<TResult>;

    Export `AcceptedSignedMessageHandler`, `HandleSignedMessageOptions`, and `HandleSignedMessageResult` from `packages/messages/src/index.ts` with the existing request type. Keep the accepted and rejected result variants internal. Do not add separate callback-present, callback-absent, base, or dynamically optional option types.

    The single options interface accepts omitted, present, and runtime-selected handlers, including an `onAcceptedMessage` property typed as `AcceptedSignedMessageHandler<TResult> | undefined` under `exactOptionalPropertyTypes`. The accepted-result interface represents callback optionality with one optional property. After narrowing `status === 202`, the host may read `handleSignedMessageResult` directly as `Awaited<TResult> | undefined`. A presence check distinguishes an omitted callback from one returning `undefined`, and narrows the property to `Awaited<TResult>` when `exactOptionalPropertyTypes` is enabled.

    `request` and `options` must be plain objects with own properties matching the interfaces above; reject missing or unsupported own properties with `TypeError`. Every request property is required, including `contentType`, whose value is `undefined` when the HTTP header was absent. `authorize`, `maxBodyBytes`, and `maxTextBytes` remain required options. Callback-absent options may omit `onAcceptedMessage` or set it explicitly to `undefined`. Callback-present options require it to be an own function property. Ignore inherited `onAcceptedMessage` values and snapshot omission as an own `undefined` value in the normalized internal options object. At runtime, reject any other own value with `TypeError('options.onAcceptedMessage must be a function or undefined.')`. Add it to the allowed options field set but not the required runtime options field list.

    Use `<container>.<field> is required.` for a missing required property. `body` is always the raw request bytes after the host's external adapter has applied any streaming limit. Both byte limits are required positive integers and have no defaults. Validate `options`, including `onAcceptedMessage`, before `request`. Throw `TypeError` for a non-function `options.authorize`, a byte limit that is not a positive integer, a non-string method, a `contentType` value other than string or `undefined`, or a body that is not `Uint8Array`. Use field-specific messages such as `options.maxBodyBytes must be a positive integer.` and `request.body must be a Uint8Array.` Use `Unsupported options field: <field>.` and `Unsupported request field: <field>.` for extra own properties.

    Process a well-typed request in this exact order:

    1. Require `request.method === "POST"`. Return status `405` with code `method_not_allowed` otherwise.
    2. Require `request.contentType` to match `/^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*)?$/i`. This accepts `application/json` with an optional `charset=utf-8` parameter and horizontal whitespace. Return status `415` with code `unsupported_content_type` for a missing value, another parameter, or another media type.
    3. Compare `request.body.byteLength` to `options.maxBodyBytes`. Return status `413` with code `body_too_large` before decoding or parsing when it exceeds the limit.
    4. Decode the bytes as UTF-8 with `new TextDecoder("utf-8", { fatal: true })`, then call `JSON.parse(...)`. Map invalid UTF-8 and JSON syntax failures to status `400` with code `invalid_json`.
    5. If the parsed value has an own string `text` field, measure `new TextEncoder().encode(text).byteLength`. Return status `413` with code `text_too_large` before authorization when it exceeds `options.maxTextBytes`. Let `options.authorize(...)` produce the normal schema error for missing or non-string text.
    6. Call `options.authorize(parsedValue)`. Map `SignedMessageValidationError`, `SignedMessageVerificationError`, and `SignedMessageAuthorizationError` to their existing status, code, message, and optional details. Propagate unexpected exceptions so programming and infrastructure failures remain visible.
    7. Copy `text`, `signer`, and `signature` into the existing frozen authenticated message snapshot. If `options.onAcceptedMessage` is a function, call it exactly once with that snapshot and await its return value before constructing the final accepted result. Do not invoke it for any rejection path.

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

    For a valid message without a configured accepted-message handler, resolve to the existing HTTP response values and frozen message snapshot:

        {
          status: 202,
          body: { status: "accepted", signer: message.signer },
          message
        }

    When `onAcceptedMessage` is configured, resolve only after it settles and add its exact return value as an own `handleSignedMessageResult` property:

        {
          status: 202,
          body: { status: "accepted", signer: message.signer },
          message,
          handleSignedMessageResult
        }

    Freeze the outer accepted result, its HTTP body, and the authenticated message snapshot. Preserve `handleSignedMessageResult` by reference; do not clone, transform, or recursively freeze an arbitrary host-owned value. If the callback returns `undefined`, include `handleSignedMessageResult` as an own property with value `undefined` so host code can distinguish a configured callback from the no-callback result shape.

    `message` is the trusted handoff value for implementation-specific logic. The HTTP adapter sends only `status` and `body` unless a higher layer deliberately defines another response. With no callback, repeated calls continue to resolve to equivalent acceptance results. With a callback, every successful call invokes it once; ingress does not cache or deduplicate callback execution.

    Because `handleSignedMessage(...)` is now `async`, option/request `TypeError`s, unexpected authorizer failures, synchronous callback throws, and callback promise rejections all reject the returned Promise. Do not map callback failures to a request rejection or return status `202` after a callback failure.

6. Add package runtime tests and a public declaration type test.

    Suggested test files:

        packages/messages/test/schema.test.js
        packages/messages/test/signature.test.js
        packages/messages/test/ingress.test.js
        packages/messages/test/ingress-types.test.ts
        packages/messages/tsconfig.type-test.json

    Update every existing `handleSignedMessage(...)` test call to await the returned Promise. Use `assert.rejects(...)` for invalid configuration, invalid request types, unexpected authorizer failures, and configured callback failures that previously used or would otherwise use synchronous throw assertions.

    Tests should cover:

    - accepts a valid signed text message from an authorized signer;
    - rejects invalid JSON and invalid body shape;
    - rejects empty or overlarge text;
    - rejects invalid Ethereum addresses and malformed signatures;
    - rejects signatures that do not recover to `signer`;
    - rejects valid signatures from signers outside the allowlist;
    - rejects with `TypeError` for malformed request/options containers, invalid request field types, a non-function authorizer, a non-function/non-`undefined` `onAcceptedMessage`, zero, negative, fractional, `NaN`, or infinite byte limits;
    - ignores inherited function and non-function `onAcceptedMessage` values instead of invoking or rejecting them;
    - accepts the exact supported content-type forms and rejects missing or unsupported forms with `415` and `unsupported_content_type`;
    - rejects non-`POST` methods with `405` and `method_not_allowed`;
    - maps invalid UTF-8 and JSON syntax to `400` and `invalid_json`;
    - returns the exact validated, frozen, authorized message on acceptance;
    - keeps the trusted `message` handoff separate from the HTTP response `body`;
    - rejects an overlarge body before decoding or JSON parsing and overlarge text before invoking an injected authorizer;
    - preserves structured validation, verification, and authorization statuses, codes, messages, and details;
    - propagates unexpected authorizer exceptions as Promise rejections;
    - freezes accepted and rejected result and body objects;
    - returns equivalent acceptance results for repeated calls with the same signed text when no callback is configured;
    - accepts separately signed identical text;
    - preserves the existing accepted result shape when `onAcceptedMessage` is omitted or explicitly `undefined`;
    - invokes a synchronous callback exactly once with the frozen authenticated message after authorization and exposes its exact return value as `handleSignedMessageResult`;
    - awaits an asynchronous callback before resolving and preserves its settled value as `handleSignedMessageResult`;
    - includes an own `handleSignedMessageResult` property when a configured callback returns `undefined`;
    - never invokes the callback for transport, parsing, validation, verification, or authorization rejection paths;
    - invokes the callback once per successful submission, including repeated valid submissions;
    - propagates synchronous callback throws and asynchronous callback rejections without returning an accepted result;
    - preserves the callback result by reference while keeping the outer accepted result frozen;
    - produces HTTP-shaped statuses suitable for a node endpoint.

    `packages/messages/test/ingress-types.test.ts` must import from the built `packages/messages/dist/index.js` entrypoint so it tests the emitted public declarations rather than source-internal types. Add compile-time assertions proving:

    - every accepted call permits reading `handleSignedMessageResult` directly as `Awaited<TResult> | undefined`, including through optional chaining; assigning the unchecked optional value to a required callback-result type is rejected;
    - after property-presence narrowing, a callback returning `{ cid: string }` exposes exactly `{ cid: string }`, not `{ cid: string } | undefined` or `unknown`;
    - a handler explicitly typed as `AcceptedSignedMessageHandler<Promise<{ cid: string }>>` exposes `{ cid: string }` after narrowing, matching runtime recursive awaiting rather than exposing `Promise<{ cid: string }>`;
    - a callback returning `undefined` exposes an optional property whose value type is `undefined`, before and after a presence check;
    - omitting `onAcceptedMessage`, setting it explicitly to `undefined`, and supplying a runtime-selected optional handler all use the same options and accepted-result interfaces;
    - the common rejection branch does not expose the handler-result property.

    Add `packages/messages/tsconfig.type-test.json` extending `packages/tsconfig.base.json`, with `noEmit: true`, `composite: false`, and only `test/ingress-types.test.ts` included. This keeps the compile-time fixture out of the package build output while using the same strict and `exactOptionalPropertyTypes` settings as the package.

7. Update documentation.

    Update `packages/messages/README.md` and, if needed, `packages/README.md` to document that `handleSignedMessage(...)` always returns a Promise, accepts one optional `onAcceptedMessage` function, awaits it after authorization, exposes its return value on the accepted result when configured, bypasses it for rejections, and propagates its failures. Explain direct access to the optional result property after checking acceptance, and how a presence check distinguishes callback omission from an explicit `undefined` result. Include one small configuration example with a placeholder action function. Do not document IPFS publication as implemented in this milestone.

8. Build and smoke-import.

    Commands:

        npm --prefix packages run build
        node --test packages/messages/test/*.test.js
        node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json
        node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedMessage, typeof m.handleSignedMessage))"

    Expected result: TypeScript build succeeds, all message runtime tests pass, the public declaration type test exits successfully, and the smoke import prints `function function`.

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
- An external HTTP adapter caps request bytes while reading, and the handler applies configured body and text limits before JSON parsing and signature verification.
- The handler contract fixes request and option field types, requires explicit positive byte limits, defines content-type and UTF-8 behavior, and maps every expected rejection to a stable status and code.
- `handleSignedMessage(...)` always returns a Promise, including when no accepted-message handler is configured.
- Omitting `onAcceptedMessage` or setting it to `undefined` produces the runtime callback-absent accepted shape with no own `handleSignedMessageResult` property.
- Inherited `onAcceptedMessage` values do not configure a callback; only an own options property can do so.
- A configured `onAcceptedMessage` receives the frozen authenticated message exactly once and only after successful authorization.
- `HandleSignedMessageOptions<TResult>` accepts omitted, present, and runtime-selected optional handlers without separate public option types.
- Every accepted result permits direct access to `handleSignedMessageResult` as `Awaited<TResult> | undefined` after narrowing `status === 202`.
- With `exactOptionalPropertyTypes` enabled, a presence check narrows `handleSignedMessageResult` to exactly `Awaited<TResult>`, including `undefined` only when it is part of the callback's settled return type.
- The handler awaits synchronous or asynchronous callback results and exposes the exact settled value separately from the ingress-owned HTTP `body`.
- A configured callback is never called for rejected ingress, and its throws or rejected promises propagate without an accepted result.
- Repeating the same valid request without a callback returns an equivalent acceptance result; repeating it with a callback invokes that callback once for each successful submission; separately signed identical text remains accepted.
- The HTTP-shaped helper accepts request data and returns status and JSON body values suitable for mounting in an external runtime adapter without importing that adapter into the kernel package.
- Package source dependencies resolve through hardened package-root exports.
- The package README documents exact text preservation, Internet-facing request-body and text limits, optional accepted-message handling, callback result/error semantics, and the boundary between message authentication and future onchain publication ordering.
- The focused milestone adds no dependency on `@oyaprotocol/ipfs` and no package-specific action registry.
- The emitted public declarations pass the compile-time single-interface inference and narrowing fixture under the package's strict TypeScript settings.

Required commands from the repository root:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json
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

The callback runs once per successful `handleSignedMessage(...)` invocation. Retrying the same request therefore runs the configured function again; this package deliberately does not cache or deduplicate host-owned behavior. Any configured function must define its own retry behavior appropriate to its side effect, while future onchain Logger events provide the public publication record and ordering.

Keep this focused change in `packages/messages`. Do not move behavior into or import from the existing `node/` or `agent/` implementations. If review rejects the callback API, revert only the generic type, option, async invocation, result field, and focused tests; the completed schema, signature, authorization, and synchronous ingress logic remain independently recoverable.

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

Draft configured accepted-message handling:

    const result = await handleSignedMessage(request, {
      authorize,
      maxBodyBytes: 65536,
      maxTextBytes: 8192,
      onAcceptedMessage: async (message) => {
        return await configuredAction(message);
      }
    });

    if (result.status === 202) {
      inspectConfiguredHandlerResult(result.handleSignedMessageResult);
    }

Draft rejection body:

    {
      "error": "Invalid signature.",
      "code": "invalid_signature"
    }

Publication-ordering note for docs:

    An EIP-191 signature authenticates the signer and exact `text`; it does not assign a publication time or order. Repeated valid submissions remain acceptable at this ingress boundary. The downstream publication flow will establish the public record by logging the published IPFS CID through the onchain Logger, whose block and log position identify when and in what order the message was recorded.

## Interfaces and Dependencies

Public package entrypoint:

- `@oyaprotocol/messages`

Target exported functions and types after the focused milestone:

- `validateSignedMessage(input)`
- `verifySignedMessage(input)`
- `createSignedMessageAuthorizer(allowedSigners)`
- `handleSignedMessage<TResult = unknown>(request, options: HandleSignedMessageOptions<TResult>)`, returning `Promise<HandleSignedMessageResult<TResult>>`
- `SignedMessageAuthorizer`
- `AcceptedSignedMessageHandler<TResult>`, receiving `Readonly<SignedMessageInput>` and returning `TResult | PromiseLike<TResult>`
- `SignedMessageInput`
- `SignedMessageValidationError`
- `SignedMessageVerificationError`
- `SignedMessageAuthorizationError`
- `HandleSignedMessageRequest`, with required `method: string`, `contentType: string | undefined`, and `body: Uint8Array`
- `HandleSignedMessageOptions<TResult = unknown>`, with required `authorize: SignedMessageAuthorizer`, `maxBodyBytes: number`, and `maxTextBytes: number`, plus optional `onAcceptedMessage: AcceptedSignedMessageHandler<TResult> | undefined`
- `HandleSignedMessageResult<TResult = unknown>`, containing one accepted branch with optional `handleSignedMessageResult?: Awaited<TResult>` and the shared status `400 | 401 | 403 | 405 | 413 | 415` structured rejection branch

Runtime dependency:

- `@noble/hashes` for Keccak-256 hashing.
- `@noble/curves` for secp256k1 public-key recovery.
- The runtime dependency surface uses these focused packages for EIP-191 signed-text verification and Ethereum address derivation.

Internal package dependency:

- `@oyaprotocol/utils` provides already-public shared validation helpers; add further shared helpers when multiple packages establish the shared requirement.
- This focused callback milestone does not add `@oyaprotocol/ipfs`, `@oyaprotocol/ethereum`, or another runtime dependency.

Configuration inputs:

- The host supplies signer allowlists through `createSignedMessageAuthorizer(...)` and passes the resulting function as `options.authorize`.
- The host supplies `maxBodyBytes` and `maxTextBytes` as explicit positive integer byte limits.
- The host may supply one function directly as `options.onAcceptedMessage`; the package does not resolve function names from JSON configuration or own an action registry.
