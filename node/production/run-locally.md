# Run a live node locally

Run Oya and Kubo on your own computer, mini PC, or other local device. Agents send signed messages to an HTTPS inbox backed by PostgreSQL. Your node polls using outbound requests, so it needs no public IP address, router forwarding, tunnel, or inbound message endpoint. The inbox and PostgreSQL can be hosted wherever you choose, together or separately.

For agent-managed setup, secure credential handoff, and optional macOS Keychain-backed worker startup, see [Deploy with an agent](deploy-with-agent.md). The commands below use persistent protected runtime files; the Keychain helper replaces the worker token's storage and startup lifecycle.

Messages remain queued while the local device is asleep or offline. `202` means the inbox saved the job; check its status for publication. This guide uses the published [node-v0.3.0 image and deployment bundle](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.0), which support both modes below. Released v0.2.0 images do not contain the inbox or worker. For an existing v0.2.0 installation or local-only clients, use the [advanced direct HTTP guide](run-direct.md).

| Mode | Completed job | Local requirements |
| --- | --- | --- |
| IPFS-only (`ipfs`) | `published`, with CID | Kubo; no Ethereum RPC, node transaction key, or gas |
| Full (`ledger`) | `logged`, with CID and transaction hash | Kubo, Ethereum RPC, deployed Ledger, funded dedicated node key |

Both modes verify signatures and enforce allowlists at the inbox and again locally. Full mode uses an RPC provider; it does not synchronize an Ethereum full node. The inbox stores message content, signatures, progress, and prepared Ledger transaction bytes, but never needs the node private key. A local IPFS pin may be unavailable while the only device holding it is offline; arrange replication separately if continuous retrieval matters.

## 1. Prepare the image and private local directory

