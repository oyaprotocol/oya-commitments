# Oya Node Signed Proposal Publication

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Add a first-stage Oya node flow where an owner, typically the agent signer, can sign an Optimistic Governor proposal bundle plus explanation, send that signed request to a separate publication service, and receive back a pinned IPFS CID for an immutable publication record. The Oya node will not decide whether the proposal is correct and will not submit anything onchain in this stage. Its job is narrower:

- verify that the request was signed by an allowed signer
- publish the signed proposal package to IPFS as canonical JSON
- pin the resulting CID
- return a stable publication record with timestamps so other Safe owners and outside observers can inspect and verify what the signer approved

After this change, the observable behavior should be:

1. A signer can create a signed proposal publication request using the same signer material the agent already uses.
2. The Oya node accepts that request over HTTP only when the EIP-191 signature is valid and the signer is allowlisted for that node.
3. The node publishes a JSON artifact that includes the proposal data, explanation, signature, canonical signed payload, signer timestamp, and node publication timestamps.
4. The node pins the CID and returns the same CID on safe retries of the same signed request instead of creating duplicate publications.
5. Another owner or observer can fetch the artifact from IPFS and independently verify the signature against the archived canonical payload.

Out of scope for this ExecPlan:

- judging whether the proposal bundle is correct
- proposing the bundle onchain
- collecting fees
- multisigner approval aggregation beyond the single publishing signer
- clustering or multi-instance consensus between multiple Oya nodes

## Progress

- [x] 2026-03-30: Audited `PLANS.md`, `agent/AGENTS.md`, and the existing signed-message, IPFS, signer, and smoke-test infrastructure relevant to a publication-only Oya node.
- [x] 2026-03-30: Wrote this standalone ExecPlan in `plans/oya-node-signed-proposal-publication.md` for review before implementation.
- [x] 2026-03-30: Confirmed the standalone-process model and explicit signer-allowlist authorization model with the user.
- [x] 2026-03-30: Implemented shared canonical JSON, reusable signed-request auth helpers, signed proposal schema helpers, a durable publication store, and the standalone publication API under `agent/src/lib/`.
- [x] 2026-03-30: Added separate-process startup, signed-send, verification, and runtime-resolution helpers under `agent/scripts/`.
- [x] 2026-03-30: Added the `signed-proposal-publish-smoke` validation module under `agent-library/agents/`.
- [x] 2026-03-30: Updated `agent/README.md` to document the new proposal publication node, config, request format, retry semantics, and verification helper.
- [x] 2026-03-30: Validated the new flow with targeted Node tests, message API regression tests, a smoke module run, and CLI dry-run checks.
- [x] 2026-03-30: Hardened `send-signed-proposal` target resolution so disabled or absent `proposalPublishApi` config no longer silently falls back to `127.0.0.1:9890`, and added a regression covering the disabled-module case plus explicit host/port override behavior.
- [x] 2026-03-30: Serialized publication-store operations per state file, switched temp writes to collision-proof filenames, and added direct store regressions covering concurrent distinct-key writes plus same-key conflict handling.
- [x] 2026-03-30: Hardened recovery semantics so unpublished pending records can be retried after the auth age window, including refreshed signatures for the same logical proposal before any IPFS add succeeds, and moved `publishedAtMs` stamping from request receipt to the actual add attempt that succeeds.
- [x] 2026-03-30: Tightened artifact verification so the verifier now requires `signedProposal.signedAtMs` to match the signed envelope timestamp and returns the signed envelope timestamp as the verified `signedAtMs`.
- [x] 2026-03-30: Expanded the store dedupe key from `signer + requestId` to `signer + chainId + requestId` with backward-compatible record normalization, and tightened explicit `--url` resolution so unresolved module chain IDs fail fast with actionable guidance.
- [x] 2026-03-30: Added a per-publication keyed publish lock so concurrent duplicate requests cannot race into multiple IPFS adds, and enabled an intentional multi-chain server mode where node startup may leave `runtimeConfig.chainId` unset while send-side signing remains chain-bound.

