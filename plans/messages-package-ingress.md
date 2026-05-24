# Add Signed Text Message Ingress Package

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build `@oyaprotocol/messages` from a placeholder package into the first hardened message-ingress kernel for Oya nodes.

After this work, a node process should be able to accept a small HTTP JSON request from an authorized user, verify that the request contains a text message signed by the claimed Ethereum address, and receive a normalized accepted-message object that the node can enqueue or hand to its own implementation-specific logic. The message package will not decide what the text means. A node may later choose to publish the text to IPFS, trigger an Ethereum transaction, ignore it, or route it to an agent-specific policy engine, but those actions are outside this package.

The observable behavior after completion is:

1. a caller submits `POST /v1/messages`-style JSON with only `text`, `signer`, and `signature`;
2. `@oyaprotocol/messages` validates the body, recovers the signer according to Ethereum signed-message rules, checks the signer against an explicit allowlist, and returns a deterministic acceptance result;
3. malformed, unsigned, mis-signed, overlarge, or unauthorized messages produce structured rejection errors that a node can map to HTTP status codes.

The signed message is intentionally text-first. There is no protocol `version`, no `meta`, no chain ID, no commitment address, no Safe address, no proposal kind, no IPFS field, and no instruction schema in the wire message. The node's internal implementation owns all interpretation of the `text`.

## Progress

- [x] 2026-05-24: Reviewed `PLANS.md`, `packages/AGENTS.md`, current package docs, and the placeholder `packages/messages` implementation before drafting this plan.
- [x] 2026-05-24: Created this draft ExecPlan for user review before implementation.
- [ ] Incorporate user review feedback into this plan before writing package code.
- [ ] Implement the message schema, validation, Ethereum signature verification, allowlist authorization, and tests in `packages/messages`.
- [ ] Update package documentation and validation evidence after implementation.

## Surprises & Discoveries

- Observation: `@oyaprotocol/messages` is currently only a placeholder package shell.
  Evidence: `packages/messages/src/index.ts` exports `packageInfo` with `status: 'placeholder'`, and `packages/README.md` says `@oyaprotocol/messages` is still a placeholder.

- Observation: The hardened package area must not import legacy runtime code.
  Evidence: `packages/AGENTS.md` says existing code under `agent/`, `agent-library/`, `node/`, and `frontend/` is reference material only for production-kernel packages.

- Observation: Existing message ingress and publication logic in `agent/src/lib/` can inform the design but must not be reused by import.
  Evidence: `agent/src/lib/message-api.js`, `agent/src/lib/message-signing.js`, and `agent/src/lib/message-publication-api.js` already contain useful reference behavior for signed requests, HTTP status mapping, and publication flows, but package rules prohibit importing that code into `packages/messages`.

## Decision Log

- Decision: The v1 wire body contains only `text`, `signer`, and `signature`.
  Rationale: The user wants signed text messages without an overloaded envelope. The node should interpret text according to its own internal rules, not according to package-level commitment or transaction fields.
  Date/Author: 2026-05-24 / Codex.

- Decision: The signature scheme is Ethereum signed text, not a generic multi-scheme signature abstraction.
  Rationale: The user clarified that signatures will follow Ethereum signing standards. The package can still avoid Ethereum-domain fields in the message body while using Ethereum address recovery for authentication.
  Date/Author: 2026-05-24 / Codex.

- Decision: The signed payload is exactly the `text` string.
  Rationale: This keeps the protocol understandable to users and compatible with common wallet `personal_sign` / EIP-191 signed-message behavior. It also avoids hidden canonical JSON fields that would make the message look simple while signing something larger.
  Date/Author: 2026-05-24 / Codex.

- Decision: Implement built-in Ethereum signature verification in `@oyaprotocol/messages` using a package dependency such as `viem`.
  Rationale: A message-ingress package should be able to verify messages by itself. Requiring every node to inject its own recovery function would leave the core package incomplete. `viem` provides audited Ethereum address and signed-message helpers already familiar in the repository's JavaScript ecosystem.
  Date/Author: 2026-05-24 / Codex.

- Decision: The package may expose server-agnostic HTTP helper functions, but it must not start a server or own routing.
  Rationale: The goal is Internet ingress, but `packages/` must avoid app wiring, daemon startup, environment loading, and repo-specific process behavior. A node daemon can mount the package helper behind `POST /v1/messages`.
  Date/Author: 2026-05-24 / Codex.

