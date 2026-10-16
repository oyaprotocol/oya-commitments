# Run a live node locally

Run Oya and Kubo on your own computer, mini PC, or other local device. Agents send signed messages to an HTTPS inbox backed by PostgreSQL. Your node polls using outbound requests, so it needs no public IP address, router forwarding, tunnel, or inbound message endpoint. The inbox and PostgreSQL can be hosted wherever you choose, together or separately.

Messages remain queued while the local device is asleep or offline. `202` means the inbox saved the job; check its status for publication. This feature requires a **new image built from this source revision**. Released v0.2.0 images do not contain the inbox or worker. Until an inbox-capable release is published, build locally as shown below. For an existing v0.2.0 installation or local-only clients, use the [advanced direct HTTP guide](run-direct.md).

| Mode | Completed job | Local requirements |
| --- | --- | --- |
| IPFS-only (`ipfs`) | `published`, with CID | Kubo; no Ethereum RPC, node transaction key, or gas |
| Full (`ledger`) | `logged`, with CID and transaction hash | Kubo, Ethereum RPC, deployed Ledger, funded dedicated node key |

Both modes verify signatures and enforce allowlists at the inbox and again locally. Full mode uses an RPC provider; it does not synchronize an Ethereum full node. The inbox stores message content, signatures, progress, and prepared Ledger transaction bytes, but never needs the node private key. A local IPFS pin may be unavailable while the only device holding it is offline; arrange replication separately if continuous retrieval matters.

## 1. Prepare the image and private local directory

Use Docker Desktop on macOS or Docker Engine on Linux, Linux containers, Compose 2.30+, and Bash or zsh. Run from the repository root as a non-root operator. Keep Docker running and the device awake when you want it to process jobs.

```sh
docker version
docker compose version
docker build -t oya-node:local node/production
export OYA_NODE_IMAGE=oya-node:local
export OYA_LOCAL_DIR="$HOME/oya-private/local-inbox-node"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export COMPOSE_PROJECT_NAME=oya-local-inbox
export COMPOSE_FILE="$PWD/node/production/inbox/compose.worker.yaml"
umask 077
mkdir -p "$(dirname "$OYA_LOCAL_DIR")"
mkdir -m 700 "$OYA_LOCAL_DIR"
```

Choose a new directory outside the checkout and shared/cloud-synced folders. If it already exists, reuse its settings; do not regenerate keys. Save these exports in a private shell file for later terminals, including the absolute Compose path and stable project name, which owns the IPFS volume. For a future release, extract the matching bundle, select its `node/production/inbox/compose.worker.yaml`, set `OYA_NODE_IMAGE` from `image.txt`, and pull instead of building. An amd64 release needs emulation on Apple Silicon; a source build uses the native platform.

Define a helper to run the bundled client:

```sh
oya_client() {
  docker run --rm --user "$OYA_CONTAINER_USER" \
    --mount "type=bind,src=$OYA_LOCAL_DIR,dst=/private" \
    --entrypoint node "$OYA_NODE_IMAGE" /app/src/inbox/client.mjs "$@"
}
oya_client keygen /private/agent-key
```

Record the printed public agent address. The private key is written only to `agent-key` with mode 0600 and is not mounted into the worker. Existing agents can use an existing key with the new signed envelope. Choose a target such as `my-node`; use the same name throughout both guides.

## 2. Configure one execution mode

For **IPFS-only**, create `$OYA_LOCAL_DIR/node.json`, replacing the agent placeholder:

```json
{
  "mode": "ipfs",
  "host": "0.0.0.0",
  "port": 8787,
  "allowedSigners": ["AGENT_ADDRESS"],
  "ipfsUrl": "http://ipfs:5001"
}
```

Create a readable empty `$OYA_LOCAL_DIR/node.env` using `touch`. No node account, RPC, contract, or funding is needed.