## Surprises & Discoveries

- Observation: The shared EIP-191 verification logic could be cleanly separated from the message queue API, and doing so removed duplication instead of introducing a second custom verifier.
  Evidence: the implementation added `agent/src/lib/signed-request-auth.js` and `agent/src/lib/http-api.js`, then updated `agent/src/lib/message-api.js` to use those helpers without changing its external behavior.

- Observation: Publishing and pinning had to be split into two steps for the new node because inline "add then pin" does not preserve enough recovery information when pinning fails after a successful add.
  Evidence: `agent/src/lib/proposal-publication-api.js` now calls `publishIpfsContent(..., { pin: false })`, persists the resulting CID, and then calls `pinIpfsCid(...)` separately so retries can reuse the original CID.

- Observation: Existing agents already treat "signed request archived to IPFS and referenced later by CID" as an important operator-facing pattern, so the new node fit a known workflow instead of inventing a new review model.
  Evidence: `agent-library/agents/fast-withdraw/agent.js`, `agent-library/agents/erc1155-swap-fast-withdraw/agent.js`, and `agent-library/agents/polymarket-intent-trader/agent.js` already publish signed request artifacts to IPFS and later reference the resulting CIDs.

- Observation: The shared signer stack already supported more than raw private keys, so the send helper could keep parity with the rest of the agent tooling instead of forcing a separate key path.
  Evidence: `agent/scripts/send-signed-proposal.mjs` accepts `--private-key` / `PROPOSAL_PUBLISH_SIGNER_PRIVATE_KEY` but otherwise falls back to `createSignerClient(...)` with the existing `SIGNER_TYPE`-based signer configuration.

- Observation: Local listener tests in this Codex environment require escalated execution even when they only bind to `127.0.0.1`.
  Evidence: `node agent/scripts/test-proposal-publication-api.mjs`, `node agent-library/agents/signed-proposal-publish-smoke/test-signed-proposal-publish-smoke-agent.mjs`, `node agent/scripts/test-message-api.mjs`, and `node agent/scripts/test-message-api-signature-auth.mjs` required escalation approval before they could bind their local HTTP servers.

- Observation: Proposal-publication target-resolution tests needed `requireSignerAllowlist: false` in some temporary fixtures because those tests focus on host/port/chainId resolution rather than API auth.
  Evidence: `agent/scripts/test-send-signed-proposal-config.mjs` sets `proposalPublishApi.requireSignerAllowlist` to `false` in generated fixture modules that do not define `signerAllowlist`.

## Decision Log

- Decision: Build the Oya node as a standalone publication API rather than extending the existing inbound message API.
  Rationale: The existing message API is queue-oriented and requires an inbox. The Oya node needs different behavior: validate, publish, pin, and return publication metadata immediately. Keeping it separate also leaves a clean path for future review, fee, and onchain proposal stages.
  Date/Author: 2026-03-30 / Codex.

- Decision: Keep v1 signer authorization to "valid signature plus explicit allowlist membership" instead of adding an onchain Safe-owner lookup requirement.
  Rationale: This first stage is publication-only. It should remain usable without chain reads or owner-order assumptions. The published artifact will still carry `commitmentSafe`, `ogModule`, and signer address so observers can compare signer identity against onchain Safe ownership if they want to.
  Date/Author: 2026-03-30 / Codex.

- Decision: Use a dedicated signed proposal payload schema instead of overloading the existing signed message payload schema.
  Rationale: Proposal publication has different required fields and stronger structural expectations than generic user messages. A dedicated schema keeps verification clear and avoids optional-field sprawl in `buildSignedMessagePayload(...)`.
  Date/Author: 2026-03-30 / Codex.