- Decision: No cryptographic freshness or replay protection is part of v1.
  Rationale: With no timestamp, nonce, message ID, audience, or domain field, the same signed text remains valid anywhere the signer is authorized. The package can expose deterministic message-key helpers for dedupe, but durable replay policy belongs to the node.
  Date/Author: 2026-05-24 / Codex.

## Outcomes & Retrospective

This section is intentionally empty until implementation begins. After each milestone, update it with what changed, which validation commands were run, and whether the resulting behavior matched this plan.

## Context and Orientation

The hardened package workspace lives under `packages/`.

The relevant files at the start of this plan are:

- `packages/messages/src/index.ts`: currently exports only placeholder package metadata.
- `packages/messages/README.md`: currently says the package is a placeholder shell.
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
- Message key: a deterministic package-computed identifier for dedupe, likely derived from normalized signer, signature, and text. It is not sent by the caller and is not replay protection by itself.

The intended HTTP JSON body is:

    {
      "text": "Please withdraw 100 USDC.",
      "signer": "0x1111111111111111111111111111111111111111",
      "signature": "0x..."
    }

## Plan of Work

First, replace the placeholder export with a small public API centered on signed text message ingress. Keep the package focused on message shape, validation, signature verification, allowlist authorization, deterministic key creation, and HTTP-friendly result objects.

Second, add package-local TypeScript modules under `packages/messages/src/` instead of putting all behavior in `index.ts`. A likely source layout is:

- `schema.ts` for the wire body, normalized accepted message, and validation helpers.
- `ethereum-signature.ts` for Ethereum address normalization and EIP-191 text-signature verification.
- `authorization.ts` for allowlist normalization and membership checks.
- `ingress.ts` for a server-agnostic request/body handler that returns HTTP-shaped status and JSON bodies without starting a server.
- `errors.ts` for structured error classes or error result shapes that keep status-code mapping consistent.
- `index.ts` for package-root exports only.

Third, add focused tests under `packages/messages/test/`. Tests should use locally generated or fixed Ethereum signed-message vectors. If a deterministic private key is used in tests, it must be a public test-only key documented in the test file, never a secret.

Fourth, update `packages/messages/README.md` so consumers understand the minimal wire protocol, the fact that text is opaque, the replay limitation, and how a node can mount the helper behind `POST /v1/messages`.

Do not modify `node/` or `agent/` in this first package milestone unless the user explicitly asks for integration. This plan is to make the package capable of receiving and verifying messages; daemon adoption can be a follow-on plan.

## Concrete Steps

Work from the repository root unless a command says otherwise.

1. Review the placeholder package and package workspace.

    Command:

        sed -n '1,160p' packages/messages/src/index.ts
        sed -n '1,160p' packages/messages/package.json
        sed -n '1,120p' packages/AGENTS.md

    Expected result: confirm the package is a placeholder and that package-local instructions still prohibit importing legacy runtime code.

2. Add the Ethereum signature dependency to `packages/messages/package.json`.

    Proposed dependency:

        "viem": "<current compatible version>"

    Use `npm --prefix packages install` after editing package metadata so `packages/package-lock.json` records the workspace dependency. If the environment blocks registry access, request normal network approval rather than vendoring code or copying dependencies from another workspace.

3. Implement strict schema validation.

    Add public functions with names close to:

        normalizeSignedTextMessage(input, options)
        createSignedTextMessageKey(message)

    The validator should require:

    - `text` is a non-empty string after no implicit semantic parsing.
    - `signer` is a valid Ethereum address.
    - `signature` is a 0x-prefixed Ethereum signature hex string.
    - unknown top-level fields are rejected or ignored according to an explicit package decision recorded in this plan before implementation. The recommended choice is to reject unknown top-level fields for v1 auditability.
    - maximum text byte length and maximum body byte length are configurable by the node.

4. Implement Ethereum signed-text verification.

    Add a public function with a name close to:

        verifySignedTextMessage(input, options)

    The function should:

    - normalize the body;
    - recover the Ethereum address from the signature over exactly `text`;
    - compare the recovered address to `signer` case-insensitively after address normalization;
    - check the normalized signer against the supplied allowlist;
    - return a normalized accepted message with `text`, normalized signer, original signature, and message key.