Use Docker Desktop on macOS or Docker Engine on Linux, Linux containers, Compose 2.30+, Bash or zsh, `curl`, and `tar`. Run as a non-root operator; no source checkout, host Node.js, or build tools are required. Keep Docker running and the device awake when you want it to process jobs. The release image is Linux amd64: ARM devices need amd64 emulation, such as Docker Desktop on Apple Silicon, or the [optional native source build](#optional-source-build).

These are first-install commands. Choose new bundle and private directories outside shared/cloud-synced folders. Stop if a command fails. If the directories already exist, use their saved settings and the [resume procedure](#monitor-stop-and-resume); do not overwrite configuration or regenerate keys. On the same device, the inbox and worker may share an already extracted public bundle while keeping separate private directories.

```sh
docker version
docker compose version
export OYA_BUNDLE_DIR="$HOME/oya-bundles/node-v0.3.0"
umask 077
mkdir -p "$(dirname "$OYA_BUNDLE_DIR")"
mkdir "$OYA_BUNDLE_DIR"
curl -fL \
  https://github.com/oyaprotocol/oya-commitments/releases/download/node-v0.3.0/oya-node-v0.3.0.tar.gz \
  -o "$OYA_BUNDLE_DIR/oya-node-v0.3.0.tar.gz"
tar -xzpf "$OYA_BUNDLE_DIR/oya-node-v0.3.0.tar.gz" -C "$OYA_BUNDLE_DIR"
export OYA_NODE_IMAGE="$(cat "$OYA_BUNDLE_DIR/node/production/image.txt")"
export OYA_NODE_PLATFORM=linux/amd64
docker pull --platform "$OYA_NODE_PLATFORM" "$OYA_NODE_IMAGE"
```

The bundle's `image.txt` selects the immutable image digest; public downloads need no GHCR login. See the [release reference and checksum](release-image.md#published-deployment-release). Preserve archive permissions with `tar -xzpf` so public bind-mounted files stay readable under `umask 077`. Use this guide with the release's Compose assets; the documentation inside the v0.3.0 archive still describes the earlier source-build workflow.

In the same terminal, create the private local directory and select the worker Compose file:

```sh
export OYA_LOCAL_DIR="$HOME/oya-private/local-inbox-node"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export COMPOSE_PROJECT_NAME=oya-local-inbox
export COMPOSE_FILE="$OYA_BUNDLE_DIR/node/production/inbox/compose.worker.yaml:$OYA_LOCAL_DIR/image.yaml"
umask 077
mkdir -p "$(dirname "$OYA_LOCAL_DIR")"
mkdir -m 700 "$OYA_LOCAL_DIR"
cat > "$OYA_LOCAL_DIR/image.yaml" <<'YAML'
services:
  node:
    platform: ${OYA_NODE_PLATFORM:?Set OYA_NODE_PLATFORM}
YAML
```

The override selects the Oya image's platform. Kubo uses its native platform. Keep the bundle location and project name stable; the project owns the IPFS volume. Step 3 saves these settings for later terminals.

Define a helper to run the bundled client:

```sh
oya_client() {
  docker run --rm --platform "$OYA_NODE_PLATFORM" --user "$OYA_CONTAINER_USER" \
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

Create an empty private environment file. No node account, RPC, contract, or funding is needed:

```sh
touch "$OYA_LOCAL_DIR/node.env"
```

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

Follow [Host the PostgreSQL inbox](host-inbox.md) in a separate terminal on your chosen host, then return to this local-worker terminal. Keep separate terminals even if both roles run on one device, because they select different Compose projects and private directories. The inbox supports bundled PostgreSQL or an existing managed/private database. It needs the same target, agent allowlist, and mode. Full mode also requires the public node address, chain ID, and Ledger address. The database binds the target to these execution settings.

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
{
  printf 'export OYA_BUNDLE_DIR=%q\n' "$OYA_BUNDLE_DIR"
  printf 'export OYA_NODE_IMAGE=%q\n' "$OYA_NODE_IMAGE"
  printf 'export OYA_NODE_PLATFORM=%q\n' "$OYA_NODE_PLATFORM"
  printf 'export OYA_LOCAL_DIR=%q\n' "$OYA_LOCAL_DIR"
  printf 'export OYA_CONTAINER_USER=%q\n' "$OYA_CONTAINER_USER"
  printf 'export COMPOSE_PROJECT_NAME=%q\n' "$COMPOSE_PROJECT_NAME"
  printf 'export COMPOSE_FILE=%q\n' "$COMPOSE_FILE"
} > "$OYA_LOCAL_DIR/compose.env"
chmod 600 "$OYA_LOCAL_DIR/compose.env"
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 120
```

The container UID/GID must read the mode-0600 mounts. Copied secrets must belong to the local operator UID used by the worker; retain mode 0600. An unhealthy worker can indicate an inaccessible inbox, mismatched token/identity, or a publication retry; inspect its logs. If ports conflict with an existing node, choose `OYA_HTTP_PORT` and `OYA_IPFS_PORT` before startup and save those exports in `compose.env` too. Stop an old signer before starting a worker using that account.

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

In a new terminal, load the saved settings first (adjust the path if you chose a different directory). Define the `oya_client` function from step 1 again when sending messages.

```sh
source "$HOME/oya-private/local-inbox-node/compose.env"
docker compose logs -f --tail 100 node
docker stats
curl -fsS http://127.0.0.1:8787/healthz
docker compose stop
docker compose start
```

Stop the foreground log or stats viewer with Ctrl-C to run the next command. Use your chosen health port if you changed `OYA_HTTP_PORT`.

Logs show idle, claim, IPFS publication, pending Ledger transaction, result, and retry events with request IDs and public results. They omit message bodies, tokens, keys, RPC credentials, and raw transaction bytes. Health reports role, mode, activity, last inbox poll, and completions since startup. Port 8787 is monitoring-only in worker mode. `docker stats` shows CPU, memory, network, and disk I/O. Closing the log viewer does not stop the node.

The worker and Kubo restart with Docker unless deliberately stopped. Sleep suspends processing while the independently hosted inbox keeps receiving jobs. Preserve the IPFS volume: `down --volumes` deletes it. Back up IPFS data, settings, keys, and PostgreSQL separately.

One target executes one job at a time. Transient failures retry; ten attempts before a transaction checkpoint produce `failed`. Once a transaction is saved, unknown outcomes remain `processing` with `awaiting_reconciliation` and block later jobs. Recovery checks its receipt and can resend the same signed bytes. It never selects a new nonce or replaces fees automatically. Investigate the saved hash, RPC, funding, and fees; do not delete the row or submit another ID to clear it. A mined revert is terminal. Missing/malformed Ledger events remain unresolved. Results use receipt verification without additional finality confirmations.

For upgrades, stop the worker, retain the target/database/IPFS volume/secrets, and extract the new release into a new bundle directory. Review migration notes, update `OYA_BUNDLE_DIR`, `OYA_NODE_IMAGE` from its `image.txt`, the platform, and `COMPOSE_FILE` in the saved `compose.env`, then source it. Keep the project name and private directory unchanged. Run `docker compose config --quiet`, `docker compose pull`, and `docker compose up -d --wait --wait-timeout 120` to recreate the worker. `docker compose start` alone does not apply an image update. Pending work resumes from PostgreSQL. Stop all workers before a database restore or migration; an older backup can lose transaction checkpoints and replay protection. Reconcile transactions before resuming. Changing mode, chain, contract, or node account requires a new target after reconciling the old one. Do not share a Ledger account across targets or direct nodes. Moving devices also requires transferring IPFS storage or arranging replication.

To migrate from direct HTTP, stop senders, drain active work, reconcile uncertain transactions, and stop the old node. Requests are not automatically imported. Preserve its IPFS volume: explicitly map the worker's `ipfs-data` to the existing volume or copy the repository before switching. Create a new inbox target; never let the old HTTP signer and new worker run concurrently with the same key.

## Optional source build

For a native build or an unreleased reviewed revision, replace the download/pull block in step 1 with the following commands from the repository root. Then continue with the private-directory setup and remaining steps. The same preparation can be used on the inbox host before its private-directory setup. The release bundle contains deployment assets rather than build inputs, so this option requires a source checkout.

```sh
docker build -t oya-node:local node/production
export OYA_BUNDLE_DIR="$PWD"
export OYA_NODE_IMAGE=oya-node:local
export OYA_NODE_PLATFORM="$(docker image inspect oya-node:local --format '{{.Os}}/{{.Architecture}}')"
```

For this locally built image, replace `docker compose pull` with `docker compose pull ipfs` on the worker or `docker compose pull postgres proxy` on an inbox host with the bundled database (`docker compose pull proxy` for an external database). This pulls only the supporting services. Keep using the Compose files from the same checkout as the build.
