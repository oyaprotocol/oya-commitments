# Add an IPFS-only production node mode

This ExecPlan is maintained according to `PLANS.md`.

## Purpose / Big Picture

An operator can run the production HTTP node with `"mode": "ipfs"`, accept allowlisted signed messages, and retrieve their published bytes from IPFS without an Ethereum RPC, Ledger contract, node transaction key, or gas funds. The existing configuration defaults to `"mode": "ledger"` and retains its publish-and-log behavior. This work includes host commands, Docker/Droplet deployment, and the optional hourly test agent. It does not publish an image or change a live deployment.

## Progress

- [x] 2026-10-11: Inspected runtime, deployment, local operator commands, hourly agent, existing tests, and repository instructions. Confirmed Node 24 and Docker are available.
- [x] 2026-10-11: Implemented explicit mode selection and IPFS-only HTTP/startup behavior with focused tests.
- [x] 2026-10-11: Adapted local operation, deployment validation, and the hourly agent; documented configuration and results.
- [x] 2026-10-11: All 152 initial host tests passed. Native Linux arm64 Docker validation passed HTTPS publication, exact signed bytes, authorization, IPFS outage recovery, retained storage, and hourly publication with no Ethereum service or node key.
- [x] 2026-10-11: Added actual local CLI lifecycle/status coverage for IPFS mode and verified empty/missing node keys still fail before RPC in Ledger mode. All 153 final host tests passed.
- [x] 2026-10-11: IPFS Docker integration passed on Linux amd64 under emulation in approximately 64 seconds. Existing Ledger Docker lifecycle/publication/backup checks passed on native arm64 in approximately 128 seconds; the Ledger hourly-agent profile and module suite passed on amd64 under emulation in approximately 23 seconds.
- [x] 2026-10-11: Completed documentation, CI wiring, JavaScript/shell syntax checks, whitespace checks, and complete proposed-change review. Test fixtures cleaned up their own resources.

## Surprises & Discoveries

- The hardened messages package already exports `publishSignedMessage`; no kernel or contract changes are needed.
- Secret-file parsing currently requires a node key independently of configuration. That requirement must move entirely to Ledger-mode signer construction; IPFS mode still accepts a readable empty secret file for the existing Docker mount interface.
- The hourly sender is a standalone fixture, not an agent-runner commitment module. Its own tests and Docker integration apply; `validate-agent.mjs` does not apply.
- The existing Docker integration assumes Anvil and Ledger throughout. IPFS validation must demonstrate operation with no running Ethereum service, including the optional sender.
- A separate `scripts/test-docker-ipfs.mjs` fixture reuses production Compose, HTTPS, and testing overlays while replacing only test ports/platform and offline Kubo settings. This keeps the existing Ledger lifecycle test unchanged and requires no Foundry installation for IPFS validation.

## Decision Log

- 2026-10-11 / Codex: Use `mode` with values `ledger` (default) and `ipfs`. Reject invalid modes and Ethereum-only configuration fields in IPFS mode so a mistaken mode cannot silently ignore chain settings.
- 2026-10-11 / Codex: Retain signatures, allowlists, limits, one active operation, and graceful draining in both modes. IPFS success returns HTTP 200 with `status: "published"` and a publication containing status, CID, and URI. Ledger success keeps its existing `logged` result.
- 2026-10-11 / Codex: IPFS failures may follow an upload but cannot leave a pending node transaction. Sanitize failures, release the operation slot, and report no logging outcome or transaction identity. Do not introduce recovery state, automatic retries by the hourly sender, or deduplication.
- 2026-10-11 / Codex: Keep the existing secrets-file argument for deployment; an empty file is valid for unauthenticated local Kubo. Do not generate or load a node transaction signer in IPFS mode.

## Outcomes & Retrospective

Runtime, operator commands, deployment validation, hourly-agent support, documentation, and CI wiring are complete. All 153 host tests passed, including real local CLI lifecycle/status coverage and Ledger-mode rejection of an empty key file despite valid inherited credentials. IPFS Docker checks passed on native Linux arm64 (approximately 44 seconds) and emulated Linux amd64 (approximately 64 seconds), confirming no Ethereum service or node key, working HTTPS, exact signed-content retrieval, upload recovery after a Kubo outage, storage persistence, and hourly-agent publication. Existing Ledger lifecycle/backup integration and the Ledger hourly-agent profile also passed. All generated test resources were cleaned up.

No package, image, tag, or release was published and no live node was changed. A new reviewed release is required to deploy this mode; `node-v0.1.0` remains unchanged. Hosted CI, native amd64 cloud operation, public DNS/certificates, and independent internet IPFS retrieval were not exercised here. The existing long-deadline Ledger HTTPS fixture was not rerun; proxy configuration and deadline calculations are unchanged, and the new IPFS fixture exercised the production proxy in both architectures.

## Context and Orientation

