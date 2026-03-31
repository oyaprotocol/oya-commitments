# Oya Node Publish And Propose

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Extend the existing Oya node from "archive signed proposal requests to IPFS" into "archive, and optionally also submit the proposal onchain." After this change, the same signed payload produced by `agent/scripts/send-signed-proposal.mjs` will continue to be accepted by the node, but operators will be able to start the node in one of two modes:

- `publish`: current behavior. Verify the signed payload, publish the artifact to IPFS, pin it, and return the CID.
- `propose`: resolve the signed payload's `chainId` to a supported chain-specific proposer runtime, publish and pin the artifact, then submit `proposeTransactions(...)` against the signed payload's `ogModule` using the node's configured signer for that chain.

This follow-on plan intentionally does not add rule validation yet. In this version, the node assumes that any request signed by an address on the node's internal allowlist is eligible for execution, regardless of which commitment it targets. The signed payload already contains `chainId`, `commitmentSafe`, `ogModule`, `transactions`, and `explanation`; those signed fields are the only source of truth for what gets archived and, in `propose` mode, what gets submitted onchain.

After this change, the observable behavior should be:

1. A sender can submit the same signed payload to the same endpoint as today.
2. In `publish` mode, the node behaves exactly as it does today.
3. In `propose` mode, the node returns the IPFS publication result plus proposal-submission metadata such as submission transaction hash and resolved OG proposal hash when available.
4. Exact duplicate retries do not create duplicate IPFS artifacts or duplicate onchain proposals.
5. If IPFS publication succeeds but onchain proposal submission fails before a transaction hash is obtained, the node reuses the archived CID and retries only the proposal stage.
6. If the node already has a proposal submission transaction hash for a signed request, retries never resubmit blindly; they only return or reconcile the stored submission record.
7. In `propose` mode, requests for unsupported chain IDs are rejected clearly instead of forcing the node into a single fixed-chain startup mode.

Out of scope for this ExecPlan:

- checking a commitment's rules before submission
- per-commitment signer authorization rules beyond the node's global allowlist
- fee collection
- dispute automation
- multi-node coordination
- replacing the existing publication-only workflow for operators who want archival without submission

## Progress

- [x] 2026-03-31: Audited `PLANS.md`, the existing publication-only ExecPlan, and the shared OG proposal submission helper in `agent/src/lib/tx.js`.
- [x] 2026-03-31: Wrote this standalone follow-on ExecPlan in `plans/oya-node-publish-and-propose.md` before implementation.
- [x] 2026-03-31: Revised the plan so `propose` mode is multi-chain-capable per signed `chainId`, with per-request chain resolution and clear rejection for unsupported chains.
- [x] 2026-03-31: Added `proposalPublishApi.mode`, promoted `rpcUrl` into shared runtime config so it can be overridden per chain, and taught the startup helper to report mode plus supported chains in `--dry-run`.
- [x] 2026-03-31: Extended the durable publication ledger with a nested `submission` state machine and backward-compatible normalization for older publication-only records.
- [x] 2026-03-31: Refactored the shared OG submission primitive to expose an early `onProposalTxSubmitted` persistence hook and exported receipt-based OG proposal-hash resolution for node-side reconciliation.
- [x] 2026-03-31: Extended `POST /v1/proposals/publish` so `publish` mode remains unchanged and `propose` mode now routes by signed `chainId`, archives to IPFS, and then submits onchain with idempotent retry handling.
- [x] 2026-03-31: Added regression coverage for publish-only compatibility, propose-mode success, duplicate retries, submission retry after pre-tx failure, pending-hash reconciliation, and unsupported-chain rejection.
- [x] 2026-03-31: Updated `agent/README.md` and `start-proposal-publish-node.mjs` help text to document the new mode and per-chain proposer requirements.
- [x] 2026-03-31: Fixed follow-up regressions so ambiguous multi-chain agent configs still boot before runtime chain probing, and propose-mode startup only counts chains with a usable `rpcUrl` as propose-capable.
- [x] 2026-03-31: Fixed duplicate reliability so exact propose-mode retries can still return stored records during runtime outages when no new submission side effects are required, and narrowed startup `supportedChainIds` / preflight validation to the chains the node actually serves.
- [x] 2026-03-31: Hardened propose-mode runtime resolution so both the read RPC and the signer-side RPC must match the request chain, with regression coverage for remote signer mismatch.
- [x] 2026-03-31: Tightened propose-mode chain validation so startup only counts per-chain `mode: "propose"` runtimes as propose-capable, and request-time fixed-chain selection conflicts now surface as `unsupported_chain` instead of a generic runtime failure.
- [x] 2026-03-31: Enforced the configured served-chain allowlist before request-time proposer runtime resolution, so unsupported chains are rejected before any read or signer client is constructed.
- [x] 2026-03-31: Recreated runtime read/signer clients after final chain-specific config resolution in `initializeAgentRuntime()`, and hardened the proposal-submission catch path so storage failures after an observed tx hash stay on the safe `submission_uncertain` path.