- Decision: The published IPFS artifact will contain both the signer-authenticated payload and node-authored publication metadata.
  Rationale: Observers need the raw signed payload and signature to verify signer intent, and they also need node-side timestamps showing when the publication service received and archived the request.
  Date/Author: 2026-03-30 / Codex.

- Decision: Add a file-backed publication ledger keyed by `(signer, requestId)` so retries return the original publication record instead of creating duplicate timestamped artifacts.
  Rationale: IPFS content addressing alone is not enough once the artifact contains node-side timestamps. Durable local idempotency is needed for stable retries and for crash recovery after add-before-pin partial failures.
  Date/Author: 2026-03-30 / Codex.

- Decision: Provide both a reusable JS client and a CLI helper for sending signed proposal publication requests, and also provide a read-only verification helper for observers.
  Rationale: The agent runtime should be able to call the node programmatically, operators need a manual test path, and reviewers need a simple way to prove an archived signature is valid.
  Date/Author: 2026-03-30 / Codex.

## Outcomes & Retrospective

The publication-only Oya node is implemented as a fully separate process from the main agent runtime. The final shape matches the reviewed direction:

- `agent/src/lib/proposal-publication-api.js` serves `GET /healthz` and `POST /v1/proposals/publish`
- `agent/src/lib/proposal-publication-store.js` keeps a durable JSON ledger keyed by `(signer, requestId)`
- `agent/src/lib/signed-proposal.js` defines the canonical proposal envelope, signed payload, artifact format, and verifier
- `agent/scripts/start-proposal-publish-node.mjs` starts the standalone node from module config
- `agent/scripts/send-signed-proposal.mjs` signs and submits publication requests
- `agent/scripts/verify-signed-proposal-artifact.mjs` verifies archived artifacts

The node now enforces the intended v1 trust boundary:

- authorization is valid EIP-191 signature plus optional explicit signer allowlist plus optional bearer gate
- no onchain Safe-owner lookup is required
- the published artifact preserves both signer-authenticated content and node-authored timestamps
- exact duplicate retries return the original CID instead of creating a second timestamped artifact
- add-succeeded / pin-failed partial failures recover by reusing the stored CID and retrying only the pin step

The largest design choice that held up in implementation was keeping publication outside the message queue API and outside the main agent loop. That leaves the later "review / decide / fee / propose" stage room to grow without distorting the archival format or existing agent runtime behavior.

## Context and Orientation

The relevant shared signing helper today is `agent/src/lib/message-signing.js`. It builds a canonical JSON string for signed inbound user messages. That schema is message-specific: it expects fields such as `text`, `command`, `args`, and `metadata`.

The relevant shared verification surface today is `agent/src/lib/message-api.js`. It exposes `createMessageApiServer(...)`, reads JSON bodies, verifies EIP-191 signatures with `recoverMessageAddress(...)`, enforces signer allowlists, and depends on a `message-inbox` so accepted messages can be queued. That coupling is why the Oya node should not be bolted onto the same endpoint.

The relevant shared IPFS helper is `agent/src/lib/ipfs.js`. It already canonicalizes JSON, publishes to a Kubo-compatible `/api/v0/add` endpoint, then pins with `/api/v0/pin/add`. This is the right transport layer for the node's publication job.

The relevant shared signer helper is `agent/src/lib/signer.js`. It returns `{ account, walletClient }` for all supported signer modes. The future signed proposal sender should use `walletClient.signMessage(...)` where possible so the flow works for env keys, keystores, keychains, vault-backed keys, and signer RPCs.

The repository already contains agent-local request-archive patterns that prove the user-facing value of IPFS-published signed artifacts:

- `agent-library/agents/fast-withdraw/agent.js` builds a signed request archive artifact, publishes it to IPFS, and later refers to the resulting CID in a reimbursement explanation.
- `agent-library/agents/erc1155-swap-fast-withdraw/agent.js` does the same for swap withdrawal requests.
- `agent-library/agents/polymarket-intent-trader/agent.js` archives signed intents before later execution/reimbursement stages.

