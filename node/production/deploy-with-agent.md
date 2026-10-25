# Deploy a local Oya node with an agent

Give your coding agent the task below. It can provision an inbox, configure the local worker, verify delivery, and leave a private operations record. You supply hosting authorization and access through a secure local mechanism. The default architecture runs Oya and Kubo locally, with an HTTPS inbox and PostgreSQL on a host you choose. No tunnel or inbound message port is needed on the local device.

```text
Read the repository's skills/deploy-node/SKILL.md and deployment guides.
Deploy an IPFS-only local Oya worker and a separately hosted PostgreSQL inbox.
Hosting: [existing SSH alias, or provider, region preference, and monthly budget].
Provisioning authorization: [whether you may create the specified paid resources].
Inbox hostname: [registered hostname].
Credentials: [Keychain item references or protected file paths; no secret values].
Inspect and preserve any existing installation. Use a matching released image
and bundle. Verify HTTPS, unauthorized access rejection, offline queuing,
publication, content retrieval, restart persistence, and backup restoration.
Leave private monitoring, restart, backup, recovery, and resource records.
Continue within this scope; ask only for missing access or scope changes.
```

The [repository skill](https://github.com/oyaprotocol/oya-commitments/blob/main/skills/deploy-node/SKILL.md) provides the agent workflow. Detailed configuration remains in [Run locally](run-locally.md) and [Host the inbox](host-inbox.md). This guide is also included in future deployment bundles; an older bundle can use the current repository instructions with its matching released assets.

## What you supply

| Input | IPFS-only deployment |
| --- | --- |
| Local device | Docker running, enough storage, permission to create private installation files |
| Inbox hosting | Existing Linux host with SSH access, or explicit provider and spending authorization |
| DNS | A registered hostname and permission to point it at the inbox host |
| Access | Credential references, an existing SSH identity, or authenticated provider tooling |
| Message senders | Existing public signer addresses, or permission to generate a local sender key |

For full Ledger mode, also supply the chain ID, verified Ledger address, RPC access, and a dedicated funded node account. Keep the node key local. Deploying a contract or spending blockchain funds needs its own established scope. IPFS-only requires no funded account, RPC service, or Ledger deployment.

One inexpensive experimental example is a Linode Nanode with 1 GiB RAM, bundled PostgreSQL, and a free DuckDNS hostname. The provider's plan API and [pricing](https://www.akamai.com/cloud/pricing/cpu) listed a $5/month base price on 2026-10-25, before taxes and usage overages. Recheck price and capacity before purchase. Paid backups and managed databases are additional choices. Measure memory, swap, disk, and queue behavior on the actual host before treating this size as adequate for a workload. An existing server, another VM provider, FreeDNS, or your own domain can use the same deployment assets.

For the Linode/DuckDNS example, gather only:

1. A short-lived Linode token with `linodes:read_write` and `firewall:read_write`, issued by an account allowed to provision those resources. Public plan, image, and region metadata needs no token. Supply a generated SSH public key directly at creation; account-profile key access is unnecessary.
2. A DuckDNS account token and an already reserved hostname. Its API updates an existing name; the agent cannot assume a token reserves a name.

Account signup, billing verification, MFA, and credential entry happen in your own trusted interfaces. Do not paste passwords, tokens, private keys, or database connection strings into chat.

## Keychain and runtime secrets are different

On macOS, store provisioning tokens as generic-password items in Keychain. In your own terminal, these commands prompt for each value without placing it in shell history. They create new items and do not overwrite existing entries:

```sh
/usr/bin/security add-generic-password -a oya-deploy -s oya-deploy-linode -T "" -w
/usr/bin/security add-generic-password -a oya-deploy -s oya-deploy-duckdns -T "" -w
```

Tell the agent the account and service names. An item saved only in the Passwords app is not necessarily available under these generic-password identifiers; use the explicit items above or another supported secure handoff. macOS may ask you to approve retrieval. The agent should capture the retrieval subprocess's output inside its provisioning program, make HTTPS requests there, and report sanitized results only. Never run a standalone secret-printing retrieval through an agent tool. Do not enable shell tracing, log authorization headers, or print API exception URLs. DuckDNS puts its token in the request URL; build that URL in memory and redact failures. Set its `ip` explicitly to the server address, not the local device's detected address.

The current released runtime reads application secrets from files:

| Secret | Location and use |
| --- | --- |
| Provider/DNS tokens | Keychain or another operator-selected credential store; provisioning only |
| SSH private key | Local protected key file or existing SSH agent; server administration |
| Sender key | Local protected file; the sender client signs messages; the worker does not mount it |
| Worker token | Protected files on both hosts; authorizes claiming work and reporting results |
| Database password | Inbox host only; PostgreSQL and inbox connection |
| Ledger node key, if used | Local runtime secret file; never needed by the inbox host |

Use mode 0700 for private directories and 0600 for secret files, outside Git and shared or cloud-synced folders. The worker mounts only its required files read-only. These permissions restrict other users; they do **not** provide Keychain encryption or approval prompts. Programs running as the owning account, host administrators, Docker administrators, and the authorized container can access the relevant files. Read-only mounting prevents container writes; it does not conceal the secret from the application. Disk encryption, when enabled, protects a locked device but not a running application with access.

For macOS operators who prefer Keychain, the current repository includes [keychain-worker.py](scripts/keychain-worker.py) and its [Compose overlay](inbox/compose.keychain-worker.yaml). They work with the v0.3.0 runtime but are not inside that older release bundle. Use a current checkout, or copy both files while preserving their sibling `scripts/` and `inbox/` directories. Python 3 is required on the host. The helper stores only the worker token in Keychain; sender/SSH keys and any Ledger runtime secrets retain their existing storage.

The helper's `store` command accepts `worker-secrets.json` through standard input and refuses to overwrite an existing Keychain item. An agent can capture the file over authenticated SSH and pipe its bytes directly to the helper, without a local plaintext copy. The helper uses [Apple's security tool stdin interface](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1), captures its output, and disables default application trust for the new item. Never put the token itself in the shell command. For example, with an existing trusted `inbox-host` SSH alias and the actual remote private path substituted:

