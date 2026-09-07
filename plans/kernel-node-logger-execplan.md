# Run a kernel-backed Oya message node and deploy Logger

This ExecPlan is a living document maintained according to `PLANS.md`.

## Purpose / Big Picture

An operator can start an Oya HTTP node, submit an allowlisted agent's Ethereum-signed text message, retrieve the published JSON from IPFS, and observe its CID in a mined Logger event attributed to the node's account. This establishes a running node built on the hardened kernel packages and a deployed Logger. Commitments continue to use Safe and Optimistic Governor; reimbursement verification and DeFi integrations are subsequent work.

## Progress

- [x] 2026-09-07: Read root, package, and contract instructions; inspected kernel APIs and existing node entrypoints.
- [x] 2026-09-07: Confirmed Foundry, Node 23.10.0, and Kubo/IPFS 0.40.1 are installed; dependencies are not installed in this checkout.
- [x] 2026-09-07: Implemented the standalone kernel runtime, explicit config, signing adapter, and durable publication progress.
- [x] 2026-09-07: Added Logger deployment tooling, operator instructions, signed-message client, and CI runtime tests.
- [x] 2026-09-07: Seven host tests passed, covering HTTP limits/authentication, signing, persistence, concurrency, ambiguous submission, and receipt verification.
- [x] 2026-09-07: Deployed Logger on isolated Anvil; real Kubo/HTTP/chain smoke passed including two restart-recovery paths and concurrency.
- [x] 2026-09-07: Final runtime tests and formatting/whitespace checks passed; a fresh validated local stack is running through the real CLI entrypoint.
- [x] 2026-09-07: Recorded the running local endpoints and deployment evidence below.
- [x] 2026-09-07: Reworded documentation and sample messages around kernel-node behavior for reuse in the upstream repository.
- [x] 2026-09-07: Moved the standalone runtime to `node/production/` and updated documentation, CI, CLI startup paths, and ignore rules.
- [x] 2026-09-07: All seven runtime tests and the full local smoke, including CLI startup, passed from `node/production/`. Verified ignore rules and removed all old directory references.
- [ ] If public deployment is desired, obtain the selected chain, host, funded signer, RPC, and IPFS access; the deployment-scope question remains unanswered.

## Surprises & Discoveries

- Existing `node/` daemons import legacy `agent/` infrastructure. Kernel code explicitly excludes that dependency direction. A separate package under `node/production/` lets this runtime install and run independently.
- `createTransactionPreparer` already reads chain, nonce, gas, and fee data. The host only needs a signing adapter. Its documentation requires serialization through receipt observation and reconciliation of ambiguous submissions.
- `publishAndLogSignedMessage` does not persist intermediate progress. The host can compose `publishSignedMessage` and `logCid` to save the CID before signing, and wrap the transaction preparer to save signed bytes before broadcasting.
- Deployment target is pending user input. Local Anvil and an isolated Kubo repository provide a complete validation path without external credentials.
- Foundry's script target is relative to the invoking working directory even with `--root contracts`: use `contracts/script/DeployLogger.s.sol:DeployLogger` from the repository root. An initial smoke failed before deployment with `No such file or directory`; the corrected smoke passed.
- The kernel's raw-transaction duplicate recovery applies to retries within one invocation. Host restart recovery must first inspect an existing receipt and handle an already-known rebroadcast by observing the retained hash. This is implemented locally in `node/production/src/publication.mjs`.
- The sandbox blocks loopback listeners and some dependency downloads. Dependency setup and HTTP/local integration tests required command escalation; all were run successfully after access was granted.
- HTTP connection shutdown alone does not prove a disconnected client's publication finished. The host explicitly waits for the publication lifecycle before releasing its state lock.

## Decision Log

- Decision: Add an independent ESM Node package at `node/production/`, importing all hardened libraries through package roots. Rationale: runtime wiring belongs in host code, and installing it must not require the legacy agent. Date/Author: 2026-09-07 / Codex.
- Decision: Serialize accepted publication work and persist signed transactions before submission. Rationale: one dedicated node account needs nonce coordination, and retrying retained signed bytes supports recovery without creating new transactions. Date/Author: 2026-09-07 / Codex.
- Decision: Validate against real Anvil and Kubo first while the user chooses deployment scope. Rationale: provides observable end-to-end evidence without guessing a public chain or funded account. Date/Author: 2026-09-07 / Codex.
- Decision: Complete and leave running the local milestone while deployment scope is unanswered. Rationale: the local flow is fully usable, and choosing a public chain or accessing funds requires concrete environment details. Date/Author: 2026-09-07 / Codex.
- Decision: Name the standalone runtime directory `node/production/`. Rationale: the directory identifies the intended production node, while `packages/` contains its hardened kernel dependencies and older daemons remain experimental. Existing operational limitations remain documented. Date/Author: 2026-09-07 / Codex.

