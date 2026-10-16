# Run a local node with the direct HTTP API (advanced)

For the default deployment, use [Run a live node locally](run-locally.md): a local worker receives external messages through a PostgreSQL inbox. This older direct-HTTP guide remains useful for local-only clients and existing v0.2.0 installations. It has no durable queue and accepts messages only while the computer is online.

Run the production node and Kubo locally with Docker Compose, persistent IPFS storage, and an optional hourly message agent. This guide uses the published **v0.2.0 Linux amd64 image** in either mode:

| Mode | Successful publication | Additional requirements |
| --- | --- | --- |
| `ipfs` | Pins the signed message to IPFS and returns its CID and URI | No Ethereum connection or node transaction key |
| `ledger` (full mode, also the default) | Publishes to IPFS, then logs the CID onchain and verifies the receipt/event | Ethereum RPC, verified Ledger contract, and a funded node signing account |

Full mode uses an RPC provider; it does not synchronize an Ethereum full node. Both modes verify agent signatures and enforce the signer allowlist. The Ledger example below uses Ethereum Sepolia for a live test without spending mainnet ETH. Agents need signing keys but no gas funds; the Ledger node pays transaction gas.

The API stays at `http://127.0.0.1:8787`, available to clients on your local computer. Kubo joins the public IPFS network. No domain, HTTPS proxy, cloud account, or LLM API key is required for this setup. The [Droplet installer](deploy-droplet.md) is for a remote Linux host and is not used here.

## Prerequisites and availability