5. Implement HTTP-shaped ingress helper.

    Add a public helper with a name close to:

        handleSignedTextMessageIngress(request, options)

    Keep it server-agnostic. It may accept method, headers, and already-read body text or bytes, then return:

        { status: 202, body: { status: "accepted", signer, messageKey } }

    for valid messages. It should return structured rejection bodies for:

    - wrong method, if method is supplied;
    - unsupported content type;
    - body too large;
    - invalid JSON;
    - invalid shape;
    - invalid signature;
    - unauthorized signer.

    The package must not call `http.createServer(...)`, read environment variables, write storage, enqueue messages, publish to IPFS, or trigger Ethereum transactions.

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
    - keeps the same deterministic message key for the same `(text, signer, signature)`;
    - produces HTTP-shaped statuses suitable for a node endpoint.

7. Update documentation.

    Update `packages/messages/README.md` and, if needed, `packages/README.md` to say `@oyaprotocol/messages` now exposes functional signed text ingress APIs.

8. Build and smoke-import.

    Commands:

        npm --prefix packages run build
        node --test packages/messages/test/*.test.js
        node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedTextMessage, typeof m.handleSignedTextMessageIngress))"

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
- The HTTP-shaped helper can be mounted by a node process without the package owning server startup.
- No package source imports from `agent/`, `agent-library/`, `node/`, or `frontend/`.
- The package README documents the replay limitation: without a timestamp, nonce, audience, or domain field, signatures are valid indefinitely anywhere the signer is authorized.

Required commands from the repository root:

    npm --prefix packages run build
    node --test packages/messages/test/*.test.js
    node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(typeof m.verifySignedTextMessage, typeof m.handleSignedTextMessageIngress))"

Broader package regression commands:

    node --test packages/utils/test/*.js
    node --test packages/ipfs/test/*.js
    node --test packages/ethereum/test/*.js

No RPC endpoint, private key, IPFS daemon, or production secret should be required for validation. Tests that need a signer should use deterministic public test-only keys or static signature fixtures.

## Idempotence and Recovery

This work is package-local and should be safe to retry.

If dependency installation fails because network access is unavailable, leave the source changes uncommitted and record the missing install command in `Outcomes & Retrospective`. Do not copy dependencies from another package's `node_modules`.

If a chosen dependency is rejected during review, revert only the dependency and the package-local verification adapter, then replace it with either a smaller Ethereum signature dependency or an injected verifier interface. The schema, ingress helper, tests around malformed input, and docs can remain mostly intact.

If the package API names change during review, update `packages/messages/README.md`, tests, and smoke-import commands in this plan in the same change. The package root `exports` surface should remain the only public import path.

If later node integration needs storage, queues, rate limiting, IPFS publication, or Ethereum transaction execution, add that in `node/` or another explicit package plan. Do not fold app runtime behavior into `@oyaprotocol/messages`.

## Artifacts and Notes

Current placeholder evidence:

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
      "signer": "0x1111111111111111111111111111111111111111",
      "messageKey": "..."
    }

Draft rejection body:

    {
      "error": "Invalid signature.",
      "code": "invalid_signature"
    }

Replay note for docs:

    Because v1 signs only text and carries no timestamp, nonce, audience, or domain field, a valid signature can be replayed. Nodes should treat `messageKey` as an idempotency hint and apply their own durable dedupe and authorization policy.

## Interfaces and Dependencies

Public package entrypoint:

- `@oyaprotocol/messages`

Planned exported functions and types:

- `normalizeSignedTextMessage(input, options)`
- `verifySignedTextMessage(input, options)`
- `createSignedTextMessageKey(message)`
- `handleSignedTextMessageIngress(request, options)`
- `SignedTextMessageInput`
- `SignedTextMessage`
- `AcceptedSignedTextMessage`
- `SignedTextMessageIngressOptions`
- `SignedTextMessageIngressResult`
- structured error types or error result codes for invalid shape, invalid signature, unauthorized signer, and body/content-type failures

Runtime dependency:

- Ethereum signed-message recovery helper, proposed as `viem`. The package should use it only for address normalization and EIP-191 signed text recovery or verification.

Internal package dependency:

- `@oyaprotocol/utils` may be used for already-public validation helpers if they fit. Do not add shared helpers to `utils` unless duplication across packages becomes real.

External services:

- None. Verification is local and deterministic.

Environment variables:

- None. The caller supplies allowlists and limits as explicit options.

Non-goals for this package:

- no HTTP server process;
- no persistent queue;
- no rate limiter;
- no IPFS publishing;
- no Ethereum transaction execution;
- no interpretation of the text;
- no commitment, chain, Safe, proposal, or agent-specific fields in the wire body;
- no imports from legacy runtime directories.