## Outcomes & Retrospective

The local milestone is implemented and running. Seven host tests and eight Logger contract tests pass, as do contract formatting and `git diff --check`. A real smoke deployed Logger, published/retrieved signed JSON through Kubo, checked Logger events, deduplicated requests, recovered both prepared and mined transactions, and rejected concurrent new work. The final smoke leaves Anvil, offline Kubo, and the actual node CLI running; its health check returned success after CLI startup. CI now installs the standalone runtime and runs its host tests after checking package build freshness. No public network deployment has been attempted because its chain, credentials, and hosting are not selected.

Remaining limitations are explicit in `node/production/README.md`: a dedicated single-process signer, one in-flight publication, local durable journal without a repair API, operator handling of stale crash locks and persistently unresolved transactions, and receipt verification without additional confirmation depth. Public hosting and integration-specific verification remain separate work.

The runtime now lives under `node/production/`, distinguishing its intended role from the experimental daemons. CI, docs, CLI startup, and ignore rules use that path. Package dependencies and their relative paths did not change. The rename passed all seven runtime tests plus the full local deployment/publication/recovery smoke and CLI health check. The temporary stack used for rename validation was stopped afterward.

## Context and Orientation

`packages/messages` authenticates EIP-191 signatures over exact ASCII text. Its ingress function takes raw HTTP-shaped data; it does not own a server. `packages/ipfs` publishes deterministic message JSON using a Kubo-compatible API and returns a canonical CID (content identifier). `packages/ethereum` prepares, submits, and verifies Logger transactions; signing remains the host's responsibility. `contracts/src/Logger.sol` emits `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` and stores no history. The node address in the event is the account calling Logger, distinct from the agent who signs text.

`node/production/` will own configuration, an HTTP adapter, a local-key signer, durable state, startup, tests, and local smoke tooling. `contracts/script/DeployLogger.s.sol` will own contract deployment. No kernel package functionality or agent-specific behavior needs to change.

## Plan of Work

First implement the host and configuration. Require expected chain ID, Logger address, signer allowlist, RPC and IPFS endpoints, and a dedicated node signing key loaded from environment. Use bounded request buffering and timeouts. Authenticate before side effects. Return publication metadata only after a successful checked Logger receipt.

Save each authenticated operation under a stable identifier in a private state directory. Persist the message, published CID, and prepared signed transaction before each subsequent irreversible stage. Permit only one lifecycle at a time. On restart, resume incomplete records using retained signed bytes; do not allocate another nonce while an earlier signed transaction is unresolved. Prevent two processes sharing a state directory. Report partial failures with safe identifiers rather than provider errors or secrets.

Next add deployment tooling local to `contracts/` and document startup, health, posting signed messages, and recovery. Finally run focused host tests and a real isolated Anvil/Kubo smoke flow: deploy Logger, start node, send signed message, fetch its IPFS bytes, inspect Logger receipt, submit a duplicate, and restart to verify persistence.

## Concrete Steps

Run commands from the repository root:

    npm --prefix packages ci
    npm --prefix packages run build
    npm --prefix node/production ci
    npm --prefix node/production test
    forge fmt --root contracts
    forge build --root contracts --sizes
    forge test --root contracts --offline -vv
    npm --prefix node/production run smoke:local
    npm --prefix node/production run smoke:local -- --keep-running

The local smoke script uses Anvil, offline Kubo, and a temporary directory without touching the operator's existing IPFS repository. The last command keeps the validated stack running until SIGINT/SIGTERM. Exact operator startup and deployment commands are in `node/production/README.md` and `contracts/README.md`. Dependency installation and loopback sockets require network escalation in this workspace.

## Validation and Acceptance

Acceptance requires a genuine signed HTTP request producing retrievable IPFS JSON and a successful Logger event with the exact CID and configured node address. Invalid signatures, non-allowlisted signers, oversized requests, and wrong methods must cause no publication or transaction. Duplicate submissions must reuse the stored result. Concurrent requests must not allocate colliding nonces. Persisted prepared transactions must survive restart and resume without a new signature. Startup must reject a mismatched chain or missing Logger bytecode.

