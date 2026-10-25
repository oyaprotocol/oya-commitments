# Oya Node

`node/` contains the production publication runtime and experimental daemons. For a new installation, use the production path below. For commitment deployment or a commitment-serving agent, return to the [repository task guide](../README.md#start-here).

## Run a production node

The Oya production runtime lives in [`production/`](production/README.md). Its default deployment runs on a local device and polls a portable [PostgreSQL inbox](production/host-inbox.md) over outbound HTTPS. The inbox receives signed messages, tracks publication, and keeps execution checkpoints for restart recovery. Full Ledger mode logs CIDs onchain; IPFS-only mode needs no Ethereum connection or funded node wallet. A synchronous direct API remains available separately. The experimental daemons described below use the earlier shared agent infrastructure.

Start with **IPFS-only** for a first deployment. Choose one setup path:

- **[Deploy with an agent](production/deploy-with-agent.md):** supply hosting preferences and secure credential references, then have the agent configure and verify both roles.
- **[Run locally yourself](production/run-locally.md):** follow the local worker walkthrough, then its linked inbox-hosting steps. Both IPFS-only and full Ledger modes are covered.

The guides use the published [node-v0.3.0 image and deployment bundle](production/release-image.md#published-deployment-release); no source build is required. v0.2.0 supports the older direct API. See the [production reference](production/README.md) for APIs, advanced direct deployments, and development checks.

## Develop the production runtime

From the repository root, `npm --prefix node/production run test:local` validates the operating CLI and a separate message sender against disposable Anvil and offline Kubo, including Ledger deployment/reuse, publication, and node restart. See the [production validation guide](production/README.md#install-and-validate) for prerequisites and evidence output.

## Experimental daemons

The remaining sections describe the earlier daemons in `node/scripts/`, which share libraries with `agent/`. Their APIs and configuration differ from the production inbox/worker flow above. Use these sections when developing their proposal, control, or commitment-specific integrations.

These daemons run separately from the commitment-serving agent loop in `agent/`:

- the message publication node archives signed agent-authored messages to IPFS
- the message publication node can optionally run a module-exported validator and sign validator output into the published artifact
- the control node polls the commitment and the module's published-message history, then lets module-local node hooks decide whether to dispute withdrawals or submit other node-owned onchain actions
- the proposal publication node archives signed proposal bundles to IPFS
- the proposal publication node can also run in `propose` mode and submit proposals onchain
- the proposal publication node now also exposes a verification API for supported proposal kinds

The underlying publication/auth/IPFS/config libraries are still shared from `agent/src/lib/` in this version. This workspace owns the process entrypoints, node-oriented runtime helpers, and node-focused tests. `node/package.json` depends on the shared agent package, and the node scripts prefer local repo imports while falling back to that installed package so the daemons can still boot when `node/` is installed from its own manifest.

## Proposal Verification

The proposal publication node now supports three related behaviors:

- `POST /v1/proposals/publish` in `publish` mode: authenticate, archive to IPFS, pin, and store the signed proposal bundle.
- `POST /v1/proposals/publish` in `propose` mode: do the above, then optionally verify and submit the proposal onchain.
- `POST /v1/proposals/verify`: authenticate the signed request and return a deterministic verification result without publishing or submitting.

Current verifier coverage is intentionally narrow:

- supported proposal kind: `agent_proxy_reimbursement`
- supported standard-template parsing: `Agent Proxy`, `Solo User`, `Fair Valuation`, and `Account Recovery and Rule Updates`
- current outcome for extra relevant templates such as `Trade Restrictions`, `Trading Limits`, or pause rules: `unknown`

The verifier is deterministic only. It does not use an LLM and it does not attempt freeform semantic interpretation of arbitrary commitment text.

## Control Node

`node/scripts/start-control-node.mjs` runs a standalone polling loop for modules that export `getNodeDeterministicToolCalls()`. The control loop:

- uses the module's normal runtime config and signer
- reads the durable message-publication ledger for that module
- polls the Optimistic Governor for new, executed, and deleted proposals
- delegates actual node-owned decisions to module-local hooks such as `getNodeDeterministicToolCalls()`, `onNodeToolOutput()`, and `onNodeProposalEvents()`

For `polymarket-staked-external-settlement`, the split is now:

- the agent loop trades, publishes cumulative trade logs, makes the final settlement deposit, and publishes a signed reimbursement request
- the control node disputes invalid user withdrawals from published node state
- the control node submits the reimbursement proposal after the published settlement state and reimbursement request are both present, by sending a signed request to `POST /v1/proposals/publish`

For this module, operators should run:

- the message publication node so cumulative trade logs and reimbursement-request messages are archived to IPFS and written to the durable message ledger
- the proposal publication node in `propose` mode so the control node can archive reimbursement proposals to IPFS and submit them onchain

Current limit: the Polymarket reimbursement path now uses the canonical `agent_proxy_reimbursement` kind, but it still does not supply the full `metadata.verification` evidence bundle that the current deterministic verifier expects. Keep `proposalVerificationMode=off` unless you intentionally want advisory-only recording for this module.

### Verification Mode

Configure `proposalVerificationMode` in the active module config:

- `off`: no verification is run during `POST /v1/proposals/publish`
- `advisory`: verification runs and is stored on the record, but non-`valid` results do not block submission
- `enforce`: verification runs before submission, and only `valid` results may proceed onchain

`/v1/proposals/verify` does not require `proposalVerificationMode`; it is always available when the proposal publication node is running.

### Signed Verification Metadata

For `agent_proxy_reimbursement`, signed `metadata.verification` currently needs:

- `proposalKind`: must be `agent_proxy_reimbursement`
- `rulesHash`: keccak256 hash of the current onchain `rules()` text being verified
- `depositTxHashes`: referenced deposit transaction hashes
- `depositPriceSnapshots`: one entry per referenced deposit, including the deposit-time price of the deposited asset and deposit-time prices of reimbursement assets
- `reimbursementAllocations`: one entry per referenced deposit, mapping proposal withdrawal amounts back to that deposit
- `explanation`: a canonical JSON string whose `kind` is `agent_proxy_reimbursement`, whose `description` is the human-readable summary, and whose `depositTxHashes` exactly match the signed metadata

The whole-deposit batch model is enforced:

- each referenced deposit is either `available`, `reserved`, or `consumed`
- a deleted or disputed proposal releases its deposits back to `available`
- only a successfully executed proposal makes a deposit `consumed`
- if a proposal reimburses slightly less than the aggregate deposit-time value because of deterministic rounding down, the referenced deposits are still treated as fully consumed after execution

### Current Limits

What the verifier currently proves:

- the signed request metadata is well-formed
- `rulesHash` matches the current onchain rules text
- `explanation.depositTxHashes` matches the signed metadata and can be decoded from onchain `TransactionsProposed` events
- the rules text parses as supported standard templates
- reimbursement transfers target the authorized `Agent Proxy` address
- referenced deposits are confirmed ERC20 transfers from the agent into the commitment Safe
- referenced deposits are not already reserved by another live proposal or consumed by an executed proposal
- the signed per-deposit reimbursement allocations match the proposal transactions
- each deposit allocation stays within that deposit's deposit-time value ceiling

What it does not yet prove:

- full `first-proxy` policy compliance for templates like `Trade Restrictions` or `Trading Limits`
- fee withdrawals, rule updates, pause/unpause flows, or disputes
- arbitrary freeform commitments

## Commands

From the repository root:

```bash
node node/scripts/start-message-publish-node.mjs --module=<agent-name>
node node/scripts/start-control-node.mjs --module=<agent-name>
node node/scripts/start-proposal-publish-node.mjs --module=<agent-name>
```

For dry-run config resolution:

```bash
node node/scripts/start-message-publish-node.mjs --module=<agent-name> --dry-run
node node/scripts/start-control-node.mjs --module=<agent-name> --dry-run
node node/scripts/start-proposal-publish-node.mjs --module=<agent-name> --dry-run
```

Focused regression entrypoints:

```bash
node node/scripts/test-message-publication-api.mjs
node node/scripts/test-message-publication-store.mjs
node node/scripts/test-message-publish-runtime.mjs
node node/scripts/test-proposal-publication-api.mjs
node node/scripts/test-proposal-publication-store.mjs
node agent/scripts/test-proposal-verification.mjs
```

## Compatibility

The old startup paths under `agent/scripts/` still exist as compatibility wrappers during the migration:

- `agent/scripts/start-message-publish-node.mjs`
- `agent/scripts/start-proposal-publish-node.mjs`

Use the `node/` paths for new docs, new operator instructions, and future node work.