## Surprises & Discoveries

- Observation: The repository already has a generic OG proposal submission helper, `postBondAndPropose(...)`, under `agent/src/lib/tx.js`; the node does not need a second copy of the bond / allowance / simulate / submit logic.
  Evidence: `agent/src/lib/tx.js` exports `postBondAndPropose`, and it already handles ERC-20 bond checks, duplicate-proposal simulation failures, submission, and OG proposal-hash resolution.

- Observation: The current publication server can intentionally start without a resolved `chainId`, and that same ambiguity can be preserved for `propose` mode if request handling resolves a concrete proposer runtime from each signed payload's `chainId`.
  Evidence: `agent/scripts/lib/proposal-publish-runtime.mjs` already supports ambiguous startup resolution for publication-only mode, while `postBondAndPropose(...)` only needs a concrete `publicClient`, `walletClient`, `account`, and chain-specific config at the moment submission actually occurs.

- Observation: The publication ledger currently solves IPFS idempotency, but onchain idempotency adds a second failure boundary where the node may have sent a transaction before the HTTP response is lost or before the OG proposal hash is resolved.
  Evidence: `agent/src/lib/proposal-publication-store.js` today persists `cid`, `uri`, `pinned`, and related publication metadata, while `agent/src/lib/tx.js` only returns the submission hash after the onchain call has already occurred.

- Observation: Multi-chain propose mode needed one additional shared runtime capability that publication-only mode did not: chain-specific `rpcUrl` selection from config rather than a single process-wide `RPC_URL`.
  Evidence: `agent/src/lib/config.js` previously sourced `rpcUrl` only from env, while `agent/src/lib/agent-config.js` did not expose `rpcUrl` as a shared override field. The implementation promoted `rpcUrl` into the shared config layer and updated `agent/src/lib/runtime-bootstrap.js` to honor config-selected RPC endpoints.

## Decision Log

- Decision: Keep the same signed proposal envelope and the same `POST /v1/proposals/publish` endpoint for both modes.
  Rationale: The user explicitly wants the node to receive the signed payload "as before." Reusing the same payload and route keeps sender behavior stable and makes mode switching an operator choice instead of a sender-side protocol change.
  Date/Author: 2026-03-31 / Codex.

- Decision: Add a concise mode field with values `publish` and `propose`.
  Rationale: `publish` matches the current archival-only behavior. `propose` is succinct and clearly means "publish, then submit." The existing `enabled` flag remains useful for turning the service off entirely.
  Date/Author: 2026-03-31 / Codex.

- Decision: In `propose` mode, publish first and submit second.
  Rationale: This preserves an immutable public artifact before the node spends gas or creates an OG proposal. If submission later fails, the archived request still exists and retries can reuse the same CID.
  Date/Author: 2026-03-31 / Codex.

- Decision: In v1, the node will trust any allowlisted signer for any signed `commitmentSafe` / `ogModule` pair and will not enforce commitment-specific policy.
  Rationale: The user explicitly wants the first version to skip rule validation and treat the node's internal allowlist as sufficient authorization.
  Date/Author: 2026-03-31 / Codex.

- Decision: `propose` mode will be multi-chain-capable, but each request must resolve its signed `chainId` to a supported chain-specific proposer runtime before publication and submission proceed.
  Rationale: The user wants the node to propose against whichever chain is named in the signed payload. That is safe as long as the node only accepts chains for which it has explicit RPC, signer, and proposal config, and rejects unsupported chains clearly.
  Date/Author: 2026-03-31 / Codex.

- Decision: The node's own configured signer, not the signed-request signer, will be the proposer that pays gas and posts bond.
  Rationale: The signed request authorizes intent; the node is the actor carrying out submission. This cleanly separates "who approved the request" from "which wallet performed the onchain transaction."
  Date/Author: 2026-03-31 / Codex.

