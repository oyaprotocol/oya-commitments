# Host the PostgreSQL inbox

The inbox is a small Oya HTTP service backed by ordinary PostgreSQL. Host it on a VM, a container platform, a home server with reachable HTTPS, or another location you control. PostgreSQL can be in the same Compose stack or on a separate self-hosted/managed service. The local Oya worker needs only outbound HTTPS to the inbox, with no tunnel or direct database access. This guide replaces cloud-hosted node deployment as the default architecture.

The inbox stores signed message bodies, job status, and transaction checkpoints. Treat its database and worker token as trusted infrastructure. A database administrator can alter execution state; this is not an untrusted queue protocol. Keep node, deployer, and agent private keys off this host. PostgreSQL contains prepared signed Ledger transactions, which can be broadcast, but cannot authorize other transactions without the node key.

## Prepare the host

Use Linux Docker/Compose 2.30+ and Bash or zsh for the supplied example. You need a DNS hostname pointing to the inbox host and inbound TCP 80/443 for Caddy. Restrict administrative access through your normal host controls. Do not expose PostgreSQL port 5432 publicly. Only the local node runs Kubo or holds a funded signing key.

Build the image from the reviewed checkout on this host:

```sh
docker build -t oya-node:local node/production
export OYA_NODE_IMAGE=oya-node:local
export OYA_INBOX_DIR="$HOME/oya-private/inbox"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export OYA_PUBLIC_HOSTNAME=inbox.example.com
export COMPOSE_PROJECT_NAME=oya-inbox
export COMPOSE_FILE="$PWD/node/production/inbox/compose.yaml:$PWD/node/production/inbox/compose.postgres.yaml:$PWD/node/production/inbox/compose.https.yaml"
umask 077
mkdir -p "$(dirname "$OYA_INBOX_DIR")"
mkdir -m 700 "$OYA_INBOX_DIR"
cp node/production/inbox/inbox.example.json "$OYA_INBOX_DIR/inbox.json"
```

Use your actual hostname and a new directory outside the checkout. Save the exports in a private shell file for later operation. The project name must remain stable because it owns database and TLS volumes. If this is an existing installation, reuse its secrets and configuration instead of repeating initialization. Released v0.2.0 images lack the inbox; do not substitute that release. Once an inbox-capable release exists, use the matching bundle and its `image.txt` digest instead of building, adjusting the Compose paths to the bundle.

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
docker run --rm --network none --user "$OYA_CONTAINER_USER" \
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

For **your own PostgreSQL service**, omit `compose.postgres.yaml` from `COMPOSE_FILE`. Use a dedicated empty database and account allowed to create and update its own tables and indexes. PostgreSQL 17 is covered by the integration tests. Generate the files above, then edit only `databaseUrl` in `inbox-secrets.json` to the supplied connection URL; the unused `postgres-password` file is not mounted without the overlay. Percent-encode special characters in URL passwords. Keep `databaseTls: true` for remote databases. Do not add URL query options such as `sslmode`: they are rejected to prevent overriding TLS verification.

If your provider uses a private CA, add `"databaseCaFile": "/run/secrets/postgres-ca.pem"` to `inbox.json`, mount that CA file read-only with a private Compose override, and add the override to `COMPOSE_FILE`. Otherwise the standard trusted CAs are used. Verify hostname and certificate validity. Use the provider's direct PostgreSQL endpoint or a session-compatible connection service that supports transactions and schema creation. The app keeps up to five connections per inbox process, uses parameterized queries, and requires durable database commits. Do not disable PostgreSQL `fsync` or use asynchronous failover that may lose acknowledged transaction checkpoints.

## Start and check

```sh
docker compose config --quiet
docker compose up -d --wait --wait-timeout 120
docker compose logs -f --tail 100 inbox
curl -fsS http://127.0.0.1:8788/healthz
```

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

Stop all workers before moving or restoring the database. An older snapshot can omit a transaction that was already broadcast and thereby lose replay protection. Reconcile chain activity and checkpoints before resuming; never clear unknown transactions by deleting rows. For a host migration, stop workers, take a final consistent backup, restore it, move the inbox configuration/token, update DNS or worker URL, verify status, then resume one worker. Preserve the target and its execution identity. Back up/move IPFS storage separately when moving the local node.

The [historical Droplet guide](deploy-droplet.md) is retained for existing installations. New deployments should host only this inbox/database infrastructure remotely, with Oya execution and keys on the local device.