These precedents matter because the new Oya node flow should follow the same operator model: human-readable explanation plus structured signed payload archived by CID, not opaque logs or database-only state.

The likely implementation will touch shared files under `agent/src/lib/`, add dedicated helper scripts under `agent/scripts/`, update `agent/README.md`, and add one focused smoke module under `agent-library/agents/` so the new shared infrastructure has a module-level validation target.

## Plan of Work

First, factor out the shared primitives needed by both the existing message API and the new Oya node so the new flow does not duplicate canonicalization, request parsing, or signed-auth verification. The goal is not a giant framework; it is a small set of utilities that make the proposal-publication path explicit and keep the existing message API working unchanged from the outside.

Second, add a dedicated signed proposal publication schema. The signer-authenticated envelope should represent exactly what the signer intends observers to see later:

- `version`: `oya-signed-proposal-v1`
- `kind`: `og_proposal_publication`
- `address`: signer address
- `chainId`: target chain id
- `timestampMs`: signer timestamp in milliseconds
- `requestId`: unique id scoped to the signer
- `commitmentSafe`: Safe address this proposal concerns
- `ogModule`: Optimistic Governor module address
- `transactions`: array matching the normalized OG transaction shape used by `agent/src/lib/tx.js`, with JSON-serializable fields `to`, `value`, `data`, and `operation`
- `explanation`: the human-readable explanation string intended for co-owners and observers
- `metadata`: optional structured metadata for module name, commitment label, upstream signal references, or future audit context
- `deadline`: optional expiry timestamp in milliseconds for stale publication requests

The node-authored IPFS artifact should wrap that signed envelope and preserve the exact canonical signed string used for EIP-191 signing. The artifact shape should be:

- `version`: `oya-proposal-publication-record-v1`
- `publication`: `{ receivedAtMs, publishedAtMs, signerAllowlistMode, nodeName? }`
- `signedProposal`: `{ authType, signer, signature, signedAtMs, canonicalMessage, envelope }`

Third, add the standalone Oya node API. It should listen on its own host and port, expose `GET /healthz`, and accept `POST /v1/proposals/publish`. On each request it should:

1. read and validate the JSON body
2. verify optional bearer auth if configured
3. rebuild the canonical signed proposal payload from the submitted fields
4. recover the signer from the EIP-191 signature
5. enforce signer allowlist membership
6. enforce request freshness and body-size limits
7. consult the local publication ledger for idempotency
8. if new, build the publication artifact and publish it to IPFS
9. pin the CID
10. persist the resulting publication record
11. return JSON containing `status`, `requestId`, `signer`, `cid`, `uri`, `publishedAtMs`, and `pinned`

Fourth, add persistence and recovery. The node needs a durable publication ledger because the IPFS artifact contains node timestamps. Without a ledger, the same signed request could produce multiple timestamped artifacts and multiple CIDs. The ledger should live under a configurable JSON file path, defaulting to something under `agent/.state/`. Each entry should store:

- signer
- requestId
- signature
- canonical message hash or exact canonical message
- `receivedAtMs`
- `publishedAtMs`
- `cid`
- `uri`
- `pinned`
- last pin attempt result if pinning previously failed

This ledger should distinguish between:

- exact duplicate retry: return the existing record
- same `(signer, requestId)` with different signature or different canonical payload: reject with `409`
- add succeeded but pin confirmation failed: retry pinning the existing CID instead of building a new artifact

Fifth, add a sender path and an observer path. The sender path should include a reusable shared client plus a CLI helper that can sign proposal publication requests using the repo's existing signer stack. The observer path should include a verification helper that takes a local JSON file or fetched artifact, rebuilds the canonical message, recovers the signer, and confirms it matches the archived signer field.

Sixth, add documentation and a minimal smoke scenario. The docs should explain how to start the node, how an agent or operator sends a signed proposal publication request, what the artifact contains, how retries behave, and how another owner verifies the artifact. A minimal smoke module should prove the shared infrastructure works end to end without forcing a production agent module to adopt the flow immediately.

