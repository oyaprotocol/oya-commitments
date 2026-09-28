# First deployment to a DigitalOcean Droplet

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

Download `oya-node-vVERSION.tar.gz` from the chosen GitHub Release (replace `VERSION` with its actual version), extract it into a new directory, and run commands from the extracted directory containing `node/production`. The bundle includes `node/production/image.txt` with the exact release digest. Keep its scripts, Compose files, and image pin together. Prepare private input files outside that directory:

```sh
umask 077
mkdir -p "$HOME/oya-private"
cp -n node/production/docker/config.example.json "$HOME/oya-private/node.json"
cp -n node/production/docker/runtime.env.example "$HOME/oya-private/node.env"
chmod 600 "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Edit those files with your chain ID, RPC endpoint, verified Ledger address, allowed client addresses, and dedicated node key. The node needs gas funds; clients only sign messages. Keep `host` as `0.0.0.0`, `port` as `8787`, and `ipfsUrl` as `http://ipfs:5001`. `node.env` becomes a read-only secret mount, not container environment variables. Use only the three keys in its example, once each, with literal, unquoted `KEY=value` entries. Both files retain mode 0600 and must be readable by the operator UID used in the container. See [private settings](README.md#prepare-private-settings) and [Ledger deployment](README.md#deploy-or-reuse-ledger). Starting this script does not create/fund keys or deploy Ledger.

For a new Ledger on Ethereum Sepolia, follow the [Sepolia deployment instructions](README.md#deploy-ledger-on-sepolia) on your laptop first. They create a separate private deployer file, simulate before broadcasting, and show which verified address to put in your node configuration.

## Deploy

Review the release notes and bundled deployment files before running. The script accepts only a complete GHCR SHA-256 image reference, so moving a registry version tag cannot change this deployment. Run from the extracted bundle root:

```sh
bash node/production/scripts/deploy-droplet.sh \
  oya@DROPLET_IP node.example.com \
  "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Replace the SSH target and hostname. The command checks the host, creates the remote operator's private `$HOME/oya` directory, and pulls the pinned image there. Only the Compose/Caddy files, digest override, generated Compose settings, and the two private input files are copied. Private inputs have mode 0600; the directory has mode 0700. Local staging files are removed on exit. The image override disables the Compose build; missing images must be pulled, never built from local files.

When using a source checkout instead of the bundle, check out the matching release tag and supply the exact reference from that release's `image.txt` as a fifth argument. For example, append `'ghcr.io/oyachat/oya-node@sha256:REPLACE_WITH_RELEASE_DIGEST'` to the command above, replacing the placeholder with all 64 hexadecimal digest characters. Tags such as `latest` or `v0.1.0` are rejected. This explicit argument also overrides a bundle's pin; use matching release files when selecting a different version.

If the remote SSH environment defines `OYA_DEPLOY_DIR`, that directory replaces `$HOME/oya`; its parent must already exist. The generated settings retain the resolved location. This does not change the `oya` project name or allow deployment over existing Oya volumes.

The remote validation checks configuration and key format without broadcasting or contacting Ethereum/IPFS. It sets node stop grace and proxy response time to `ceil(operationTimeoutMs / 1000) + 60` seconds, and proxy stop grace to another 60 seconds. It validates Caddy and waits up to 180 seconds for startup health. Startup checks the RPC chain and contract code; it does not prove the contract implementation, sufficient gas funds, public TLS, or successful message publication.

On success, verify a signed submission from another machine using the [external deployment check](README.md#check-a-deployed-node-from-another-machine). Confirm its transaction and retrieve the CID through a separate online IPFS node. A public `/healthz` request should return 404. Observe memory, disk, peer connectivity, and announcements for 48–72 hours before depending on a 1 GB host. This script retains the existing Kubo settings and does not apply experimental low-memory tuning.

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

## Update an existing node

Do not rerun the first-install script. Read the new release's migration notes and keep a copy of the existing deployment files and digest. The following commands are for a compatible image-only update on the server. If the release changes Compose/Caddy files or private configuration, apply its documented migration and recheck timeout relationships before restarting; do not overwrite private settings with examples.

Load the existing environment, set the exact new digest from the release, pull it before stopping services, and then drain public requests:

```sh
source "$HOME/oya/compose.env"
cd "$OYA_DEPLOY_DIR"
export OYA_NEXT_IMAGE='ghcr.io/oyachat/oya-node@sha256:REPLACE_WITH_RELEASE_DIGEST'
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