For **full Ledger mode**, use this `node.json` instead. Replace all placeholders and verify the contract on your selected chain. Sepolia is useful for testing without mainnet funds; [deploy or verify Ledger](README.md#deploy-ledger-on-sepolia) separately if needed.

```json
{
  "mode": "ledger",
  "host": "0.0.0.0",
  "port": 8787,
  "allowedSigners": ["AGENT_ADDRESS"],
  "ipfsUrl": "http://ipfs:5001",
  "chainId": 11155111,
  "rpcUrl": "https://YOUR_RPC_ENDPOINT",
  "ledgerContract": "LEDGER_ADDRESS",
  "receiptTimeoutMs": 60000,
  "operationTimeoutMs": 180000,
  "gasLimit": 200000,
  "maxFeePerGasWei": "30000000000"
}
```

Generate a separate node account with `oya_client keygen /private/node-key` and record/fund its public address. In a trusted local editor, create `node.env` containing `OYA_NODE_PRIVATE_KEY=` followed by the contents of `node-key`. Use literal, unquoted `KEY=value` lines. Optional complete headers are `OYA_RPC_AUTHORIZATION` and `OYA_IPFS_AUTHORIZATION`. Never use the worker's node account in another transaction-sending process. Keep agent and deployer keys separate.

```sh
chmod 600 "$OYA_LOCAL_DIR/node.json" "$OYA_LOCAL_DIR/node.env"
```

## 3. Host and connect the inbox

Follow [Host the PostgreSQL inbox](host-inbox.md) on your chosen host. It supports bundled PostgreSQL or an existing managed/private database. It needs the same target, agent allowlist, and mode. Full mode also requires the public node address, chain ID, and Ledger address. The database binds the target to these execution settings.

Copy only the generated `worker-secrets.json` from that setup into `$OYA_LOCAL_DIR` over a trusted channel. This is a shared worker token; the local node does not need the database password. Create `$OYA_LOCAL_DIR/worker.json`:

```json
{
  "url": "https://inbox.example.com",
  "target": "my-node",
  "pollIntervalMs": 5000
}
```

Use your actual HTTPS inbox origin and target. HTTP is allowed only at loopback for testing. For an inbox on the same computer as a Docker worker, use HTTPS with a hostname reachable from that container; its `127.0.0.1` refers to the container itself.

```sh
chmod 600 "$OYA_LOCAL_DIR/worker.json" "$OYA_LOCAL_DIR/worker-secrets.json"
docker compose config --quiet
docker compose up -d --wait --wait-timeout 120
```

The container UID/GID must read the mode-0600 mounts. Preserve ownership when copying secrets instead of making them world-readable. An unhealthy worker can indicate an inaccessible inbox, mismatched token/identity, or a publication retry; inspect its logs. If ports conflict with an existing node, choose `OYA_HTTP_PORT` and `OYA_IPFS_PORT` before startup. Stop an old signer before starting a worker using that account.

## 4. Submit and track a message

On the agent's device, with the helper above:

```sh
printf '%s\n' 'Hello from my locally hosted Oya node.' > "$OYA_LOCAL_DIR/message.txt"
oya_client prepare /private/agent-key my-node /private/message.txt /private/job.json
oya_client submit https://inbox.example.com /private/job.json
oya_client status https://inbox.example.com /private/job.json
```

`prepare` saves a signed request with a random ID and a 24-hour submission/start deadline. It refuses to overwrite an existing file. Retry **the same job file** after a failed submission or lost response. Preparing another ID authorizes another job, including another Ledger transaction. Status reads require the saved signed envelope, even after its deadline. Keep the file private until you intend to publish its contents.

To verify offline delivery, run `docker compose stop node`, prepare a different job file, submit it, and observe `queued`. Run `docker compose start node`; that job becomes `published` or `logged`. Unstarted jobs become `expired` on a worker claim after their deadline. Started jobs continue recovery after the deadline. The old hourly agent uses the synchronous API; use it only with the [direct profile](run-direct.md). New senders use this client or the [inbox API](inbox-api.md).

## Monitor, stop, and resume

```sh
docker compose logs -f --tail 100 node
docker stats
curl -fsS http://127.0.0.1:8787/healthz
docker compose stop
docker compose start
```

Logs show idle, claim, IPFS publication, pending Ledger transaction, result, and retry events with request IDs and public results. They omit message bodies, tokens, keys, RPC credentials, and raw transaction bytes. Health reports role, mode, activity, last inbox poll, and completions since startup. Port 8787 is monitoring-only in worker mode. `docker stats` shows CPU, memory, network, and disk I/O. Closing the log viewer does not stop the node.

The worker and Kubo restart with Docker unless deliberately stopped. Sleep suspends processing while the independently hosted inbox keeps receiving jobs. Preserve the IPFS volume: `down --volumes` deletes it. Back up IPFS data, settings, keys, and PostgreSQL separately.

One target executes one job at a time. Transient failures retry; ten attempts before a transaction checkpoint produce `failed`. Once a transaction is saved, unknown outcomes remain `processing` with `awaiting_reconciliation` and block later jobs. Recovery checks its receipt and can resend the same signed bytes. It never selects a new nonce or replaces fees automatically. Investigate the saved hash, RPC, funding, and fees; do not delete the row or submit another ID to clear it. A mined revert is terminal. Missing/malformed Ledger events remain unresolved. Results use receipt verification without additional finality confirmations.

For upgrades, stop the worker, retain the target/database/IPFS volume/secrets, select a reviewed image, and recreate it. Pending work resumes from PostgreSQL. Stop all workers before a database restore or migration; an older backup can lose transaction checkpoints and replay protection. Reconcile transactions before resuming. Changing mode, chain, contract, or node account requires a new target after reconciling the old one. Do not share a Ledger account across targets or direct nodes. Moving devices also requires transferring IPFS storage or arranging replication.

To migrate from direct HTTP, stop senders, drain active work, reconcile uncertain transactions, and stop the old node. Requests are not automatically imported. Preserve its IPFS volume: explicitly map the worker's `ipfs-data` to the existing volume or copy the repository before switching. Create a new inbox target; never let the old HTTP signer and new worker run concurrently with the same key.