## Concrete Steps

1. Completed shared canonicalization and signed-request refactors under `agent/src/lib/`.

   Added:

   - `agent/src/lib/canonical-json.js`
   - `agent/src/lib/http-api.js`
   - `agent/src/lib/signed-request-auth.js`
   - `agent/src/lib/signed-proposal.js`

   Refactored:

   - `agent/src/lib/message-signing.js` now uses the shared canonical JSON helper
   - `agent/src/lib/ipfs.js` now uses the shared canonical JSON helper
   - `agent/src/lib/message-api.js` now uses the shared request-body and signed-auth helpers

2. Completed the standalone publication API and durable ledger.

   Added:

   - `agent/src/lib/proposal-publication-store.js`
   - `agent/src/lib/proposal-publication-api.js`

   Implemented behavior:

   - `GET /healthz` returns `{ ok: true }`
   - `POST /v1/proposals/publish` accepts JSON only
   - body size defaults to `65536` bytes
   - fresh accepted publications return `202` with `status: "published"`
   - identical retries return `200` with `status: "duplicate"` and the original CID
   - same signer plus request id but different signed contents return `409`
   - add-before-pin partial failures persist the CID and retry only the pin step on the next submission

3. Completed config support for the new `proposalPublishApi` object.

   Implemented in:

   - `agent/src/lib/config.js`
   - `agent/src/lib/agent-config.js`

   Supported config fields:

   - `enabled`
   - `host`
   - `port`
   - `requireSignerAllowlist`
   - `signerAllowlist`
   - `signatureMaxAgeSeconds`
   - `maxBodyBytes`
   - `stateFile`
   - `nodeName`

   Secret bearer tokens remain env-only via `PROPOSAL_PUBLISH_API_KEYS_JSON`.

4. Completed sender, verifier, and startup scripts under `agent/scripts/`.

   Added:

   - `agent/scripts/lib/proposal-publish-runtime.mjs`
   - `agent/scripts/start-proposal-publish-node.mjs`
   - `agent/scripts/send-signed-proposal.mjs`
   - `agent/scripts/verify-signed-proposal-artifact.mjs`

   `send-signed-proposal.mjs` supports:

   - `--module=<agent>`
   - `--chain-id=<id>` when not inferable from module config
   - `--url=<base-url>` or host/port/scheme overrides
   - `--request-id=<id>`
   - `--safe=<address>`
   - `--og-module=<address>`
   - `--transactions-json=<json>`
   - `--explanation=<text>` or `--explanation-file=<path>`
   - `--metadata-json=<json>`
   - `--deadline-ms=<ms>`
   - `--timestamp-ms=<ms>`
   - `--timeout-ms=<ms>`
   - `--bearer-token=<token>`
   - `--private-key=<hex>`
   - `--dry-run`

5. Completed targeted tests under `agent/scripts/`.

   Added:

   - `agent/scripts/test-proposal-publication-api.mjs`
   - `agent/scripts/test-send-signed-proposal-config.mjs`
   - `agent/scripts/test-verify-signed-proposal-artifact.mjs`

   `test-proposal-publication-api.mjs` now covers:

   - valid signed publish request
   - missing bearer token when bearer gating is configured
   - tampered explanation with a stale signature
   - non-allowlisted signer
   - expired signed request
   - exact duplicate retry returning the original CID
   - conflicting duplicate request id returning `409`
   - add succeeded but pin initially failed, followed by a retry that reused the same CID and completed pinning

6. Completed a smoke validation target under `agent-library/agents/`.

   Added module:

   - `agent-library/agents/signed-proposal-publish-smoke/`

   Contents:

   - `agent.js`
   - `config.json`
   - `commitment.txt`
   - `harness.mjs`
   - `test-signed-proposal-publish-smoke-agent.mjs`

   This module exists to satisfy the repository rule that shared `agent/` changes must be validated through at least one affected module simulation.

