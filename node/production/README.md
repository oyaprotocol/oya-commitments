# Oya production node

This standalone runtime accepts an agent's signed text, publishes the signed JSON to IPFS, and submits its CID to Logger using the node's own account. A `202` response includes the CID, transaction hash, block number, and node address after the kernel verifies a successful receipt and the matching Logger event.

The runtime imports `@oyaprotocol/messages`, `@oyaprotocol/ipfs`, and `@oyaprotocol/ethereum` through their package roots. It has no dependency on the legacy agent runner or node daemons. Reimbursement verification, Safe proposals, and DeFi actions are later milestones.

## Install and validate

Use Node 22 or newer, npm, Foundry, and Kubo/IPFS for the local smoke. From the repository root:

```sh
git submodule update --init lib/forge-std
npm --prefix packages ci
npm --prefix packages run build
npm --prefix node/production ci
npm --prefix node/production test
forge build --root contracts --sizes
forge test --root contracts --offline -vv
npm --prefix node/production run smoke:local
```

The smoke starts isolated Anvil and offline Kubo processes on loopback ports, deploys Logger through `contracts/script/DeployLogger.s.sol`, and exercises real signed HTTP requests. It checks IPFS retrieval, Logger receipts, rejected signatures, duplicates, concurrent submissions, and restart recovery both before broadcast and after mining. It also rejects startup on a wrong chain or missing contract. It stops its services when finished and prints a temporary directory containing `evidence.json` and service logs.

To leave a working local stack running:

```sh
npm --prefix node/production run smoke:local -- --keep-running
```

This prints the actual node URL, RPC URL, IPFS URL, Logger address, and state directory. The temporary `.env` contains generated local-only node and agent keys with mode `0600`; the keys are not printed. The local chain is disposable, and offline Kubo makes content available through its local API only. Press Ctrl-C to stop all three services.

## Configure and start

Copy `config.example.json` to the ignored `config.local.json`. Replace the example Logger and agent addresses with your deployment and allowlisted signer addresses. Set `chainId`, `rpcUrl`, and `ipfsUrl` for the intended environment. `ipfsUrl` must be a Kubo-compatible API, with `/api/v0/add` support; a read-only gateway or unrelated pinning API is insufficient.

The node account must have gas funds and be dedicated to one runtime. The agent signing key is distinct; it does not need gas to sign a message. Store `OYA_NODE_PRIVATE_KEY` in the ignored `node/production/.env`, or inject it through your process supervisor. Optional `OYA_RPC_AUTHORIZATION` and `OYA_IPFS_AUTHORIZATION` contain complete HTTP Authorization header values. Keep RPC URLs containing credentials in private local config too.

From the repository root:

```sh
node --env-file=node/production/.env node/production/src/main.mjs node/production/config.local.json
curl http://127.0.0.1:8787/healthz
```

Alternatively, with environment variables already loaded:

```sh
npm --prefix node/production start -- /absolute/path/to/config.json
```

Config paths in `stateDir` are relative to the config file. Keep that directory across restarts and on a filesystem that supports atomic rename and fsync. Startup checks the RPC chain and deployed bytecode, checks the state directory's chain/Logger/account identity, acquires its process lock, and attempts to resume an unfinished publication before serving traffic.

`host` defaults to `127.0.0.1`, and `port` to `8787`. To host it remotely, choose the binding explicitly and provide HTTPS through your hosting environment. Other optional settings are `maxBodyBytes` (16,384), `maxTextBytes` (8,192), `bodyTimeoutMs` (10,000), `receiptTimeoutMs` (60,000), `pollIntervalMs` (1,000), `gasLimit` (200,000), and `maxFeePerGasWei` (decimal string, default 30,000,000,000). Gas and fee values are ceilings; requests above them stop before signing. Transport attempts have a 10-second timeout and up to two kernel-managed retries. Transaction preparation has the kernel's 30-second deadline.

## Submit a message

`POST /v1/messages` accepts `Content-Type: application/json` and exactly:

```json
{ "text": "Your exact ASCII message", "signer": "0x...", "signature": "0x..." }
```

The signature must be EIP-191 over exactly `text`; the signer must be in `allowedSigners`. The node caps bytes while reading the HTTP stream, and the kernel validates JSON, message size, schema, signature, and authorization before publication. The signed text should contain any context that its readers need; this first runtime does not interpret commitment-specific fields.

Put ASCII text in a file, load the agent's key as `OYA_AGENT_PRIVATE_KEY`, and run:

```sh
node --env-file=node/production/.env node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt
```

The script signs the complete file, including any final newline. A successful response looks like:

```json
{
  "status": "accepted",
  "signer": "0x...",
  "publication": {
    "messageId": "...",
    "status": "logged",
    "cid": "bafk...",
    "uri": "ipfs://bafk...",
    "transactionHash": "0x...",
    "blockNumber": "2",
    "nodeAddress": "0x...",
    "loggerContract": "0x..."
  }
}
```

Retrieve the original signed JSON with `ipfs cat <cid>` against the relevant Kubo repository, or `POST <ipfsUrl>/api/v0/cat?arg=<cid>`. Logger's indexed node address identifies the node transaction signer, while the JSON retains the agent's separate signature.

## Persistence and recovery

The node publishes each pair of case-insensitive signer address and exact text once per state directory. A repeated valid request returns its original result even if the signature encoding or address casing differs. To record a new observation, sign new text (for example, include an observation ID). The original accepted envelope is retained on IPFS.

One new publication may be active at a time. Another new request receives `503` with `node_busy`; retry it later. A valid duplicate of a completed publication remains available during other work. Publication failures return `503` with `publication_incomplete` and any known CID/hash. Provider responses and secret-bearing errors are not returned to clients.

Each operation is saved before IPFS upload, after publication, and after signing but before broadcast. A successful result is saved after receipt verification. If an operation is incomplete, other new messages receive `recovery_required` until it is reconciled. Retry the original signed message to resume, or restart the node to attempt recovery automatically. Retained signed bytes are reused. An already-mined receipt is verified without another broadcast. A successful response means mined execution as reported by the configured RPC; it does not claim additional confirmations or protection against later chain reorganizations.

`GET /healthz` reports `ready` or `recovery_required`, plus whether work is active and its message ID. It describes local lifecycle state; it is not a continuous RPC/IPFS health probe. A missing signature, invalid signature, disallowed signer, wrong method, or oversized request never produces a publication.

SIGINT/SIGTERM stops accepting requests and drains active work before releasing `runtime.lock`. Following a hard crash, inspect `runtime.lock` (hostname, PID, start time), confirm that process is no longer running, and remove only the stale lock before restarting. Do not delete transaction records to clear a pending operation: the transaction may already be onchain. Persistent reverted transactions, missing events, fee problems, or external nonce use require operator investigation. This first runtime does not implement replacement transactions, automatic fee bumping, or a repair API. Avoid using the same account from another process or host; the local lock cannot coordinate them.

The journal is operator-owned data and grows with accepted messages. Back it up and retain it for the lifetime of the node identity. IPFS content is public once published, including the signed text. Logger accepts opaque CID claims; consumers still verify retrieved content and the agent signature.