Local deployment uses disposable funded Anvil accounts. Public deployment requires an explicitly selected network, suitable RPC endpoint, funded deployment/node signer, IPFS provider, and host details. Do not infer these from unrelated deployment examples or print private keys. Local success alone is not evidence of public deployment.

## Idempotence and Recovery

Builds and tests are repeatable. The local smoke uses isolated directories and processes. Normal duplicate message requests return the original publication result; they do not create another event. Persisting a prepared transaction before submission allows exact-byte rebroadcast after uncertain transport failures. A pending or unrecoverable signed transaction blocks later signing until reconciled. The signer must be dedicated to this runtime; the state-directory process lock does not coordinate other hosts or unrelated users of the same account. Retain the state directory across restarts. Logger deployment creates a new contract each time; record and reuse a successful deployed address.

## Artifacts and Notes

Commands in this plan use the current `node/production/` location. The earlier local deployment artifacts below were recorded before the directory rename; their historical temporary paths, addresses, and hashes are preserved.

Rename validation used `npm --prefix node/production test` and `npm --prefix node/production run smoke:local -- --keep-running`. Both passed; the temporary smoke stack was stopped after confirming CLI startup. Its evidence is recorded at `/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-local-SE5wvZ/evidence.json`. Logger was deployed at `0x70d927deff90141ec1d5eed5aa4231e764fa13f9` on that disposable Anvil chain.

Initial successful smoke evidence: `/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-local-BoC2F7/evidence.json`. That isolated chain has stopped. Logger address was `0x6fda21f1158b344477dfec3218519b0e9bb5b7f5`; deployment transaction `0xb83fa27a3141ac916dcec0539027afb11c184bca568f0edfee4661edee05cdc4`; first message log transaction `0x830d5b5382cd93ab115154d3be67ab5d731dff614e118e634a117f21328543bb`; CID `bafkreifnizzetmyn3uayctnsn6ozym6m5xj7tf57cbl7pay2phvigpzqua`. Each smoke generates different accounts and ports. Record the final running stack separately. Secret material must never appear in this document.

Final running local stack, started 2026-09-07 using `npm --prefix node/production run smoke:local -- --keep-running`:

- Node: `http://127.0.0.1:61723`; health: `GET /healthz`; message ingress: `POST /v1/messages`.
- Anvil RPC: `http://127.0.0.1:61720`, chain ID `31337`.
- Offline Kubo API: `http://127.0.0.1:61721`.
- Logger: `0xe4b379e76e212dda440ac0066c4015aaaff0c0ac`.
- Deployment transaction: `0x2634f7173348c092ecd1880d36e8e5b4b79ab20a1347d119da483ffbc1c6903b`.
- Node account: `0x9F9cE079a054E80Bca11F0EB1D9972eb2bC9061e`.
- Allowlisted agent: `0x516eA222a1Faf1FC1A3Af1b78ddc0aB0f1A4c96A`.
- First logged CID: `bafkreiaxso6ixj6pjt6i2t4huuqxk2sivq2beqgehqzwdgldvhvq7ezon4`.
- First Logger transaction: `0x29454ea33a5cbf921c36470db0fb84187395e6d08ca14ebbe9b75b2968bdcdae`.
- Prepared-transaction recovery hash: `0xbd83d554a3244e502021e6277094574b10a2920c0a5071a8650e7bf4452a55d9`.
- Artifacts: `/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-local-flMwF0/` contains `evidence.json`, `config.json`, process logs, `state/`, isolated `ipfs/`, and a private local-only `.env`.

The running command is attached to execution session `84445`. Stop it with SIGINT/Ctrl-C to shut down all its children. These endpoints last only while that local process is running; Anvil state is disposable. To recreate the stack later, rerun the keep-running command and use the newly printed endpoints and evidence.

## Interfaces and Dependencies

Public kernel imports: `createSignedMessageAuthorizer`, `handleSignedMessage`, `publishSignedMessage`, `createIpfsConfig`, `createHttpConfig`, `createTransactionPreparer`, `logCid`, and `requestEthereumJsonRpc`. The host signing adapter will use ethers and return `{ rawTransaction, transactionHash }` without broadcasting. The runtime uses built-in Node HTTP, filesystem, and crypto modules. Operators provide an EIP-1559 RPC endpoint and a Kubo-compatible IPFS API. Foundry deployment loads a deployment key from the environment. The node uses a separate explicit environment variable for its signing key.