```sh
set -o pipefail
ssh inbox-host 'cat /absolute/private/inbox/worker-secrets.json' |
  python3 node/production/scripts/keychain-worker.py store \
    --account oya-deploy --service oya-deploy-worker
```

After sourcing the local worker's private `compose.env`, use these commands instead of plain Compose startup/stop:

```sh
python3 node/production/scripts/keychain-worker.py start \
  --account oya-deploy --service oya-deploy-worker
python3 node/production/scripts/keychain-worker.py stop \
  --account oya-deploy --service oya-deploy-worker
```

At startup, macOS may request permission or unlocking. The helper creates a mode-0600 temporary file under the private installation's `.keychain-runtime` directory, mounts it read-only, and removes the host file after the worker is healthy. Docker and the worker may retain the mounted content/in-memory token until the container is removed. `stop` stops and removes only the worker container, preserving Kubo and volumes. The overlay disables automatic worker restart; use the helper after reboot or failure. Repeated `start` on a running helper-managed worker does not reread Keychain. If migrating an already running worker, stop it first; remove any obsolete persistent token file only after verifying the Keychain copy and preserving required recovery access.

Temporary disk storage is plaintext while present, and unlinking is not secure erasure. A forced termination during startup can leave the temporary file until the next helper operation; it remains restricted to the owner. The helper serializes operations, reclaims stale runtime files after removing the old worker container, cleans up failed starts, and reports if shutdown could not be confirmed. It does not weaken Keychain controls to permit unattended restart or promise that a running consumer cannot access its secret.

On other systems, use the operator's credential manager or protected files with equivalent permissions/ACLs. Avoid credentials in command arguments, Docker environment variables, generated Compose output, or committed configuration. Generate application credentials during deployment rather than asking the operator to gather them separately. Preserve existing credentials on retries.

## Work the agent performs

1. **Discover and record.** Read applicable repository instructions and maintain an ExecPlan for deployment across hosts. Inventory the selected Docker context, daemon architecture, relevant containers/volumes, ports, and installation directories. Read only necessary configuration fields; full environment and container dumps can expose secrets. Save private resource IDs, SSH identity, release, targets, paths, and completed steps so another session can resume.
2. **Verify the release.** Download the same archive on both hosts, compare the published SHA-256 before extraction, and check the immutable image reference. Follow the [release guide](release-image.md). Use `tar -xzpf` under `umask 077` to retain readable public assets. Set the container UID/GID to match private-file ownership. The v0.3.0 Oya image requires Linux amd64; inspect the Docker daemon architecture and use the documented platform override on ARM. Kubo can use its native image.
3. **Provision within scope.** Recheck provider price, region capacity, existing resource labels/IDs, and any paid add-ons before creation. After a timeout, query for an existing instance before retrying. Allow public TCP 80/443, restrict SSH to the operator's administration network, and leave PostgreSQL and health ports private. Verify the SSH host key through an authenticated provider channel; do not disable host-key verification. An authenticated cloud-init path can install a generated host key whose public half is pinned locally. Protect its private material and user data.
4. **Configure both roles.** Follow the two role guides. Match the target, signer allowlist, and execution identity. Generate database credentials on the inbox host and transfer only the worker credential to the local device over authenticated SSH. The worker setting is `url`, containing the HTTPS origin. Use `databaseTls: false` only for the documented bundled private-network PostgreSQL service; a separate service needs verified TLS. Save separate private `compose.env` files for the two hosts.
5. **Preserve existing storage.** Back up an existing stopped Kubo volume before reuse. Reference it explicitly as an external volume if changing Compose projects. Never start two Kubo containers against the same repository. Preserve old keys, target identity, database volumes, and project names. Do not rerun initialization over existing secret files or use `down --volumes` to solve startup problems.
6. **Start and verify.** Check Compose without printing it, start the inbox stack, confirm database health locally, validate public HTTPS, then perform the acceptance sequence below. Keep logs sanitized. An empty public `/` or `/healthz` response is expected: the proxy exposes only the API routes.