- macOS with Docker Desktop, or Linux with Docker Engine; use Linux containers and Compose **2.30 or newer**. Commands below use Bash or zsh, `curl`, and `tar`, as a non-root user. Check `docker version` and `docker compose version` with Docker running.
- The published v0.2.0 image is amd64. Apple Silicon uses Docker Desktop's amd64 emulation; both native arm64 source builds and amd64 emulation passed the runtime integration checks. This guide selects amd64 explicitly for the node and agent. Kubo uses its native platform. A source build is an alternative in the [Compose guide](README.md#run-with-docker-compose).
- Keep Docker running and the host computer awake and online during service. Sleep, network changes, or stopping Docker interrupt availability. On laptops, closing the lid may suspend service. The node and hourly agent require deliberate startup after Docker or the host computer restarts.
- Allow disk space for Docker and growing pinned content. Keep keys/configuration outside the checkout and shared or cloud-synced folders. Preserve the Docker volume when upgrading or restarting.
- A local pin retains content on this computer; it does not arrange permanent replicas elsewhere. If this is the only available copy, content may be unreachable while the host computer is offline. See [IPFS persistence](https://docs.ipfs.tech/concepts/persistence/).

Use this guide for a first installation. Stop if a command fails. If the chosen directories or Compose project already exist, use their saved settings and the [resume procedure](#stop-and-resume); do not repeat first-time configuration or overwrite keys.

## 1. Download the matching release files

Run on your local computer. These example directories are outside the source checkout; choose different locations before starting if needed.

```sh
export OYA_LOCAL_BUNDLE="$HOME/oya-bundles/node-v0.2.0"
export OYA_LOCAL_DIR="$HOME/oya-private/local-v0.2.0"

mkdir -p "$(dirname "$OYA_LOCAL_BUNDLE")" "$(dirname "$OYA_LOCAL_DIR")"
mkdir "$OYA_LOCAL_BUNDLE"
umask 077
mkdir -m 700 "$OYA_LOCAL_DIR"
mkdir -m 700 "$OYA_LOCAL_DIR/agent-private"

curl -fL \
  https://github.com/oyaprotocol/oya-commitments/releases/download/node-v0.2.0/oya-node-v0.2.0.tar.gz \
  -o "$OYA_LOCAL_BUNDLE/oya-node-v0.2.0.tar.gz"
tar -xzpf "$OYA_LOCAL_BUNDLE/oya-node-v0.2.0.tar.gz" -C "$OYA_LOCAL_BUNDLE"
chmod -R a+rX "$OYA_LOCAL_BUNDLE/node" "$OYA_LOCAL_BUNDLE/agent-library"
cat "$OYA_LOCAL_BUNDLE/node/production/image.txt"
```

The `-p` flag preserves archived permissions even with `umask 077`. The v0.2.0 archive itself has owner-only permissions, so the `chmod` step also makes its public configuration and agent source readable by containers running under a different UID. Apply it only to the two extracted public trees shown above. Keep `$OYA_LOCAL_DIR` and its keys private; leave `umask 077` in effect for subsequent configuration files. Newer bundles have public file permissions recorded in the archive and need only `tar -xzpf`.

The [v0.2.0 release](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.2.0) pins:

```text
ghcr.io/oyaprotocol/oya-node@sha256:560714a91cbb438e43bc8f0e0854d9e01b76eb304a673d8f13d56822a687fa81
```

Keep the bundle and private directory in these locations. The commands below record their absolute paths. The bundle supplies Compose files and agent source; Node.js and ethers run inside the image, so the host computer needs neither npm dependencies nor a Node.js installation. Deploying a new Ledger contract separately requires the tools described in the Ledger deployment guide.

## 2. Save the local Compose settings

Create a private settings file that can be sourced in later terminals:

```sh
{
  printf 'export OYA_LOCAL_BUNDLE=%q\n' "$OYA_LOCAL_BUNDLE"
  printf 'export OYA_LOCAL_DIR=%q\n' "$OYA_LOCAL_DIR"
  cat <<'ENV'
export OYA_CONFIG_FILE="$OYA_LOCAL_DIR/node.json"
export OYA_ENV_FILE="$OYA_LOCAL_DIR/node.env"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export OYA_NODE_IMAGE="$(cat "$OYA_LOCAL_BUNDLE/node/production/image.txt")"
export OYA_TEST_AGENT_IMAGE="$OYA_NODE_IMAGE"
export OYA_TEST_AGENT_SOURCE="$OYA_LOCAL_BUNDLE/agent-library/agents/hourly-message-test"
export OYA_TEST_AGENT_DIR="$OYA_LOCAL_DIR/agent-private"
export OYA_HTTP_PORT=8787
export OYA_STOP_GRACE_PERIOD=4m
export OYA_TEST_AGENT_TIMEOUT_MS=210000
export COMPOSE_PROJECT_NAME=oya-local
export COMPOSE_FILE="$OYA_LOCAL_BUNDLE/node/production/compose.yaml:$OYA_LOCAL_DIR/image.yaml:$OYA_LOCAL_BUNDLE/node/production/docker/compose.testing.yaml"
export COMPOSE_PROFILES=testing
ENV
} > "$OYA_LOCAL_DIR/compose.env"

cat > "$OYA_LOCAL_DIR/image.yaml" <<'YAML'
services:
  node:
    build: !reset null
    image: ${OYA_NODE_IMAGE:?Source compose.env first}
    platform: linux/amd64
    pull_policy: never
  test-agent:
    platform: linux/amd64
    pull_policy: never
YAML

chmod 600 "$OYA_LOCAL_DIR/compose.env" "$OYA_LOCAL_DIR/image.yaml"
source "$OYA_LOCAL_DIR/compose.env"
docker pull --platform linux/amd64 "$OYA_NODE_IMAGE"
```

The public image requires no GHCR login. The override disables local builds and keeps the node and agent on the same digest. The `oya-local` project has separate storage from the Droplet guide's `oya` project. Keep its name stable. If port 8787 is occupied, change `OYA_HTTP_PORT` in `compose.env`, source it again, and use that port for local requests; keep `port: 8787` inside the node JSON.

The testing profile makes the helper service available. It will not run the hourly sender until the explicit command in step 6: startup commands select only `ipfs` and `node`.

## 3. Choose one node mode

Run **one** of the following configuration paths. The initially empty allowlist is filled by step 4 before starting the node; an empty allowlist is never accepted at normal startup.

### IPFS-only mode

```sh
cat > "$OYA_CONFIG_FILE" <<'JSON'
{
  "mode": "ipfs",
  "host": "0.0.0.0",
  "port": 8787,
  "allowedSigners": [],
  "ipfsUrl": "http://ipfs:5001"
}
JSON

: > "$OYA_ENV_FILE"
chmod 600 "$OYA_CONFIG_FILE" "$OYA_ENV_FILE"
```

The empty `node.env` is a required readable mount, not a missing credential. No node wallet, RPC endpoint, contract, or funding is needed. Do not include `chainId`, `ledgerContract`, `rpcUrl`, `receiptTimeoutMs`, `pollIntervalMs`, `gasLimit`, or `maxFeePerGasWei` in this mode. Continue to step 4.

### Full mode: IPFS plus Ledger

Obtain a Sepolia RPC endpoint and the address of a verified Oya Ledger contract on that chain. If you need to deploy one, follow [Deploy Ledger on Sepolia](README.md#deploy-ledger-on-sepolia) from a source checkout first; the release bundle has no contract source or deployment CLI. Keep that separate deployer key out of the running node.

Create the node configuration, then replace both placeholders in a trusted editor before starting:

```sh
cat > "$OYA_CONFIG_FILE" <<'JSON'
{
  "mode": "ledger",
  "host": "0.0.0.0",
  "port": 8787,
  "chainId": 11155111,
  "ledgerContract": "REPLACE_WITH_VERIFIED_LEDGER_ADDRESS",
  "allowedSigners": [],
  "rpcUrl": "https://REPLACE_WITH_SEPOLIA_RPC_ENDPOINT",
  "ipfsUrl": "http://ipfs:5001"
}
JSON
chmod 600 "$OYA_CONFIG_FILE"
```

Create a separate node transaction key directly in `node.env`. This command has no network access, prints only the public address, and refuses to overwrite an existing secrets file:

```sh
docker run --rm -i --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$OYA_CONTAINER_USER" \
  --mount "type=bind,src=$OYA_LOCAL_DIR,dst=/setup" \
  --entrypoint node "$OYA_NODE_IMAGE" --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
const wallet = Wallet.createRandom();
await writeFile('/setup/node.env', 'OYA_NODE_PRIVATE_KEY=' + wallet.privateKey + '\n',
    { flag: 'wx', mode: 0o600 });
console.log('Fund this Sepolia node address: ' + wallet.address);
NODE
```

Fund the printed address with Sepolia ETH and confirm the balance before publishing. See the [Sepolia funding instructions](README.md#create-and-fund-a-dedicated-testnet-deployer), using the **node address printed above**, not a new deployer account. Each accepted publication spends the node's gas, including repeated messages. Do not use this signing account in another process or node.

If the RPC needs an authorization header, add a literal `OYA_RPC_AUTHORIZATION=...` line in `node.env` with a trusted editor. Keep URL tokens in private `node.json`. The secrets file accepts unquoted, literal values; do not source it as shell code. The only supported entries are `OYA_NODE_PRIVATE_KEY`, `OYA_RPC_AUTHORIZATION`, and `OYA_IPFS_AUTHORIZATION`.

Full mode also supports other configured chains, but the bundled demo initializer accepts only Sepolia (`11155111`) and disposable Anvil (`31337`). For another chain, provide your own nonempty signer allowlist and client, skip the demo initializer/hourly sender, and use [Submit a message](README.md#submit-a-message) for that client's signed request. A Docker RPC URL must be reachable from the container: `127.0.0.1` there refers to the container, not the host computer. A host RPC on Docker Desktop can use `host.docker.internal` if the host service allows that connection.

## 4. Create and authorize the message agent

For the IPFS-only or Sepolia walkthrough, run this with the node stopped. It creates `agent-private/key`, preserves it on subsequent initialization, and appends its public address to `node.json`. It does not create or fund the Ledger node account.

```sh
docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$OYA_CONTAINER_USER" \
  --mount "type=bind,src=$OYA_TEST_AGENT_SOURCE,dst=/app/test-agent,readonly" \
  --mount "type=bind,src=$OYA_TEST_AGENT_DIR,dst=/setup" \
  --mount "type=bind,src=$OYA_CONFIG_FILE,dst=/config/node.json" \
  --entrypoint node "$OYA_NODE_IMAGE" \
  /app/test-agent/agent.mjs init /setup/key /config/node.json
```

Agent keys are private local state and are not part of the image or release. Keep the node and agent keys separate. The JSON binds to `0.0.0.0` **inside** Docker, while the Compose host binding exposes the API only on host loopback. Kubo's administrative API and gateway are not published to the host; its peer port 4001 is published on TCP and UDP.

## 5. Validate settings and start the node

Check Compose and validate the actual private mounts/configuration before starting services. This validation makes no RPC calls or transactions:

```sh
docker compose config --quiet
docker compose run --rm --no-deps -T --entrypoint node node --input-type=module -e '
import { loadConfig } from "./src/config.mjs";
import { loadSecrets } from "./src/secrets.mjs";
import { createLocalSigner } from "./src/signer.mjs";
try {
  const secrets = await loadSecrets("/run/secrets/node.env");
  const config = await loadConfig("/config/node.json", secrets);
  if (config.mode === "ledger") createLocalSigner(secrets.OYA_NODE_PRIVATE_KEY);
  console.log("Private settings are readable and valid for " + config.mode + " mode.");
} catch {
  console.error("Check private file access, config, allowlist, and the Ledger node key.");
  process.exitCode = 1;
}
'

docker compose pull ipfs
docker compose up -d --no-build --pull never --wait --wait-timeout 180 ipfs node
docker compose ps
curl -fsS "http://127.0.0.1:$OYA_HTTP_PORT/healthz"
```

IPFS mode should report `{"status":"ready","mode":"ipfs","busy":false}`. Ledger health also includes the chain ID, Ledger address, and node address. Ledger startup checks the RPC chain and contract bytecode; it does not prove gas funding or that arbitrary bytecode implements Ledger. Health is not a continuous IPFS/RPC connectivity check.

Inspect startup problems with `docker compose logs --tail=100 node ipfs`. If private mounts fail, check Docker Desktop file sharing and file ownership; retain mode 0600 instead of making keys world-readable. Other local IPFS installations may already occupy peer port 4001.

## 6. Publish and verify a signed message

Generate a signed request with the authorized agent, using a one-off container. This does not start the hourly loop or submit a transaction:

```sh
docker compose run --rm --no-deps -T --entrypoint node test-agent --input-type=module -e '
import { readFile } from "node:fs/promises";
import { Wallet } from "ethers";
const wallet = new Wallet((await readFile("/run/test-agent/key", "utf8")).trim());
const text = `Local publication check ${new Date().toISOString()}`;
console.log(JSON.stringify({text, signer: wallet.address, signature: await wallet.signMessage(text)}));
' > "$OYA_LOCAL_DIR/message.json"
```

Submit from the host computer through the loopback API. This step publishes public content and, in Ledger mode, spends gas:

```sh
curl --fail-with-body --show-error --max-time 210 \
  -H 'Content-Type: application/json' \
  --data-binary @"$OYA_LOCAL_DIR/message.json" \
  "http://127.0.0.1:$OYA_HTTP_PORT/v1/messages"
```

Expect HTTP 200 and top-level `status: "published"` in IPFS mode, or `status: "logged"` in Ledger mode. Both return `publication.cid` and `publication.uri`. Ledger also returns `publication.transactionHash`, `blockNumber`, `nodeAddress`, and `ledgerContract`; inspect the transaction and Ledger event on the configured chain (for this example, [Sepolia Etherscan](https://sepolia.etherscan.io/)). A lost response is not proof that nothing happened. In Ledger mode, reconcile the transaction before retrying or restarting an unavailable node; repeating the request can spend gas again.

Copy the returned CID, then retrieve the envelope locally and through a separate public gateway:

```sh
export OYA_MESSAGE_CID='REPLACE_WITH_RETURNED_CID'
docker compose exec -T ipfs ipfs cat "/ipfs/$OYA_MESSAGE_CID"
curl -fL --max-time 120 "https://ipfs.io/ipfs/$OYA_MESSAGE_CID"
```

Compare `text`, `signer`, and `signature` with `message.json`. The first command verifies your stored bytes; the gateway request tests availability beyond your local Kubo. Discovery can take time. Home NAT, ISP restrictions, VPNs, and host firewalls can interfere: inspect `docker compose exec -T ipfs ipfs swarm peers` and the [IPFS NAT/port-forwarding guide](https://docs.ipfs.tech/how-to/nat-configuration/). A successful local pin alone does not prove internet retrieval.

Optionally start the hourly sender after the manual check:

```sh
docker compose up -d --no-deps --no-build --pull never test-agent
docker compose logs --tail=20 test-agent
```

It sends immediately and then approximately once per hour, logging `test_message_published` (IPFS) or `test_message_logged` (Ledger). Each Ledger submission costs gas. It stops after an unconfirmed result and does not retry or automatically restart. Stop it with `docker compose stop test-agent`; the node remains available for other authorized clients. Restarting the sender starts a new immediate publication and hourly schedule.

## Stop and resume

Load the saved settings in each new terminal. Use your chosen private directory if different. Existing installations should keep their saved settings, original directories, and Compose project name; changing the project name selects a different IPFS volume:

```sh
source "$HOME/oya-private/local-v0.2.0/compose.env"
docker compose ps
docker compose logs --tail=100 node
docker stats --no-stream
```

For planned shutdown, stop the sender first, then drain node work while IPFS stays available, then stop IPFS:

```sh
docker compose stop test-agent
docker compose stop node
docker compose stop ipfs
```

After sleep, a crash, or Docker restart, inspect logs and health. In Ledger mode, reconcile any pending or unknown transaction before restarting: restart clears the in-memory unavailable flag but does not recover receipts or resolve nonces. Only run one process using the node signing account. Once it is appropriate to resume:

```sh
docker compose up -d --no-build --pull never --wait --wait-timeout 180 ipfs node
curl -fsS "http://127.0.0.1:$OYA_HTTP_PORT/healthz"
```

Start `test-agent` separately only if you want hourly publication again. Preserve `agent-private/key`, `node.env`, `node.json`, saved Compose settings, the release bundle, and the `oya-local_ipfs-data` volume. `docker compose down` preserves that volume; **`down --volumes` deletes it**. A Docker Desktop reset or removal of its data can also destroy the repository. For a cold IPFS backup, stop the sender and node first and follow [Back up and restore IPFS](README.md#back-up-and-restore-ipfs), retaining this guide's Compose environment/project. Keep protected copies of both private settings and the IPFS backup on another device; the IPFS backup contains Kubo's private identity.

Keep the default `operationTimeoutMs` (180000), node stop grace (4m), and agent deadline (210000) unless deliberately changing all related settings. The agent deadline must allow the operation plus 30 seconds; node stop grace must allow the operation plus at least 60 seconds. See [deadline relationships](README.md#receive-messages-over-https) if adding a proxy.

To switch modes on an existing node, stop the agent and drain the node first. In Ledger mode resolve any uncertain transaction. Preserve storage and the agent allowlist; add or remove the mode-specific settings and node key deliberately, validate as in step 5, then restart. Do not rerun first-install commands or replace an existing signing key.

## Accepting messages from other machines

This guide deliberately keeps message ingress on host loopback. Remote agents need a separately configured reachable HTTPS endpoint. Follow [Receive messages over HTTPS](README.md#receive-messages-over-https) for Caddy, DNS, router/firewall access, and deadlines, or configure a suitable authenticated tunnel. Keep signature/allowlist checks and the private Kubo API intact. An HTTP tunnel does not by itself make Kubo's peer port reachable or replicate IPFS content. Host sleep and network changes still affect availability; validate both external signed submission and independent IPFS retrieval.
