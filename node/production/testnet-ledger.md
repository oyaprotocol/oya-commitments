# Testnet Ledger acceptance

Use this checklist after review to demonstrate the existing inbox → IPFS → Ledger workflow. This is not permission to deploy or broadcast. The receipt-identity hardening described here must be in the reviewed image/revision being tested; older releases do not acquire it merely by following this guide.

## Establish inputs before starting

The normal Sepolia target is **chain `11155111`, Ledger `0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3`**. See the [canonical deployed-Sepolia reference](README.md#deployed-sepolia-ledger) for the exact source/runtime match evidence and default RPC `https://ethereum-sepolia-rpc.publicnode.com`. No new deployment is required. That read-only identity check is not evidence of successful signed-message publication or a testnet acceptance run. The public RPC has no availability guarantee; use it only if operator-approved or supply another approved Sepolia endpoint. Published v0.3.1 assets predate the new target defaults, so explicitly configure them when using older compatible runtimes, and do not assume those images contain later receipt hardening.

Record, privately, explicit operator authorization to broadcast on the selected Ethereum testnet, its expected chain ID and approved RPC, the Ledger address and evidence that it is the intended deployment, the dedicated node's public address, and the reviewed image digest/commit. Supply its signing key through the existing protected local secret file, not chat, command-line arguments or Git. Use testnet-only funds and separate agent/deployer accounts. Never share the node signing account with another worker or direct runtime.

Follow [Run locally](run-locally.md) and [Host the inbox](host-inbox.md) for a **separate test installation**, selecting Ledger mode in both roles and the same target, chain, contract, node address and allowlist. Use separate Compose projects, storage, private settings and nonconflicting loopback ports. Do not change an existing IPFS-only target: its execution identity is persisted in PostgreSQL. Do not enable macOS Local Network permission as part of this test.

The worker checks `eth_chainId` and nonempty code at the configured address before preparing or reconciling transactions. Nonempty code is not proof of the Ledger implementation: review the [recorded source/runtime verification](README.md#verification-evidence) for the default target, or independently verify a different deployment before funding/testing. A matching chain ID is not authentication of the RPC; use a trusted operator-approved endpoint. The existing [deployment/reuse workflow](README.md#deploy-ledger-on-sepolia) is only for an optional new/separate deployment with its own authorization. Do not guess addresses or deploy a replacement automatically. Inbox execution must match the worker's real public node address; it cannot infer one, and its host must never receive the node private key.

## Offline validation first

From a source checkout at the repository root, without keys or running RPC/IPFS/database services (dependency installation requires registry access):

```sh
npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
node --test node/production/test/inbox-ledger.test.mjs node/production/test/inbox.test.mjs
npm --prefix node/production test
```

The focused tests use real signing and kernel parsing with mock RPC/IPFS and simulated checkpoint storage. They cover inconsistent receipt identities, receipt/event rejection, retry, duplicate-broadcast reconciliation, timeout/restart, authorization and chain/code checks. They are not a PostgreSQL or live-chain demonstration. Run the existing `npm --prefix node/production run test:inbox` and `test:inbox:docker` integration workflows in the documented development environment for real local storage/chain coverage; see [testing by area](../../docs/testing.md).

## Controlled live acceptance

Only after all operator inputs and broadcast authorization are established, use the `oya_client` helper and private mounts from [Run locally](run-locally.md#4-submit-and-track-a-message). Replace the example origin and `ledger-test` with the approved test inbox and target. Prepare an innocuous, nonsecret ASCII message in `/private/message.txt` using that guide's private-directory mapping.

```sh
oya_client prepare /private/agent-key ledger-test /private/message.txt /private/ledger-job.json
oya_client submit https://inbox.example.com /private/ledger-job.json
oya_client status https://inbox.example.com /private/ledger-job.json
```

Poll status without preparing another job. `202` is only durable acceptance; a CID proves only the IPFS step; a transaction hash is not proof of submission or mining. Acceptance requires all of:

1. Job status `logged`, with the expected CID and transaction hash.
2. A successful receipt for that exact hash on the approved chain, from the dedicated node to the approved Ledger, with no contract-creation address. Preserve block number/hash and event index in private evidence.
3. A nonremoved `Log(address,bytes32,string)` event emitted by that Ledger, with the node address, exact CID and matching Keccak-256 CID-string hash. The kernel additionally checks log/receipt transaction and block consistency. Inspect the receipt using the approved RPC or testnet explorer, not a hash alone.
4. Retrieve the signed JSON from the configured Kubo (`ipfs cat <cid>` using its repository), and verify its exact message and agent signature. A local pin does not prove independent replication.
5. Resubmit **the same saved job file**, then read status: the same job/CID/hash must return without a second transaction. New request IDs authorize new work and gas expenditure.
6. For offline delivery, stop only the isolated test worker, submit a second harmless job, confirm `queued`, restart it and confirm `logged` with its own receipt. Preserve its database and IPFS volume. Do not deliberately interrupt the running production node or delete checkpoints to simulate recovery.

There is no additional confirmation-depth/finality guarantee; record observation time and follow the team's reorg policy before relying on an outcome. No testnet demonstration should be reported without actual receipts and retrieval evidence.

## Failure and recovery

A matching, verified reverted receipt becomes terminal `failed` with `transaction_reverted`, never `logged`. A receipt with inconsistent sender/destination/creation metadata is unresolved even if it says reverted. Missing, malformed or mismatched Ledger events likewise cannot complete the job. The worker requests retry; a saved transaction remains available for reconciliation, which can block later jobs for that target.

After a timeout, duplicate/nonce error or worker restart, recovery checks the saved hash and may rebroadcast the **same** signed bytes. It does not select a new nonce or raise fees. Inspect RPC health, saved hash, fees and testnet balance; never delete the row, switch identities or prepare a replacement ID to clear uncertainty. Lost checkpoint acknowledgments are also retried from durable state. Exercise these failures in the mock/local-chain suite rather than spending testnet funds to manufacture them.

Rollback: stop the isolated worker, retain database/checkpoints, IPFS volume and secrets, and reconcile any saved transaction before selecting another reviewed image. No schema migration is required. Keep RPC credentials, raw transaction bytes and private file layouts out of public evidence. Report missing authorization/configuration, absent tools and unrun checks explicitly rather than marking acceptance complete.