## Outcomes & Retrospective

This plan is now implemented. The finished outcome is:

- operators can start the same Oya node in `publish` or `propose` mode
- `publish` mode remains backward-compatible with the current production behavior
- `propose` mode archives the signed request to IPFS and then submits it onchain using the node's signer for the request's chain
- retries are idempotent across both the IPFS boundary and the onchain submission boundary
- propose-mode startup can remain chain-ambiguous as long as each incoming request resolves to a supported chain-specific runtime before any side effects begin

Validation completed during implementation:

- `node agent/scripts/test-agent-config-file.mjs`
- `node agent/scripts/test-send-signed-proposal-config.mjs`
- `node agent/scripts/test-proposal-publication-store.mjs`
- `node agent/scripts/test-proposal-publication-api.mjs`
- `node agent/scripts/test-transfer-tool-and-proposal-explanation.mjs`
- `node agent/scripts/test-zero-first-erc20-allowance.mjs`
- `node agent/scripts/test-tool-output-retryability.mjs`
- `node agent-library/agents/signed-proposal-publish-smoke/test-signed-proposal-publish-smoke-agent.mjs`
- `node agent/scripts/start-proposal-publish-node.mjs --module=signed-proposal-publish-smoke --dry-run`

## Context and Orientation

The current publication-only node is implemented in the following shared files:

- `agent/src/lib/signed-proposal.js`: defines the canonical signed proposal envelope, canonical JSON payload, publication artifact, and artifact verifier.
- `agent/src/lib/proposal-publication-api.js`: serves `GET /healthz` and `POST /v1/proposals/publish`, authenticates the signed payload, publishes to IPFS, pins the CID, and returns a stable response.
- `agent/src/lib/proposal-publication-store.js`: stores durable idempotency records keyed by `(signer, chainId, requestId)`.
- `agent/scripts/start-proposal-publish-node.mjs`: resolves runtime config and starts the server.
- `agent/scripts/lib/proposal-publish-runtime.mjs`: resolves CLI overrides, module config, host/port, chain selection, and default state-file paths.
- `agent/scripts/send-signed-proposal.mjs`: signs and submits the payload to the node.

The existing shared OG proposal submission path already lives in:

- `agent/src/lib/tx.js`: exports `postBondAndPropose(...)`, which normalizes OG transactions, verifies proposer balance, checks or sets bond collateral approvals, simulates `proposeTransactions(...)`, submits the transaction, and attempts to resolve the OG proposal hash from logs.

Important runtime assumptions already present in the repo:

- The node's signed-request allowlist is local policy. It does not derive from Safe owners or onchain commitment config.
- The signed envelope already covers the target `chainId`, `commitmentSafe`, `ogModule`, `transactions`, and `explanation`.
- The node's signer stack comes from the existing shared signer config in `agent/src/lib/signer.js` and the repo-wide config system in `agent/src/lib/config.js` and `agent/src/lib/agent-config.js`.
- `postBondAndPropose(...)` respects existing runtime controls such as `proposeEnabled`, `allowProposeOnSimulationFail`, `proposeGasLimit`, `proposalHashResolveTimeoutMs`, and `proposalHashResolvePollIntervalMs`.
- Multi-chain agent configs already exist via `byChain`, so the missing piece for multi-chain propose mode is request-time chain selection, not a new config model.

The key architectural constraint for this plan is that publication idempotency and proposal-submission idempotency are not the same thing. IPFS publication is content-addressed and can be safely retried after storing the CID. Onchain submission can spend gas and change state. The node must therefore persist enough proposal-submission state to decide whether a retry should:

- do nothing and return the stored result
- resolve a previously-sent transaction hash more fully
- retry submission because no transaction was sent
- stop and surface an uncertain state that should not be retried automatically

## Plan of Work

First, generalize the node runtime from "publication service" to "publication service with an optional submission stage." This means extending config resolution in `agent/src/lib/config.js`, `agent/src/lib/agent-config.js`, and `agent/scripts/lib/proposal-publish-runtime.mjs` so the server can resolve a `proposalPublishApi.mode` field with values `publish` or `propose`. `publish` mode keeps the current semantics. `propose` mode must support request-time chain selection: the server starts from a possibly ambiguous multi-chain config, and each request resolves its signed `chainId` to a concrete per-chain proposer runtime with `proposeEnabled=true`, RPC access, and signer configuration.

