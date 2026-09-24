# First deployment to a DigitalOcean Droplet

Run `scripts/deploy-droplet.sh` from your laptop to build the current repository runtime for Linux amd64, copy its image and private settings over SSH, validate configuration, and start Node, Kubo, and Caddy. The script uses the existing Compose files and makes no cloud API calls or Ledger transactions. No Git checkout, Node installation, or image build is needed on the server.

This is a first-install command. It refuses an existing deployment directory, Oya project containers (including stopped containers), or volumes whose names begin with `oya_`. Updates and recovery still use the deliberate shutdown/reconciliation procedure in the [operator guide](README.md#receive-messages-over-https). Never run another instance using the same node signing account.

## Prepare the host and inputs once

Create an Ubuntu 24.04 x64 Droplet in a US region. A 1 GB/25 GB plan is a monitored pilot candidate; 2 GB provides more operating margin. See [resource sizing](resource-sizing.md) for the estimates and experimental limits. Install Docker Engine and Compose 2.30+ using [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/), and create a non-root operator account with access to the host's Docker daemon. The script does not install packages or change SSH accounts.

Attach a DigitalOcean Cloud Firewall allowing SSH TCP 22 from your administration IP, HTTP/HTTPS TCP 80/443 from the internet, and IPFS TCP/UDP 4001 from the internet. Keep outbound traffic allowed. Ports 8787, 5001, and 8080 remain private. Point the hostname's A record at the Droplet; configure IPv6 completely or remove its AAAA record. For the first deployment, use direct DNS without another HTTP proxy. See [Cloud Firewalls](https://docs.digitalocean.com/products/networking/firewalls/getting-started/quickstart/).

Your laptop needs Bash, Docker with Linux amd64 build support, SSH, tar, and the standard `od`/`tr` tools with `/dev/urandom` for random image tags. Connect interactively once, verify the server's SSH fingerprint, and confirm Docker access:

```sh
ssh oya@DROPLET_IP 'docker version && docker compose version'
```

The deployment command uses existing SSH keys/agent configuration and requires a previously verified host key. An SSH config alias works for custom users, ports, or identity files. Password prompts and unknown host keys cause it to stop.

From the repository root, prepare private input files outside the checkout:

```sh
umask 077
mkdir -p "$HOME/oya-private"
cp -n node/production/docker/config.example.json "$HOME/oya-private/node.json"
cp -n node/production/docker/runtime.env.example "$HOME/oya-private/node.env"
chmod 600 "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Edit those files with your chain ID, RPC endpoint, verified Ledger address, allowed client addresses, and dedicated node key. The node needs gas funds; clients only sign messages. Keep `host` as `0.0.0.0`, `port` as `8787`, and `ipfsUrl` as `http://ipfs:5001`. Use literal, unquoted `KEY=value` entries in the runtime environment file. See [private settings](README.md#prepare-private-settings) and [Ledger deployment](README.md#deploy-or-reuse-ledger). Starting this script does not create/fund keys or deploy Ledger.

## Deploy

Review the current working-tree runtime, Dockerfile, lockfile, and Compose files before running. The script builds those files, including any uncommitted changes; it does not fetch a different revision or publish an image. Run from the repository root:

```sh
bash node/production/scripts/deploy-droplet.sh \
  oya@DROPLET_IP node.example.com \
  "$HOME/oya-private/node.json" "$HOME/oya-private/node.env"
```

Replace the SSH target and hostname. The command checks the host before building, creates a unique image tag, transfers the image, and creates the remote operator's private `$HOME/oya` directory. Only the Compose/Caddy files, image override, generated Compose settings, and the two private input files are copied. Private inputs have mode 0600; the directory has mode 0700. Local staging files are removed on exit; local Docker images/build cache remain.

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

The generated `COMPOSE_FILE` uses absolute paths on that host, so these commands work from any directory. Do not print expanded `docker compose config` or full container inspection output: they can expose runtime credentials. Use `docker compose config --quiet` for syntax checks.

A failed install leaves remote files and any created containers/volumes for inspection. A repeated install refuses them; it never automatically rolls back, deletes storage, or retries a signing node. Inspect the failure and reconcile any uncertain transaction before using the [manual recovery procedure](README.md#operate-and-inspect). If private settings change, regenerate the timeout relationships documented in the [HTTPS guide](README.md#receive-messages-over-https) before restarting. Transfer interruption before file creation may leave only an unused image, which does not prevent another first-install attempt.

The node deliberately stays stopped after a crash/reboot until operator recovery. Preserve the `oya` project name, IPFS volume, certificate volumes, and private settings; use the [backup procedure](README.md#back-up-and-restore-ipfs), stopping the proxy first. Never use `down --volumes` to recover a deployment you intend to preserve.