7. Completed documentation updates.

   Updated:

   - `agent/README.md`

   The README now covers:

   - what the publication-only node does and does not do
   - required config and env vars
   - example signed request body
   - example `send-signed-proposal.mjs` command
   - retry semantics and duplicate handling
   - artifact verification after fetching from IPFS

## Validation and Acceptance

Acceptance requirements were met by the implemented tests and smoke runs:

- a valid signed proposal publication request is accepted and returns a pinned IPFS CID
- the published artifact contains the proposal bundle, explanation, signer, signature, canonical signed payload, signer timestamp, and node publication timestamps
- retries of the same signed request return the original publication record instead of creating a second CID
- tampering with the proposal data or explanation after signing causes the node to reject the request
- a non-allowlisted signer is rejected
- an observer can run a verification command against the artifact and recover the archived signer successfully

Validation commands actually run from repo root:

- `node agent/scripts/test-proposal-publication-api.mjs`
- `node agent/scripts/test-proposal-publication-store.mjs`
- `node agent/scripts/test-send-signed-proposal-config.mjs`
- `node agent/scripts/test-verify-signed-proposal-artifact.mjs`
- `node agent/scripts/test-ipfs-tooling.mjs`
- `node agent-library/agents/signed-proposal-publish-smoke/test-signed-proposal-publish-smoke-agent.mjs`
- `node agent/scripts/test-message-api-signature-auth.mjs`
- `node agent/scripts/test-message-api.mjs`
- `node agent/scripts/validate-agent.mjs --module=signed-proposal-publish-smoke`
- `node agent/scripts/start-proposal-publish-node.mjs --module=signed-proposal-publish-smoke --dry-run`
- `node agent/scripts/send-signed-proposal.mjs --module=signed-proposal-publish-smoke --private-key=0x1111111111111111111111111111111111111111111111111111111111111111 --safe=0x2222222222222222222222222222222222222222 --og-module=0x3333333333333333333333333333333333333333 --transactions-json='[{"to":"0x4444444444444444444444444444444444444444","value":"0","data":"0x1234","operation":0}]' --explanation='dry run publication' --dry-run`

Notes:

- the local-listener HTTP tests required escalation in this environment because they bind to `127.0.0.1`
- the message API regression tests were rerun because the shared signed-auth path was refactored

## Idempotence and Recovery

Publishing the same signed request twice must be safe. The node should treat `(signer, requestId)` as the external idempotency key and compare the canonical signed payload plus signature to decide whether a retry is identical or conflicting.

The local publication ledger must be durable across restarts. A JSON state file is sufficient for v1 if writes are atomic and the format is documented. If the process crashes after IPFS add succeeds but before pin succeeds, the recovery path should:

1. reload the stored record on restart
2. detect that a CID already exists for that `(signer, requestId)`
3. skip rebuilding a new artifact
4. call `pinIpfsCid(...)` for the stored CID
5. mark the record pinned once pin succeeds

If a publish attempt fails before a CID is returned, the request can be retried safely because no publication record has been committed yet. If the ledger is corrupted or missing, the node should fail closed and require operator repair rather than silently creating a second timestamped publication for the same signed request.

This v1 design assumes one node process writes a given ledger file. Cross-process or multi-host coordination is out of scope.

## Artifacts and Notes

Representative request body shape:

    {
      "chainId": 11155111,
      "requestId": "proposal-2026-03-30-001",
      "commitmentSafe": "0x1234...",
      "ogModule": "0xabcd...",
      "transactions": [
        {
          "to": "0xfeed...",
          "value": "0",
          "data": "0xa9059cbb...",
          "operation": 0
        }
      ],
      "explanation": "Transfer 100 USDC back to the depositor after the testing window closes.",
      "metadata": {
        "module": "example-agent",
        "reason": "testing-window-close"
      },
      "auth": {
        "type": "eip191",
        "address": "0xowner...",
        "timestampMs": 1774897200000,
        "signature": "0x..."
      }
    }