Second, extend the durable ledger in `agent/src/lib/proposal-publication-store.js` to track proposal-submission state alongside publication state. Each record should still be keyed by `(signer, chainId, requestId)`, but it also needs a nested `submission` object with enough information to recover safely. The minimal persisted fields should be:

- `status`: one of `not_started`, `submitted`, `resolved`, `failed`, or `uncertain`
- `submittedAtMs`
- `transactionHash`
- `ogProposalHash`
- `result`
- `error`
- `sideEffectsLikelyCommitted`

The store must preserve backward compatibility with publication-only records already on disk. Old records should load as `submission.status = "not_started"` when rewritten.

Third, make the shared proposal-submission path safe for node-side idempotence and per-request chain routing. The current `postBondAndPropose(...)` helper in `agent/src/lib/tx.js` is close to what the node needs, but the node needs earlier persistence points plus a clean way to resolve a per-chain runtime from the signed `chainId`. The cleanest path is to refactor the submission helper so the node can:

- get a callback or structured result as soon as a submission transaction hash exists
- persist that transaction hash before trying to resolve `ogProposalHash`
- distinguish "submission definitely not sent" from "side effects may already be committed"
- resolve `publicClient`, `walletClient`, `account`, and proposal config from the request's `chainId` rather than a fixed startup chain

This shared refactor belongs in `agent/src/lib/tx.js` because it improves the core OG submission primitive rather than adding node-specific logic to a shared file arbitrarily. The node-specific wrapper can then live in a new shared file such as `agent/src/lib/proposal-submission.js` or alongside the server if the abstraction stays small.

Fourth, extend `agent/src/lib/proposal-publication-api.js` so `POST /v1/proposals/publish` performs a two-stage pipeline:

1. authenticate the signed request exactly as today
2. if mode is `propose`, resolve a proposer runtime from the signed `chainId` or reject the request as unsupported before side effects begin
3. prepare or load the durable record
4. publish and pin the artifact exactly as today
5. if mode is `publish`, return the publication response and stop
6. if mode is `propose`, enqueue a second keyed operation for proposal submission
7. submit `proposeTransactions(...)` against the signed `ogModule` with the signed `transactions` and `explanation`
8. persist the submission transaction hash immediately when available
9. attempt to resolve the OG proposal hash from logs or receipt
10. return both publication and submission metadata

The signed payload fields are the only inputs used for the target commitment: the node proposes against the signed `ogModule`, and the returned record carries the signed `commitmentSafe` for observers and later policy enforcement. No additional unsigned "target commitment" parameter should be added to the request.

Fifth, define the response and retry semantics clearly. The existing top-level publication response can remain, but `propose` mode should add a nested `submission` object. A successful response in `propose` mode should look like:

    {
      "status": "published",
      "mode": "propose",
      "requestId": "proposal-123",
      "signer": "0x...",
      "cid": "bafy...",
      "uri": "ipfs://bafy...",
      "pinned": true,
      "submission": {
        "status": "submitted",
        "submittedAtMs": 1760000000000,
        "transactionHash": "0x...",
        "ogProposalHash": "0x..." | null
      }
    }

If the archive exists and the proposal has already been submitted, retries should return the stored `transactionHash` and `ogProposalHash` without a second onchain submission. If archive succeeded but submission failed before a transaction hash existed, the API should return a 502-style failure that still includes the existing CID and indicates the request can be retried safely. If a failure occurs after `sideEffectsLikelyCommitted=true` but before a transaction hash is known, the API should mark the record `uncertain` and refuse automatic retry until an operator investigates; that is safer than risking a duplicate proposal.

Sixth, update startup, CLI, and docs. `agent/scripts/start-proposal-publish-node.mjs` should keep its current entrypoint for compatibility but expose the resolved mode and supported chain behavior in `--dry-run` output. If needed, a thin alias such as `start-proposal-node.mjs` can be added later, but this plan does not require a rename. `agent/README.md` and script help text must explain:

- how to enable `proposalPublishApi.mode: "publish"` versus `"propose"`
- that `propose` mode requires a real proposer signer and resolvable per-chain runtime config for every chain the node should serve
- that the signed-request signer and the node's proposer signer are different roles
- that v1 does not enforce commitment-specific policy

## Concrete Steps

