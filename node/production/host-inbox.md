# Host the PostgreSQL inbox

The inbox is a small Oya HTTP service backed by ordinary PostgreSQL. Host it on a VM, a container platform, a home server with reachable HTTPS, or another location you control. PostgreSQL can be in the same Compose stack or on a separate self-hosted/managed service. The local Oya worker needs only outbound HTTPS to the inbox, with no tunnel or direct database access. This guide replaces cloud-hosted node deployment as the default architecture.

To have an agent provision and verify this setup using secure credential references, start with [Deploy with an agent](deploy-with-agent.md). Provider tokens and application runtime secrets have separate storage and access requirements.

The inbox stores signed message bodies, job status, and transaction checkpoints. Treat its database and worker token as trusted infrastructure. A database administrator can alter execution state; this is not an untrusted queue protocol. Keep node, deployer, and agent private keys off this host. PostgreSQL contains prepared signed Ledger transactions, which can be broadcast, but cannot authorize other transactions without the node key.

This guide uses the published [node-v0.3.1 image and deployment bundle](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.1). Use the same release for the [local worker](run-locally.md). v0.2.0 images support only the direct API and cannot serve an inbox.

## Prepare the host

Use Linux Docker/Compose 2.30+, Bash or zsh, `curl`, and `tar` as a non-root operator. The published Oya image is Linux amd64; an ARM host needs amd64 emulation or an [optional native source build](run-locally.md#optional-source-build). You need a DNS hostname pointing to the inbox host and inbound TCP 80/443 for Caddy. Restrict administrative access through your normal host controls. Do not expose PostgreSQL port 5432 publicly. Only the local node runs Kubo or holds a funded signing key.

Use a separate terminal from the local worker, including when both roles share a device. Download and extract the public bundle on this host; no source checkout or build tools are required. These are first-install commands: choose new directories and stop if a command fails. If this host already has the matching bundle from the local-worker setup, set the bundle/image/platform exports below to those existing values instead of downloading it again.

```sh
docker version
docker compose version
export OYA_BUNDLE_DIR="$HOME/oya-bundles/node-v0.3.1"
umask 077
mkdir -p "$(dirname "$OYA_BUNDLE_DIR")"
mkdir "$OYA_BUNDLE_DIR"
curl -fL \
  https://github.com/oyaprotocol/oya-commitments/releases/download/node-v0.3.1/oya-node-v0.3.1.tar.gz \
  -o "$OYA_BUNDLE_DIR/oya-node-v0.3.1.tar.gz"
```

Before extracting, run `shasum -a 256 "$OYA_BUNDLE_DIR/oya-node-v0.3.1.tar.gz"` on macOS or `sha256sum "$OYA_BUNDLE_DIR/oya-node-v0.3.1.tar.gz"` on Linux. Compare the result with the archive SHA-256 in the [node-v0.3.1 release notes](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.1). Continue only if it matches.

```sh
tar -xzpf "$OYA_BUNDLE_DIR/oya-node-v0.3.1.tar.gz" -C "$OYA_BUNDLE_DIR"
export OYA_NODE_IMAGE="$(cat "$OYA_BUNDLE_DIR/node/production/image.txt")"
export OYA_NODE_PLATFORM=linux/amd64
docker pull --platform "$OYA_NODE_PLATFORM" "$OYA_NODE_IMAGE"
```

The image is pinned by digest in the bundle's `image.txt`; public downloads need no GHCR login. See the [release reference and checksum](release-image.md#published-deployment-release). The `-p` extraction flag preserves public file permissions under `umask 077`, including the Caddyfile mounted into the hardened proxy. Keep this guide, the Compose assets, and the image pin from the same release together.

In the same terminal, create private settings and select the inbox Compose files:

```sh
export OYA_INBOX_DIR="$HOME/oya-private/inbox"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export OYA_PUBLIC_HOSTNAME=inbox.example.com
export COMPOSE_PROJECT_NAME=oya-inbox
export COMPOSE_FILE="$OYA_BUNDLE_DIR/node/production/inbox/compose.yaml:$OYA_BUNDLE_DIR/node/production/inbox/compose.postgres.yaml:$OYA_BUNDLE_DIR/node/production/inbox/compose.https.yaml:$OYA_INBOX_DIR/image.yaml"
umask 077
mkdir -p "$(dirname "$OYA_INBOX_DIR")"
mkdir -m 700 "$OYA_INBOX_DIR"
cp "$OYA_BUNDLE_DIR/node/production/inbox/inbox.example.json" "$OYA_INBOX_DIR/inbox.json"
cat > "$OYA_INBOX_DIR/image.yaml" <<'YAML'
services:
  inbox:
    platform: ${OYA_NODE_PLATFORM:?Set OYA_NODE_PLATFORM}
YAML
```

Use your actual hostname and a new private directory outside shared/cloud-synced folders. The override selects the Oya image's platform; PostgreSQL and Caddy use their native platforms. Keep the bundle location and project name stable because the project owns database and TLS volumes. If this is an existing installation, source its saved `compose.env` instead of repeating initialization or regenerating secrets. Save the selected settings in the start step below, after choosing the database option.

Edit `inbox.json`. Set the target name and public agent allowlist from the [local guide](run-locally.md). Choose `execution: {"mode":"ipfs"}` for IPFS-only. For Ledger use:

```json
"execution": {
  "mode": "ledger",
  "chainId": 11155111,
  "ledgerContract": "LEDGER_ADDRESS",
  "nodeAddress": "PUBLIC_NODE_ADDRESS"
}
```

Replace placeholders with the worker's actual public settings. A target's execution identity is immutable in the database. Reconcile pending jobs before changing identity and use a new target for the new configuration. The worker rejects inbox jobs whose signatures or local allowlist do not match.

## Choose PostgreSQL hosting

For the bundled private-network PostgreSQL service, set `"databaseTls": false` in `inbox.json`; the default example requires verified TLS. Generate fresh database and worker credentials without printing them:

```sh
docker run --rm --network none --platform "$OYA_NODE_PLATFORM" --user "$OYA_CONTAINER_USER" \
  --mount "type=bind,src=$OYA_INBOX_DIR,dst=/private" \
  --entrypoint node "$OYA_NODE_IMAGE" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const password = crypto.randomBytes(32).toString("hex");
const workerToken = crypto.randomBytes(32).toString("base64url");
const save = (name, value) => fs.writeFileSync("/private/" + name, value, {mode: 0o600, flag: "wx"});
save("postgres-password", password + "\n");
save("inbox-secrets.json", JSON.stringify({databaseUrl: "postgres://oya:" + password + "@postgres:5432/oya", workerToken}) + "\n");
save("worker-secrets.json", JSON.stringify({workerToken}) + "\n");
'
chmod 600 "$OYA_INBOX_DIR/inbox.json"
```

Copy only `worker-secrets.json` to the operator's local node using a trusted channel. Protect it like a credential: it authorizes claiming jobs and reporting results. Keep database credentials exclusively on the inbox host. The initialization command refuses existing files; inspect partial output after a failure instead of overwriting existing credentials.

For **your own PostgreSQL service**, omit the bundled database overlay:

```sh
export COMPOSE_FILE="$OYA_BUNDLE_DIR/node/production/inbox/compose.yaml:$OYA_BUNDLE_DIR/node/production/inbox/compose.https.yaml:$OYA_INBOX_DIR/image.yaml"
```

Use a dedicated empty database and account allowed to create and update its own tables and indexes. PostgreSQL 17 is covered by the integration tests. Generate the files above, then edit only `databaseUrl` in `inbox-secrets.json` to the supplied connection URL; the unused `postgres-password` file is not mounted without the overlay. Percent-encode special characters in URL passwords. Keep `databaseTls: true` for remote databases. Do not add URL query options such as `sslmode`: they are rejected to prevent overriding TLS verification.

If your provider uses a private CA, add `"databaseCaFile": "/run/secrets/postgres-ca.pem"` to `inbox.json`, mount that CA file read-only with a private Compose override, and add the override to `COMPOSE_FILE`. Otherwise the standard trusted CAs are used. Verify hostname and certificate validity. Use the provider's direct PostgreSQL endpoint or a session-compatible connection service that supports transactions and schema creation. The app keeps up to five connections per inbox process, uses parameterized queries, and requires durable database commits. Do not disable PostgreSQL `fsync` or use asynchronous failover that may lose acknowledged transaction checkpoints.

## Start and check

Save the selected image, paths, and database/HTTPS overlays for later terminals. If you chose custom ports or additional Compose overrides, save those settings here too.

```sh
{
  printf 'export OYA_BUNDLE_DIR=%q\n' "$OYA_BUNDLE_DIR"
  printf 'export OYA_NODE_IMAGE=%q\n' "$OYA_NODE_IMAGE"
  printf 'export OYA_NODE_PLATFORM=%q\n' "$OYA_NODE_PLATFORM"
  printf 'export OYA_INBOX_DIR=%q\n' "$OYA_INBOX_DIR"
  printf 'export OYA_CONTAINER_USER=%q\n' "$OYA_CONTAINER_USER"
  printf 'export OYA_PUBLIC_HOSTNAME=%q\n' "$OYA_PUBLIC_HOSTNAME"
  printf 'export COMPOSE_PROJECT_NAME=%q\n' "$COMPOSE_PROJECT_NAME"
  printf 'export COMPOSE_FILE=%q\n' "$COMPOSE_FILE"
} > "$OYA_INBOX_DIR/compose.env"
chmod 600 "$OYA_INBOX_DIR/compose.env"
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 120
curl -fsS http://127.0.0.1:8788/healthz
docker compose logs -f --tail 100 inbox proxy
```

Stop the foreground log viewer with Ctrl-C to continue. In a later terminal, run `source "$HOME/oya-private/inbox/compose.env"` first (adjust the path if needed), then use `docker compose stop` / `docker compose start` to stop or resume the existing stack. Use your chosen health port if you changed `OYA_INBOX_PORT`.

The inbox initializes its versioned tables on startup and refuses an existing target with different execution settings. Local health reports database connectivity. The public proxy intentionally exposes only `/v1/jobs`, `/v1/status`, and authenticated `/v1/worker/*`; `/healthz` is private. Each HTTP call is short: agents submit/status-check, and workers claim, renew, checkpoint, and complete. Blockchain waits run locally, outside any proxy request deadline. The default worker polls every five seconds; budget for that background traffic as well as messages.

Use the client in the local guide to submit while the worker is stopped, observe `queued`, start it, and observe `published` or `logged`. This proves the complete external path. On a container platform, deploy the same image with entrypoint `node /app/src/inbox/main.mjs` and arguments `/config/inbox.json /run/secrets/inbox.json`, mount the two files, and terminate HTTPS with your chosen platform. No Cloudflare, DigitalOcean, or other provider SDK is required.

## Retention, recovery, and migration

Capacity defaults to 10,000 retained jobs per target (`maxJobs`, configurable up to 1,000,000). New submissions receive 429 at capacity; exact duplicate jobs still return their existing status. Each message is at most 8 KiB of text and each API request at most 64 KiB. A shared 240 requests/minute public API limit includes rejected requests; add provider/proxy rate controls if needed. The worker API is authenticated separately. Sender signatures bind the target, ID, deadline, and message. A copied envelope cannot authorize a fresh job ID.

One job runs per target. Leases normally last 60 seconds and are renewed during work. Lease expiry makes the same in-progress job claimable again; it never lets later jobs bypass an unresolved Ledger transaction. CID and signed transaction checkpoints are immutable. Ten failed execution attempts before a transaction exists stop that job; after a transaction exists, recovery continues against the same hash. See the [API state and recovery details](inbox-api.md).

Keep terminal job records until after their signed expiry to prevent replay. The explicit prune command removes only terminal records whose deadline passed more than seven days ago:

```sh
docker compose run --rm --no-deps inbox /config/inbox.json /run/secrets/inbox.json prune
```

Schedule that command with your chosen scheduler if appropriate; it is not scheduled automatically. Pending/processing jobs are never pruned. Status becomes unavailable for pruned records, so archive completed results first if long-term history matters. Monitor database size, pending count, oldest job age, disk space, backups, and retry events. No automatic fee replacement, queue cancellation, or administration UI is included.

For the bundled database, create a private logical backup without placing credentials in arguments:

```sh
umask 077
docker compose exec -T postgres pg_dump -U oya -d oya -Fc > /absolute/private/backup/oya-inbox.dump
```

Use a real private backup location and check the command exit status. Back up settings and credentials separately and test restoration into an isolated database. Provider backups are also suitable if they preserve the required recovery point. Never delete `postgres-data` during an update. Changing `postgres-password` on disk does not rotate an already initialized PostgreSQL account; rotate the database account and connection secret together.

For an upgrade, review the new release's migration notes and stop workers before updating the inbox. Extract its bundle into a new directory, update the bundle path, `image.txt` digest, platform, and Compose paths in the saved `compose.env`, then source it. Retain the project name, private directory, selected database option, credentials, and volumes. Run `docker compose config --quiet`, `docker compose pull`, and `docker compose up -d --wait --wait-timeout 120`. Check inbox health and existing job status before resuming workers. Recreating containers applies the new image; `docker compose start` alone does not. An older image cannot undo an incompatible database migration.

Stop all workers before moving or restoring the database. An older snapshot can omit a transaction that was already broadcast and thereby lose replay protection. Reconcile chain activity and checkpoints before resuming; never clear unknown transactions by deleting rows. For a host migration, stop workers, take a final consistent backup, restore it, move the inbox configuration/token, update DNS or worker URL, verify status, then resume one worker. Preserve the target and its execution identity. Back up/move IPFS storage separately when moving the local node.

The [historical Droplet guide](deploy-droplet.md) is retained for existing installations. New deployments should host only this inbox/database infrastructure remotely, with Oya execution and keys on the local device.