The [local guide](run-locally.md) has the worker configuration, client commands, and mode selection. The [inbox guide](host-inbox.md) has PostgreSQL, HTTPS, capacity, pruning, migration, and backup instructions. Use them rather than independently inventing another config format. New deployments do not require rebuilding or publishing an image when the selected release already supports the feature.

## Acceptance before handoff

Use harmless test content: publication sends it to IPFS. Record the checks in the private installation record, without credentials.

- Verify HTTPS using normal certificate validation. The public health route should be unavailable, an unauthenticated worker request rejected, and a correctly signed request from an unlisted sender rejected.
- With the local worker stopped, prepare and save an authorized envelope, submit it through the public hostname, and observe `queued`. Restart the inbox/database in a controlled way and verify that the same job remains.
- Start the worker and wait for `published` in IPFS-only mode, or `logged` with a verified receipt in Ledger mode. Retrieve the CID through local Kubo and compare the exact signed message with the submitted message.
- Submit the same saved envelope again and verify its request identity and result remain unchanged. Do not prepare a fresh request to retry uncertain work.
- Restart the selected worker and verify health and retained results. Check memory, swap, disk, container health/restarts, and logs under startup and message processing.
- Create a protected PostgreSQL dump, copy it to another device, and restore into an isolated database. Compare job state there. Never test restoration by rolling back the live database.

Local retrieval proves publication and local pinning. It does not prove that another IPFS peer can retrieve the CID. Test from an independent peer before claiming public content availability, and arrange replication if availability while the local device sleeps matters. The remote inbox can keep accepting work while the worker is offline, subject to capacity and signed job deadlines. Default client jobs expire after 24 hours; offline work is not retained for execution indefinitely.

## Private handoff and daily operation

Leave an installation record outside the checkout with the actual host, provider resource IDs, billing selections, firewall restrictions, release/digest, SSH identity, target, public signer addresses, Compose projects, storage volumes, credential **references**, and check results. Record all resources created even if deployment is incomplete. Include exact commands or private wrappers for monitoring, submission, stopping, restarting, backing up, and restoring. Another agent should be able to resume using this record without regenerating keys.

In a new terminal, set `OYA_COMPOSE_ENV` to the private settings file for the desired role:

```sh
source "$OYA_COMPOSE_ENV"
docker compose ps
docker compose logs -f --tail 100 node  # Local worker; Ctrl-C only stops following logs.
```

For the inbox role, follow `inbox` instead of `node`. With persistent runtime files, local `docker compose stop node` pauses processing and `docker compose start node` resumes it. With Keychain-backed startup, use the helper's `stop` and `start` commands instead; the temporary token mount is no longer present after startup. Starting Docker and the device being awake are prerequisites. `docker stats --no-stream` shows resource use. Recreate containers after changing mounts/configuration as described in the role guides; plain `start` does not reload the Compose model.

Record the actual backup frequency and last successful independent copy. A one-time verified dump is not an automatic backup schedule. For a low-cost experiment, a local scheduled job can copy private dumps when the device is online; missed runs leave a recovery gap. Back up configuration/credentials and IPFS storage separately. Protect dumps because they contain signed messages and may contain broadcastable Ledger transaction checkpoints. Use the documented prune command if retention cleanup is desired; it is not scheduled by default.

If the operator's public IP changes, update the restricted SSH firewall through authenticated provider access. If the server IP changes, update DNS and verify TLS before resuming workers. Preserve the pinned host key unless a replacement is independently verified.

Stopping containers does not stop VM billing. End an experiment by retaining needed backups and explicitly authorizing destruction of its paid resources; removing the DNS record alone does not remove the server. Treat database rollback and unresolved Ledger transactions according to the [recovery instructions](host-inbox.md#retention-recovery-and-migration).