1. Add mode-aware config resolution.

   Files:

   - `agent/src/lib/config.js`
   - `agent/src/lib/agent-config.js`
   - `agent/scripts/lib/proposal-publish-runtime.mjs`
   - `agent/scripts/start-proposal-publish-node.mjs`
   - `agent/scripts/test-send-signed-proposal-config.mjs`

   Work:

   - add `proposalPublishApi.mode` with default `publish`
   - add request-time chain resolution helpers for `propose` mode
   - include the resolved mode in `--dry-run` output
   - keep `publish` mode backward-compatible with today's multi-chain archival behavior
   - fail startup only when `propose` mode has no usable proposer runtime for any chain, not merely because startup is chain-ambiguous

2. Extend the durable ledger for submission state.

   Files:

   - `agent/src/lib/proposal-publication-store.js`
   - `agent/scripts/test-proposal-publication-store.mjs`

   Work:

   - add nested `submission` record fields
   - normalize old records on read
   - ensure store serialization still prevents concurrent read-modify-write loss
   - add regressions for transition cases such as `not_started -> submitted -> resolved` and `not_started -> failed`

3. Refactor the shared OG submission primitive for node recovery.

   Files:

   - `agent/src/lib/tx.js`
   - new helper if needed: `agent/src/lib/proposal-submission.js`
   - existing proposal-related tests such as:
     - `agent/scripts/test-transfer-tool-and-proposal-explanation.mjs`
     - `agent/scripts/test-zero-first-erc20-allowance.mjs`
     - `agent/scripts/test-tool-output-retryability.mjs`

   Work:

   - expose an early persistence hook or structured phase result when the transaction hash is obtained
   - preserve existing agent behavior and return shape where possible
   - make `sideEffectsLikelyCommitted` explicit so the node can decide when not to auto-retry

4. Extend the HTTP API with the optional proposal stage.

   Files:

   - `agent/src/lib/proposal-publication-api.js`
   - `agent/scripts/test-proposal-publication-api.mjs` or a new focused `agent/scripts/test-proposal-node-api.mjs`

   Work:

   - keep the request schema unchanged
   - resolve and validate the signed `chainId` before publication when in `propose` mode
   - in `publish` mode, keep current semantics unchanged
   - in `propose` mode, run publication first, then submission
   - add a second keyed in-process queue keyed by `(signer, chainId, requestId)` for the submission stage, or reuse the same keyed queue if sequencing stays simple
   - persist `transactionHash` immediately when available
   - never resubmit when a stored `transactionHash` already exists
   - surface structured retryability in error responses

5. Add end-to-end smoke coverage and documentation.

   Files:

   - `agent/README.md`
   - `agent/scripts/start-proposal-publish-node.mjs`
   - possibly a new smoke module under `agent-library/agents/` if the existing `signed-proposal-publish-smoke` module becomes too publication-specific

   Work:

   - document both modes
   - add an end-to-end smoke test that proves `propose` mode archives and then calls the OG proposal path using mocks or a local harness
   - keep the existing publication-only smoke path intact

## Validation and Acceptance

The change is accepted when all of the following are true:

- `publish` mode behaves exactly as it does today for successful requests, duplicate retries, and publication-only recovery cases.
- `propose` mode accepts the same signed payload, publishes the artifact, then submits the proposal onchain using the node's signer for the payload's chain.
- exact duplicate retries in `propose` mode return the same `cid` and `transactionHash` without a second IPFS add or a second onchain submission.
- if the publication stage succeeded and the submission stage failed before a transaction hash existed, the node returns the existing `cid` and safely retries submission only.
- if a transaction hash exists but `ogProposalHash` is still null, retries only attempt reconciliation and never resubmit.
- `propose` mode can start from multi-chain config and correctly routes at least two distinct signed `chainId` values to distinct proposer runtimes.
- `propose` mode rejects unsupported chain IDs before publication or submission side effects begin.

Minimum validation commands to run from `/Users/johnshutt/Code/oya-commitments`:

    node agent/scripts/test-proposal-publication-store.mjs
    node agent/scripts/test-proposal-publication-api.mjs
    node agent/scripts/test-send-signed-proposal-config.mjs
    node agent/scripts/test-transfer-tool-and-proposal-explanation.mjs
    node agent/scripts/test-zero-first-erc20-allowance.mjs
    node agent/scripts/test-tool-output-retryability.mjs

Add at least one new focused regression command for the new submission stage, for example:

    node agent/scripts/test-proposal-node-api.mjs

If a module-level smoke path is added or extended, also run:

    node agent/scripts/validate-agent.mjs --module=<smoke-module-name>
    node agent-library/agents/<smoke-module-name>/test-<smoke-module-name>-agent.mjs