Representative success response shape:

    {
      "status": "published",
      "requestId": "proposal-2026-03-30-001",
      "signer": "0xowner...",
      "cid": "bafy...",
      "uri": "ipfs://bafy...",
      "publishedAtMs": 1774897204321,
      "pinned": true
    }

Representative artifact outline:

    {
      "version": "oya-proposal-publication-record-v1",
      "publication": {
        "receivedAtMs": 1774897201234,
        "publishedAtMs": 1774897204321,
        "signerAllowlistMode": "explicit"
      },
      "signedProposal": {
        "authType": "eip191",
        "signer": "0xowner...",
        "signature": "0x...",
        "signedAtMs": 1774897200000,
        "canonicalMessage": "{\"address\":\"0xowner...\",...}",
        "envelope": {
          "version": "oya-signed-proposal-v1",
          "kind": "og_proposal_publication",
          "chainId": 11155111,
          "requestId": "proposal-2026-03-30-001",
          "commitmentSafe": "0x1234...",
          "ogModule": "0xabcd...",
          "transactions": [...],
          "explanation": "...",
          "metadata": {...},
          "deadline": null
        }
      }
    }

## Interfaces and Dependencies

Primary files changed:

- `agent/src/lib/message-signing.js`
- `agent/src/lib/message-api.js`
- `agent/src/lib/ipfs.js`
- `agent/src/lib/config.js`
- `agent/src/lib/agent-config.js`
- `agent/src/lib/canonical-json.js`
- `agent/src/lib/http-api.js`
- `agent/src/lib/signed-request-auth.js`
- `agent/src/lib/signed-proposal.js`
- `agent/src/lib/proposal-publication-api.js`
- `agent/src/lib/proposal-publication-store.js`
- `agent/scripts/lib/proposal-publish-runtime.mjs`
- `agent/scripts/start-proposal-publish-node.mjs`
- `agent/scripts/send-signed-proposal.mjs`
- `agent/scripts/verify-signed-proposal-artifact.mjs`
- `agent/scripts/test-proposal-publication-api.mjs`
- `agent/scripts/test-send-signed-proposal-config.mjs`
- `agent/scripts/test-verify-signed-proposal-artifact.mjs`
- `agent/README.md`
- `agent-library/agents/signed-proposal-publish-smoke/`

Existing reusable dependencies:

- `recoverMessageAddress` from `viem` for EIP-191 verification
- `publishIpfsContent(...)` and `pinIpfsCid(...)` from `agent/src/lib/ipfs.js`
- `createSignerClient(...)` from `agent/src/lib/signer.js`
- `privateKeyToAccount` from `viem/accounts` for explicit private-key CLI signing

Implemented config and env surfaces:

- module config `proposalPublishApi.enabled`
- module config `proposalPublishApi.host`
- module config `proposalPublishApi.port`
- module config `proposalPublishApi.requireSignerAllowlist`
- module config `proposalPublishApi.signerAllowlist`
- module config `proposalPublishApi.signatureMaxAgeSeconds`
- module config `proposalPublishApi.maxBodyBytes`
- module config `proposalPublishApi.stateFile`
- module config `proposalPublishApi.nodeName`
- env `PROPOSAL_PUBLISH_API_KEYS_JSON` for optional bearer auth
- env `PROPOSAL_PUBLISH_SIGNER_PRIVATE_KEY` for the send helper
- env `PROPOSAL_PUBLISH_BEARER_TOKEN` for the send helper
- env `IPFS_HEADERS_JSON` when the IPFS API requires auth headers

External assumptions:

- Node.js 18+ runtime with `fetch`, `FormData`, and `Blob`
- a reachable Kubo-compatible IPFS HTTP API
- one node process per publication ledger file in v1