`node/production/src/config.mjs` parses strict JSON settings. `main.mjs` builds the runtime, and `server.mjs` authenticates requests and invokes the messages kernel. `src/secrets.mjs` parses Docker secrets. `scripts/local-{config,check,status,deploy}.mjs` own host operations. `scripts/deploy-droplet-remote.sh` validates container settings before starting Compose. The optional sender lives entirely in `agent-library/agents/hourly-message-test/`. Docker Compose provides Kubo (the IPFS implementation) and optionally Caddy (the HTTPS proxy). No shared `agent/` runner changes are needed.

## Plan of Work

First separate common and Ledger-specific configuration, startup, health, publication, and error handling. Test IPFS-only startup with no key or chain configuration and reject unexpected RPC/signing calls. Exercise signed bytes, authorization, limits, concurrency, timeouts, recovery after upload failure, and shutdown.

Next adapt local settings/check/status and explicitly reject `deploy-ledger` in IPFS mode. Adapt remote validation to skip node signer construction. Teach the hourly fixture to initialize an IPFS deployment and accept `published` results while keeping Ledger receipt requirements for `logged` responses. Add deployment and agent regressions. Document a complete minimal IPFS JSON example using existing release assets and an empty private secrets file.

Finally add a disposable Docker path with Kubo and the actual node entrypoint, no Anvil or node key, signed publication, independent IPFS retrieval, restart persistence, and hourly-agent publication. Wire that check into CI alongside existing Ledger coverage. Run the existing Ledger container flow after the shared runtime changes.

## Concrete Steps

Run from the repository root:

    npm --prefix node/production test
    bash -n node/production/scripts/deploy-droplet.sh node/production/scripts/deploy-droplet-remote.sh node/production/scripts/publish-image.sh
    npm --prefix node/production run test:ipfs -- --verbose
    npm --prefix node/production run test:docker -- --verbose
    npm --prefix node/production run test:testing -- --verbose
    git diff --check

`test:ipfs` will be added with this work. Container checks use isolated project names, generated test keys, private temporary settings, and their own volumes. Run the hourly module suite inside the node image, as in the existing Docker fixture, so its ethers dependency resolves without installing the shared agent workspace. Docker checks need Docker/Compose; Ledger integration also uses Foundry. No external RPC, funded wallet, or cloud credentials are needed.

## Validation and Acceptance

IPFS-only configuration and actual container startup work with no Ethereum settings or node key. Valid allowlisted requests return `published`, a CID, and URI, and retrieved bytes contain the original text, signer, and signature. Invalid or unauthorized requests do not upload. Busy and rate-limit rejections do not start work. Upload failures/timeouts are sanitized and do not leave a transaction-unavailable state. Shutdown drains the active operation. Local readiness/status and Droplet validation support the same mode. Ledger tests retain transaction verification and uncertain-outcome behavior. The optional hourly agent works in both modes and still stops on malformed or unsuccessful responses.

## Idempotence and Recovery

Edits and local tests can be repeated. Fixtures clean up only their own containers, volumes, processes, and temporary files. Never operate on an existing deployment or republish a release tag. Duplicate requests remain independent; an IPFS failure or lost response does not establish whether content was uploaded. Ledger recovery rules remain unchanged. Changing an existing node from Ledger to IPFS requires resolving any prior unknown transaction and deliberately restarting with reviewed configuration.

## Artifacts and Notes

Validation completed on Node 24.21.0 with Docker Engine 27.4.0, Compose 2.31.0, Kubo 0.43.0, and Caddy 2.11.4. Ledger fixtures used Foundry 1.5.1. Commands and results:

    npm --prefix node/production test
    # 153 passed, 0 failed or skipped.
    npm --prefix node/production run test:ipfs -- --verbose
    # Native arm64 passed, including hourly module tests and production HTTPS.
    npm --prefix node/production run test:ipfs -- --verbose --platform linux/amd64
    # Emulated amd64 passed with the same assertions.
    npm --prefix node/production run test:docker -- --verbose
    # Native arm64 Ledger publication, lifecycle, reconciliation, and backup/restore passed.
    npm --prefix node/production run test:testing -- --verbose --platform linux/amd64
    # Emulated amd64 hourly Ledger agent and module suite passed.

JavaScript syntax checks for every changed/new module, shell syntax checks for the deployment/release scripts, and `git diff --check` passed. The new IPFS integration is wired into the existing Docker CI job; hosted execution remains unverified.

## Interfaces and Dependencies

Reuse `publishSignedMessage` and `publishAndLogSignedMessage` from `@oyaprotocol/messages` without dependency or Solidity changes. IPFS mode requires `allowedSigners` and `ipfsUrl`; common HTTP limits remain configurable. Ledger-only fields are `chainId`, `ledgerContract`, `rpcUrl`, `receiptTimeoutMs`, `pollIntervalMs`, `gasLimit`, and `maxFeePerGasWei`. Docker continues mounting a private secrets file with optional `OYA_IPFS_AUTHORIZATION`; `OYA_NODE_PRIVATE_KEY` and `OYA_RPC_AUTHORIZATION` are used only in Ledger mode.