If local listener tests require escalation again in this environment, record that fact in the plan and note which commands need approval.

## Idempotence and Recovery

This plan adds a second side-effect boundary, so recovery rules must be explicit.

Publication stage:

- identical retries reuse the existing CID and pin state
- failed pin after successful add retries only the pin step, as today

Per-request chain routing:

- in `propose` mode, unsupported or unresolvable `chainId` values must fail before the node archives or submits anything
- once a record exists for a supported `(signer, chainId, requestId)`, retries continue to use that same chain-scoped record

Submission stage:

- if `submission.status = "resolved"` or `"submitted"` with a stored `transactionHash`, retries must not send a second proposal transaction
- if `submission.status = "failed"` and `sideEffectsLikelyCommitted = false`, retries may attempt submission again
- if `submission.status = "uncertain"` or `sideEffectsLikelyCommitted = true` without a known `transactionHash`, retries must not auto-resubmit; return a clear error instructing the operator to inspect the node logs / chain state

Rollback:

- switching a node from `propose` back to `publish` is a safe configuration change because publication records remain valid
- the ledger schema must remain backward-compatible so rolling forward does not corrupt existing publication-only state files
- no destructive migration should be required; schema upgrades should happen lazily on read/write

## Artifacts and Notes

Expected config shape for archival-only mode:

    {
      "proposalPublishApi": {
        "enabled": true,
        "mode": "publish",
        "host": "127.0.0.1",
        "port": 9890
      }
    }

Expected config shape for archive-and-submit mode:

    {
      "proposalPublishApi": {
        "enabled": true,
        "mode": "propose",
        "host": "127.0.0.1",
        "port": 9890,
        "signerAllowlist": [
          "0xAgentSigner..."
        ]
      },
      "byChain": {
        "1": {
          "proposeEnabled": true
        },
        "11155111": {
          "proposeEnabled": true
        }
      }
    }

Expected successful response fields in `propose` mode:

- publication metadata: `cid`, `uri`, `pinned`, `publishedAtMs`
- submission metadata: `submission.status`, `submission.submittedAtMs`, `submission.transactionHash`, `submission.ogProposalHash`

Expected operator-visible logs:

- startup log includes the resolved mode
- startup or dry-run output indicates whether the node is serving a single configured chain or resolving proposer context per request
- request logs include the publication request id and signer, as today
- in `propose` mode, success logs also include the request `chainId` and proposal submission transaction hash

## Interfaces and Dependencies

Primary files and interfaces:

- `agent/src/lib/signed-proposal.js`
  - signed proposal envelope and artifact verifier
- `agent/src/lib/proposal-publication-api.js`
  - `createProposalPublicationApiServer(...)`
- `agent/src/lib/proposal-publication-store.js`
  - durable request ledger keyed by `(signer, chainId, requestId)`
- `agent/src/lib/tx.js`
  - `postBondAndPropose(...)`
- `agent/src/lib/signer.js`
  - node-side proposer signer resolution
- `agent/scripts/lib/proposal-publish-runtime.mjs`
  - startup and CLI resolution for node host/port/chain/mode, plus per-request proposer runtime resolution
- `agent/scripts/start-proposal-publish-node.mjs`
  - standalone node process
- `agent/scripts/send-signed-proposal.mjs`
  - unchanged request sender

Existing config and env dependencies:

- `proposalPublishApi.enabled`
- new `proposalPublishApi.mode`
- `proposalPublishApi.signerAllowlist`
- `proposalPublishApi.requireSignerAllowlist`
- `proposalPublishApi.host`
- `proposalPublishApi.port`
- `proposalPublishApi.stateFile`
- `proposalPublishApi.nodeName`
- `PROPOSAL_PUBLISH_API_KEYS_JSON`
- `ipfsEnabled`
- `ipfsApiUrl`
- signer configuration used by `createSignerClient(...)`
- `proposeEnabled`
- `allowProposeOnSimulationFail`
- `proposeGasLimit`
- `proposalHashResolveTimeoutMs`
- `proposalHashResolvePollIntervalMs`
- `bondSpender`
- chain-specific RPC configuration for every chain served in `propose` mode

External services and protocols involved:

- Kubo-compatible IPFS API for publication and pinning
- JSON-over-HTTP for sender-to-node requests
- EIP-191 signed messages for sender authentication
- Optimistic Governor `proposeTransactions(...)` for onchain proposal submission
