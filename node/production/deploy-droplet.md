# Historical direct-node deployment to a DigitalOcean Droplet

This guide is retained for existing direct-HTTP deployments and their update/recovery procedures. New installations should [run the node locally](run-locally.md) and [host a PostgreSQL inbox](host-inbox.md) wherever they choose. The inbox architecture keeps signing and IPFS execution local and receives messages while the local device is offline. The old installer below deploys the entire node remotely and is not the repository default.

Run `scripts/deploy-droplet.sh` from your laptop to copy private settings over SSH, pull a published Linux amd64 image on the server by its exact digest, validate configuration, and start Node, Kubo, and Caddy. Use the deployment bundle attached to a production-node GitHub Release. The script uses the bundled Compose files and makes no cloud API calls or Ledger transactions. Neither machine needs a source checkout, Node installation, or image build; only the server needs Docker/Compose. Maintainers publish releases using the [image release guide](release-image.md).

This is a first-install command. It refuses an existing deployment directory, Oya project containers (including stopped containers), or volumes whose names begin with `oya_`. Updates and recovery still use the deliberate shutdown/reconciliation procedure in the [operator guide](README.md#receive-messages-over-https). Never run another instance using the same node signing account.

## Prepare the host and inputs once

Create an Ubuntu 24.04 x64 Droplet in a US region. A 1 GB/25 GB plan is a monitored pilot candidate; 2 GB provides more operating margin. See [resource sizing](resource-sizing.md) for the estimates and experimental limits. Install Docker Engine and Compose 2.30+ using [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/), and create a non-root operator account with access to the host's Docker daemon. The script does not install packages or change SSH accounts.

Attach a DigitalOcean Cloud Firewall allowing SSH TCP 22 from your administration IP, HTTP/HTTPS TCP 80/443 from the internet, and IPFS TCP/UDP 4001 from the internet. Keep outbound traffic allowed. Ports 8787, 5001, and 8080 remain private. Point the hostname's A record at the Droplet; configure IPv6 completely or remove its AAAA record. For the first deployment, use direct DNS without another HTTP proxy. See [Cloud Firewalls](https://docs.digitalocean.com/products/networking/firewalls/getting-started/quickstart/).

Your laptop needs Bash, SSH, and tar. The server needs outbound access to GHCR as well as the Kubo/Caddy registries. Public images require no registry login on the server. Connect interactively once, verify the server's SSH fingerprint, and confirm Docker access:

```sh
ssh oya@DROPLET_IP 'docker version && docker compose version'
```

The deployment command uses existing SSH keys/agent configuration and requires a previously verified host key. An SSH config alias works for custom users, ports, or identity files. Password prompts and unknown host keys cause it to stop.

Download `oya-node-vVERSION.tar.gz` from the chosen GitHub Release (replace `VERSION` with its actual version), extract it into a new directory with `tar -xzpf ARCHIVE -C BUNDLE_DIRECTORY` (replace the placeholders with your paths), and run commands from the extracted directory containing `node/production`. The bundle includes `node/production/image.txt` with the exact release digest. Keep its scripts, Compose files, and image pin together. See the [v0.3.0 release reference](release-image.md#published-deployment-release) for the digest and checksum; older v0.2.0 archives also need the [public-file permission repair](run-direct.md#1-download-the-matching-release-files). Prepare private input files outside that directory:

```sh
umask 077
mkdir -p "$HOME/oya-private"
cp -n node/production/docker/config.example.json "$HOME/oya-private/node.json"
cp -n node/production/docker/runtime.env.example "$HOME/oya-private/node.env"
chmod 600 "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Choose the publishing mode before editing the files. The copied example defaults to Ledger mode: set your chain ID, RPC endpoint, verified Ledger address, allowed client addresses, and dedicated node key. That mode needs gas funds; clients only sign messages. For IPFS-only operation, replace `node.json` with the [IPFS-only example](README.md#ipfs-only-configuration), set your allowlist, and leave `node.env` empty unless an IPFS authorization header is needed. No Ledger, RPC, node key, or funding is needed in IPFS mode. It is supported by v0.2.0 and v0.3.0; `node-v0.1.0` does not support it.

In both modes keep `host` as `0.0.0.0`, `port` as `8787`, and `ipfsUrl` as `http://ipfs:5001`. `node.env` is a required readable file mounted read-only, not container environment variables. Use only the three keys in its example, once each, with literal, unquoted `KEY=value` entries. Both files retain mode 0600 and must be readable by the operator UID used in the container. See [private settings](README.md#prepare-private-settings). Starting the ordinary installer does not create/fund a node key or deploy Ledger; the optional testing profile creates only an agent key.

For Ledger mode with a new contract on Ethereum Sepolia, follow the [Sepolia deployment instructions](README.md#deploy-ledger-on-sepolia) on your laptop first. They create a separate private deployer file, simulate before broadcasting, and show which verified address to put in your node configuration. Skip this step for IPFS mode.

## Deploy

Review the release notes and bundled deployment files before running. The script accepts only a complete GHCR SHA-256 image reference, so moving a registry version tag cannot change this deployment. Run from the extracted bundle root:

```sh
bash node/production/scripts/deploy-droplet.sh \
  oya@DROPLET_IP node.example.com \
  "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Replace the SSH target and hostname. The command checks the host, creates the remote operator's private `$HOME/oya` directory, and pulls the pinned image there. Only the Compose/Caddy files, digest override, generated Compose settings, and the two private input files are copied. Private inputs have mode 0600; the directory has mode 0700. Local staging files are removed on exit. The image override disables the Compose build; missing images must be pulled, never built from local files.

When using a source checkout instead of the bundle, check out the matching release tag and supply the exact reference from that release's `image.txt` as a fifth argument. For example, append `'ghcr.io/oyaprotocol/oya-node@sha256:REPLACE_WITH_RELEASE_DIGEST'` to the command above, replacing the placeholder with all 64 hexadecimal digest characters. Tags such as `latest` or `v0.1.0` are rejected. This explicit argument also overrides a bundle's pin; use matching release files when selecting a different version.

If the remote SSH environment defines `OYA_DEPLOY_DIR`, that directory replaces `$HOME/oya`; its parent must already exist. The generated settings retain the resolved location. This does not change the `oya` project name or allow deployment over existing Oya volumes.

The remote validation checks configuration and, only in Ledger mode, the node key format without broadcasting or contacting Ethereum/IPFS. It sets node stop grace and proxy response time to `ceil(operationTimeoutMs / 1000) + 60` seconds, and proxy stop grace to another 60 seconds. It validates Caddy and waits up to 180 seconds for startup health. Ledger startup checks the RPC chain and contract code. Neither mode's startup proves public TLS or successful message publication; Ledger startup also does not prove the contract implementation or sufficient gas funds.

On success, verify a signed submission from another machine using the [external deployment check](README.md#check-a-deployed-node-from-another-machine). Retrieve the CID through a separate online IPFS node and, in Ledger mode, confirm its transaction. A public `/healthz` request should return 404. Observe memory, disk, peer connectivity, and announcements for 48–72 hours before depending on a 1 GB host. This script retains the existing Kubo settings and does not apply experimental low-memory tuning.

## Optional hourly testing profile

For a first IPFS-only or Sepolia installation, add `--with-test-agent` before the ordinary arguments:

```sh
bash node/production/scripts/deploy-droplet.sh --with-test-agent \
  oya@DROPLET_IP node.example.com \
  "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

As with the normal command, a source checkout needs the pinned image reference as the final argument. Use the matching deployment bundle, which includes the test-agent source. No local agent key, signed message file, or LLM API key is required.

The installer generates a separate agent key on the Droplet, saves it in `test-agent-private/key` with mode 0600 inside the private deployment directory, and appends its public address to the deployed `node.json` allowlist. It preserves existing entries and leaves your laptop's input files unchanged. With this option, the input `allowedSigners` may be an empty array; initialization fills it before node validation. In Ledger mode, the node continues to use the funded wallet in `node.env`, including a reused Ledger-deployer wallet. IPFS mode needs no node wallet. The agent account needs no ETH. Initialization accepts IPFS mode without chain fields, or Ledger mode on Sepolia (`11155111`) and disposable Anvil (`31337`); other chains are refused.

The Compose `testing` profile adds one `test-agent` container using the same pinned image as the node, with the reviewed agent source and its own key directory mounted read-only. It shares a separate network with the node, has no public port or direct Kubo connection, and receives no node key or RPC credentials. Its HTTP deadline follows `operationTimeoutMs` with 30 seconds of headroom; the installer also sets the longer stop grace.

After the node becomes healthy, the agent sends its first generated message immediately, then starts another once per hour (about 24 submissions per day). It waits for each result before scheduling the next; there is no catch-up queue. Messages and their signatures become public through IPFS. In Ledger mode, each successful submission spends the node's Sepolia gas, and logs contain `test_message_logged`, the agent address, CID, and transaction hash. IPFS mode spends no gas and logs `test_message_published`, the agent address, and CID. This exercises the internal publication flow; public DNS/TLS and independent IPFS retrieval still need the external check above.

On the Droplet, inspect or pause it with:

```sh
source "$HOME/oya/compose.env"
docker compose logs --tail=20 test-agent
docker compose stop test-agent
```

Any rejected, failed, timed-out, or unconfirmed submission stops the agent with `test_agent_stopped`; it does not retry or automatically restart. Check node logs and, in Ledger mode, the transaction before resuming an uncertain result. With the outcome inspected and the node healthy:

```sh
docker compose up --detach --no-deps --no-build --pull never test-agent
```

An explicit restart sends immediately and starts a new hourly schedule. A normal stop interrupts the hourly wait; an in-flight request gets its bounded completion time. Both node and agent require deliberate recovery after a host reboot. To leave testing disabled, stop the agent and remove `export COMPOSE_PROFILES=testing` from `compose.env`, then use a new SSH session. Preserve `test-agent-private/key` and the deployed allowlist when backing up, recovering, or updating; initialization never replaces an existing key.

## Operate or recover

In a new SSH session, load the generated settings before any Compose command:

```sh
source "$HOME/oya/compose.env"
docker compose ps
docker compose logs --tail=100 node
docker stats --no-stream
```

The generated `COMPOSE_FILE` uses absolute paths on that host, so these commands work from any directory. Secret values are absent from the expanded Compose model and Docker container environment. Full inspection/configuration output still exposes deployment paths and metadata; use `docker compose config --quiet` for syntax checks and avoid sharing private files or dumps of application memory.

A failed install leaves remote files and any created containers/volumes for inspection. A repeated install refuses them; it never automatically rolls back, deletes storage, or retries a signing node. A failed registry pull stops before configuration validation or startup. Inspect the failure and reconcile any uncertain transaction before using the [manual recovery procedure](README.md#operate-and-inspect). If private settings change, regenerate the timeout relationships documented in the [HTTPS guide](README.md#receive-messages-over-https) before restarting.

The node deliberately stays stopped after a crash/reboot until operator recovery. Preserve the `oya` project name, IPFS volume, certificate volumes, and private settings; use the [backup procedure](README.md#back-up-and-restore-ipfs), stopping the proxy first. Never use `down --volumes` to recover a deployment you intend to preserve.

If the testing profile is enabled, stop `test-agent` before stopping the proxy or node for backup, maintenance, or recovery. Keep its private key in protected backups as well.

## Update an existing node

Do not rerun the first-install script. Read the new release's migration notes and keep a copy of the existing deployment files and digest. The following commands are for a compatible image-only update on the server. If the release changes Compose/Caddy files or private configuration, apply its documented migration and recheck timeout relationships before restarting; do not overwrite private settings with examples.

With the testing profile enabled, stop `test-agent` first. Update `OYA_TEST_AGENT_IMAGE` in `compose.env` to the same new digest, and carry over any reviewed changes to `test-agent/agent.mjs` and `docker/compose.testing.yaml` from the matching release. Preserve `test-agent-private/key`. Keep the agent stopped until the node and proxy have passed the checks below, then start it explicitly using the command above.

Load the existing environment, set the exact new digest from the release, pull it before stopping services, and then drain public requests:

```sh
source "$HOME/oya/compose.env"
cd "$OYA_DEPLOY_DIR"
export OYA_NEXT_IMAGE='ghcr.io/oyaprotocol/oya-node@sha256:REPLACE_WITH_RELEASE_DIGEST'
docker pull "$OYA_NEXT_IMAGE"
docker compose stop proxy
docker compose stop node
```

Replace the digest placeholder before running. Inspect logs and reconcile any unknown transaction outcome or interrupted request before continuing. Preserve the IPFS and certificate volumes. Save the current image override for rollback, set the new pin, and start only the node:

```sh
cp image.yaml image.previous.yaml
printf 'services:\n  node:\n    build: !reset null\n    image: %s\n' "$OYA_NEXT_IMAGE" > image.yaml
docker compose config --quiet
docker compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 node
```

Only after that command succeeds and the node is healthy, restore public access:

```sh
docker compose up --detach --no-deps --no-build --pull never --wait --wait-timeout 180 proxy
```

Verify an external signed submission and independent CID retrieval as for a first deployment. If startup or publication fails, inspect and reconcile before any retry or rollback. For a compatible rollback, drain/stop the proxy and node again, restore `image.previous.yaml`, pull its node image with `docker compose pull node`, and use the same node-then-proxy startup sequence. There is no automatic rollback, and image rollback does not undo a transaction or storage migration.
