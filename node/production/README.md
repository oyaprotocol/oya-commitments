# Oya production node

This standalone runtime accepts an agent's signed text, publishes the signed JSON to IPFS, and submits its CID to Ledger using the node's own account. A `200` response includes the CID, transaction hash, block number, and node address after the kernel verifies a successful receipt and the matching Ledger event.

After signature and allowlist checks, the HTTP handler calls the kernel's `publishAndLogSignedMessage` directly. One complete operation runs at a time, from IPFS publication through the verified receipt. Additional authenticated requests receive `503 node_busy`; there is no waiting queue.

The Ledger runtime installs the published `@oyaprotocol/ethereum` and `@oyaprotocol/messages` kernels at `0.2.0`, with `@oyaprotocol/ipfs` at `0.1.2` and `@oyaprotocol/utils` at `0.1.1`, and uses ethers in `src/signer.mjs` for local transaction signing. Ethereum and messages are updated together to keep one Ethereum package instance for error classification. The kernels handle publication, transaction preparation, broadcasting, and receipt verification. Kernel signing support remains future work. Reimbursement verification, Safe proposals, and DeFi actions are later integrations.

When upgrading an existing local instance, rename `loggerContract` to `ledgerContract` in its config and deployment record, and `LOGGER_DEPLOYER_PK` / `LOGGER_CHAIN_ID` to `LEDGER_DEPLOYER_PK` / `LEDGER_CHAIN_ID` where used. Use `deploy-ledger` for deployment/reuse. The existing contract address remains valid because the ABI is unchanged. Private settings and prior deployment artifacts are not rewritten automatically.

## Run with Docker Compose

[compose.yaml](compose.yaml) runs the node and Kubo with persistent IPFS storage. Use a Linux Docker host or Docker Desktop with Linux containers, and Compose 2.30 or newer. Run the commands below from the repository root. Ethereum comes from your selected RPC provider; deploy or verify Ledger and fund a dedicated node account before starting the node.

### Prepare private settings

For a new instance, replace the placeholder directory below with an absolute path outside the checkout. Keep the Compose project name stable: `oya` owns the `oya_ipfs-data` volume.

```sh
umask 077
mkdir -m 700 /absolute/path/to/private-oya
export OYA_CONFIG_FILE=/absolute/path/to/private-oya/node.json
export OYA_ENV_FILE=/absolute/path/to/private-oya/node.env
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export COMPOSE_FILE=node/production/compose.yaml
export COMPOSE_PROJECT_NAME=oya
cp -n node/production/docker/config.example.json "$OYA_CONFIG_FILE"
cp -n node/production/docker/runtime.env.example "$OYA_ENV_FILE"
chmod 600 "$OYA_CONFIG_FILE" "$OYA_ENV_FILE"
```

Edit both files before continuing. The example chain, RPC URL, Ledger address, and allowed signer address are placeholders. Select your chain and RPC, verified Ledger address, and actual agent allowlist. Keep the internal `host` as `0.0.0.0`, `port` as `8787`, and `ipfsUrl` as `http://ipfs:5001`. Container loopback addresses refer to that container, so an RPC running elsewhere needs an address reachable from Docker.

The environment file contains only the node signing key and optional complete RPC/IPFS Authorization headers. Use literal, unquoted `KEY=value` lines, with no inline comments; Compose's raw format preserves dollar signs and quotes. Leave authorization values empty when unused; the bundled Kubo API requires none. Keep agent and Ledger-deployer keys in separate files for their separate tools. Docker administrators can inspect container environment values; do not share expanded Compose configuration or full container inspection output.

The default container user is `1000:1000`. On a POSIX host, the override above selects the current operator's UID/GID; run it as a non-root user. A mode-0600 config needs a matching owner, or deliberately configured group access. Compose reads the environment file on the host, while the container reads the mounted JSON. On Windows, set the same variables in your shell using absolute host paths and an explicit numeric `OYA_CONTAINER_USER`, such as `1000:1000`, and restrict access with host ACLs. Docker Desktop file sharing can differ from Linux ownership; verify the actual mount below before startup. Do not make private files world-readable to fix access.

```sh
docker compose config --quiet
docker compose build node
docker compose run --rm --no-deps --entrypoint node node -e 'require("node:fs").readFileSync("/config/node.json"); console.log("Config is readable")'
```

`config --quiet` checks the Compose model without printing credentials. The mount check confirms file access; application startup validates the JSON and signer. A missing config path fails instead of creating a directory. Re-export these variables in a new terminal before using the remaining commands.

If Ledger still needs deployment, use the existing [deployment workflow](#deploy-or-reuse-ledger) with host Node.js/npm and Foundry. Prepare a separate host-facing config with `host: "127.0.0.1"`, a host-reachable RPC URL, and the same chain; put only the deployer key in its environment file. The local CLI rejects the container's `0.0.0.0` bind. Preview and then explicitly broadcast:

```sh
npm --prefix node/production run local -- deploy-ledger --config /absolute/path/to/private-oya/deploy.json --env-file /absolute/path/to/private-oya/deployer.env
npm --prefix node/production run local -- deploy-ledger --broadcast --config /absolute/path/to/private-oya/deploy.json --env-file /absolute/path/to/private-oya/deployer.env
```

Broadcast spends funds on the selected chain. Adopt the verified address manually in both configs. Deployment with custom RPC Authorization headers is unsupported. Starting Compose never deploys Ledger, creates a node key, or funds accounts.

### Operate and inspect

```sh
docker compose up -d
docker compose ps
docker compose logs --follow node
```

Stopping log-following leaves services running. Node HTTP is published at `http://127.0.0.1:8787`; `OYA_HTTP_PORT` changes only the host port. Kubo's TCP/UDP swarm port 4001 is published on the host, while API 5001 and gateway 8080 remain unpublished. The API is reachable by containers on the Compose network. For agents on other machines, provide TLS termination and access controls through your hosting platform's proxy. Check Kubo peer connectivity and retrieval from an independent peer before relying on public availability:

```sh
docker compose exec ipfs ipfs swarm peers
```

The node waits for Kubo's API health check before startup. Node health reports local lifecycle state: ready and busy are healthy; shutdown and unknown transaction outcomes are unhealthy. It does not continuously test Ethereum or IPFS. Both services rotate logs at 10 MB per file with three files retained. Kubo can restart automatically; the signing node has `restart: "no"` because restarting clears its in-memory unknown-outcome guard. Reconcile uncertain transactions before restarting or retrying, and run only one instance per node account.

From a separate terminal with host Node.js and the installed `node/production` dependencies, use the [existing sender](#submit-a-message) with only the agent key loaded. Substitute your text file and returned CID:

```sh
node --env-file=/absolute/path/to/agent.env -- node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt
docker compose exec ipfs ipfs pin ls --type=recursive
docker compose exec ipfs ipfs cat /ipfs/REPLACE_WITH_RETURNED_CID
```

Stop admission and drain accepted work before replacing the node or updating its settings:

```sh
docker compose stop node
docker compose up -d --no-deps --force-recreate node
```

For an image update, preserve the previous image ID for rollback and run `docker compose build node` between these commands. Recreation reloads changed configuration and environment values; `docker compose restart` does not apply changed service environment. The node has a four-minute stop grace for its default three-minute operation deadline. Increase `OYA_STOP_GRACE_PERIOD` with headroom if you increase `operationTimeoutMs`. A forced shutdown or missing client response requires transaction reconciliation before another start.

`docker compose down` stops services in dependency order and retains the named IPFS volume. Keep the same project name when bringing them back. `down --volumes` deletes the repository. An image moved to another host does not carry its volume or private settings.

### Back up and restore IPFS

Back up the complete Kubo repository while both services are stopped. The archive contains Kubo's private identity as well as content and pins; protect it and keep an off-host copy. Back up node config/key files separately. Choose a new backup filename and retain the exact image versions with it. Record the peer identity before stopping:

```sh
docker compose exec -T ipfs ipfs id -f='<id>\n'
docker compose stop node ipfs
export OYA_BACKUP_FILE=/absolute/path/to/private-oya/ipfs-repo.tar
umask 077
docker compose run --rm --no-deps -T --entrypoint tar ipfs -C /data/ipfs -cpf - . > "$OYA_BACKUP_FILE"
```

Require a successful archive command before relying on the backup. Restore into a fresh volume by choosing a new, unused Compose project name (`oya-restore` below). These one-off containers use the pinned Kubo image and do not start a daemon or publish service ports:

```sh
docker compose -p oya-restore run --rm --no-deps -T --entrypoint tar ipfs -C /data/ipfs -xpf - < "$OYA_BACKUP_FILE"
docker compose -p oya-restore run --rm --no-deps -T --entrypoint ipfs ipfs --offline id -f='<id>\n'
docker compose -p oya-restore run --rm --no-deps -T --entrypoint ipfs ipfs --offline pin ls --type=recursive
docker compose -p oya-restore run --rm --no-deps -T --entrypoint ipfs ipfs --offline cat /ipfs/REPLACE_WITH_RETURNED_CID
```

Compare the restored identity, pins, and message bytes with the original before adopting the backup. To resume the original stack, use `docker compose up -d`. To adopt the restored repository instead, keep the original services stopped, set `COMPOSE_PROJECT_NAME=oya-restore`, and start with the same node settings and key after reconciling pending work. Do not run both signing nodes. Upgrade Kubo separately from the node and take a cold backup first; an image downgrade alone does not undo repository-format changes.

Milestone 2 was validated on Linux arm64 through Docker Desktop 4.37.2 / Engine 27.4.0 and Compose 2.31.0, using Node 24.21.0 and Kubo 0.43.0. Checks covered mounted settings, health probes, startup, persistence, and the cold backup/restore commands above. Validation used offline Kubo, an isolated RPC fixture limited to startup reads, and a dynamic loopback HTTP port. Signed publication through Ledger in Docker and container CI remain milestone 3; amd64 execution, a native Linux host, and Windows file sharing have not been tested here.

## Install and validate

Use Node 22 or newer, npm, Foundry, and [Kubo 0.43.0](https://github.com/ipfs/kubo/releases/tag/v0.43.0) for the local integration tests. Both integration scripts require `ipfs` on `PATH` to report exactly `0.43.0`, matching Compose, and check the fixture daemon's version. Select that release on `PATH` before running them; a mismatch fails before any services start. CI uses Node 24. From the repository root:

```sh
git submodule update --init lib/forge-std
npm --prefix node/production ci
npm --prefix node/production test
forge build --root contracts --sizes
forge test --root contracts --offline -vv
ipfs version --number # Must print 0.43.0.
npm --prefix node/production run test:local
npm --prefix node/production run smoke:local
```

`test:local` exercises the operating commands with a disposable Anvil chain and an isolated offline Kubo repository. It simulates and deploys Ledger, checks the deployment record, adopts the address in its config as an operator would, then runs `check`, launches the foreground node, and queries `status`. A separate process runs the existing message sender with its own agent key. The test retrieves the exact signed JSON from IPFS and independently checks the mined Ledger event. A disallowed agent is rejected without a node transaction.

To follow each stage as it runs, add `--verbose`:

```sh
npm --prefix node/production run test:local -- --verbose
```

Verbose output includes public addresses, message text, CIDs, transaction hashes, and verification/restart results. It does not print private keys or raw child-process output. Without the flag, the test prints its final result and evidence-file location.

The test stops the node with SIGINT, restarts with the same identity and Ledger, publishes a second message, and stops with SIGTERM. It verifies unchanged settings, no transaction merely from restarting, unreachable status after shutdown, and continued Ethereum/IPFS service availability until fixture cleanup. All accounts are generated; only the deployer and node receive test ETH. The fixture stops its services and removes temporary settings and private keys. It retains a separate public `evidence.json` containing addresses, CIDs, transaction hashes, and checks, and prints that file's location. Offline Kubo keeps test content local; the fixture does not use the operator's existing fork or IPFS repository.

The smoke starts isolated Anvil and offline Kubo processes on loopback ports, deploys Ledger through `contracts/script/DeployLedger.s.sol`, and exercises real signed HTTP requests. It retrieves each published envelope and checks the mined Ledger event, rejects invalid signatures, and rejects startup on a wrong chain or missing contract. With automining disabled, it checks busy rejection while exactly one transaction is pending. After mining, the rejected request succeeds; repeating an earlier completed message creates a separate Ledger event with the same CID. The smoke also starts the actual node CLI and verifies its health and signing address. It stops its services when finished and prints a temporary directory containing `evidence.json` and service logs.

Host tests cover failure, deadline, client-disconnect, and shutdown behavior using controlled transports, including proof that rejected requests invoke no publication or signing work. The real smoke checks that busy rejection submits no second transaction. All smoke accounts and gas balances are generated for its disposable local chain.

To leave a working local stack running:

```sh
npm --prefix node/production run smoke:local -- --keep-running
```

This prints the actual node URL, RPC URL, IPFS URL, Ledger address, and temporary artifact directory. That directory contains `config.json` and a `.env` with generated local node and agent keys, written with mode `0600`; the keys are not printed. The local chain is disposable, and offline Kubo makes content available through its local API only. Press Ctrl-C to stop all three services. For deployment-script details, see [`contracts/README.md`](../../contracts/README.md).

## Configure and start

Prepare dependencies and private configuration templates from the repository root:

```sh
npm --prefix node/production run local -- setup
```

Setup installs the host and published kernels from `node/production/package-lock.json` and creates missing `config.local.json` and `.env` files with mode `0600`. No kernel source build or TypeScript installation is needed. Repeating it preserves existing files and their permissions. It uses Node.js built-ins and needs Node 22 or newer and npm; it does not deploy Ledger or start services. Template addresses and empty keys must be filled before use. For different file locations, add `--config /absolute/path/to/node.json --env-file /absolute/path/to/node.env`; parent directories must already exist. Relative paths resolve from the directory where you invoked the command. Keep custom files outside the checkout or ignore them in Git.

Edit the ignored `config.local.json` (or copy `config.example.json` there when configuring manually). Replace the example Ledger and agent addresses with your deployment and allowlisted signer addresses. Set `chainId`, `rpcUrl`, and `ipfsUrl` for the intended environment. `ipfsUrl` must be a Kubo-compatible API, with `/api/v0/add` support; a read-only gateway or unrelated pinning API is insufficient.

The node account must have gas funds and be dedicated to one runtime. The agent signing key is distinct; it does not need gas to sign a message. Store `OYA_NODE_PRIVATE_KEY` in the ignored `node/production/.env`, or inject it through your process supervisor. Optional `OYA_RPC_AUTHORIZATION` and `OYA_IPFS_AUTHORIZATION` contain complete HTTP Authorization header values. Keep RPC URLs containing credentials in private local config too.

### Deploy or reuse Ledger

From the repository root, optionally preview deployment using the configured Ethereum connection:

```sh
npm --prefix node/production run local -- deploy-ledger
```

If `ledgerContract` already has code on the configured chain, the command reports reuse and changes no files. This checks code presence, not the contract's implementation. Otherwise, install Foundry and supply a funded deployment account through `LEDGER_DEPLOYER_PK` in the selected environment file or inherited environment. The command initializes `lib/forge-std` if missing and invokes the existing `contracts/script/DeployLedger.s.sol`; Forge compiles and simulates it. The node key, node balance, and a running IPFS service are not prerequisites for deployment.

To deploy, use `--broadcast`. Forge includes simulation in this command, so a separate preview is optional:

```sh
npm --prefix node/production run local -- deploy-ledger --broadcast
```

Both commands accept `--config <path>` and `--env-file <path>`, with the same file-first environment precedence as the other local commands. The selected chain and RPC endpoint are used by both the kernel checks and Forge. Deployment through RPC endpoints requiring Authorization headers is deferred; `deploy-ledger` rejects a nonempty `OYA_RPC_AUTHORIZATION`. The config must be readable, and its directory must be writable for deployment records and artifacts. `--broadcast` is rejected for all other actions.

A successful broadcast is checked against its receipt, deployer, contract address, chain, and deployed code before public deployment metadata is saved. The record goes into the ignored `node/production/deployment.local.json`; a custom config such as `settings.json` uses the sibling `settings.json.deployment.local.json`. The command leaves the config untouched and prints the verified Ledger address. Set `ledgerContract` to that address in the selected config, then run `local check` after funding the node and starting IPFS. After this manual update, repeating the deployment command reuses the configured address without another transaction.

Each invocation of Forge has a separate private `.oya-ledger-*` directory beside the config, printed for inspection and ignored by Git. After an uncertain broadcast, inspect those artifacts and reconcile the transaction before another attempt; the wrapper does not relaunch Forge or use `--resume`. If recording fails after verification, the verified address remains in the output for manual adoption. Existing metadata with no code at the configured address blocks deployment until the operator reconciles the record and chain, including adopting a newly deployed address in the config. Run one deployment command at a time per configuration.

The [local integration test](#install-and-validate) checks deployment-key precedence, blocked redeployment before manual adoption, and reuse after adoption as part of the complete publication flow.

### Check and run the node

Check the configuration and services from the repository root:

```sh
npm --prefix node/production run local -- check
```

`check`, `run`, and `status` accept the same `--config` and `--env-file` overrides as setup and share one settings loader. The selected environment file must be readable; it may be empty when credentials are injected. Its values override inherited environment values, including explicitly empty values; omitted entries use the inherited environment. These local commands require `host` to be `127.0.0.1` or `::1` and use the existing config validator and node signer.

The command checks the Ethereum chain ID, nonempty code at the Ledger address, a positive native-currency balance for the node, and the Kubo `/api/v0/version` endpoint, in that order. Each probe has a 10-second deadline, including response reading and any RPC retries. It prints public addresses and an `OK` for each passing probe, exits 0 when all pass, or stops with a sanitized `FAIL` and exit 1 at the first failure. It submits no transactions, uploads no content, and changes no files. Code presence does not verify Ledger's implementation, a positive balance does not guarantee sufficient gas for a particular transaction, and the IPFS probe does not prove publication permissions.

Start the node in the foreground from the repository root:

```sh
node -- node/production/scripts/local-node.mjs run
```

Use this direct Node.js command when configuring a process supervisor, with the repository root as its working directory. Send SIGINT/SIGTERM to that Node.js PID, which owns the HTTP server. Launching through npm introduces a shell whose signal forwarding can vary. The `--` separator keeps options such as `--env-file` with the script.

`run` loads the selected configuration and signer once, performs readiness checks, prints the local URL, and calls `startNode()` in the same process. Startup uses those loaded settings even if the files change during readiness; later edits take effect on the next explicit run. The runtime receives its configuration and signer directly, without copying the selected environment into `process.env`. No dependencies are installed and no services are deployed by `run`.

Ctrl-C in the owning terminal, or SIGINT/SIGTERM sent to the node, stops admission and waits for active work to drain. There is no forced shutdown timer or automatic restart. A clean stop exits 0; startup or shutdown failure exits 1. Supplied Ethereum/IPFS services keep running. Start another explicit `run` to restart the node after reconciling any uncertain transaction outcome.

In another terminal, using the same path overrides if any:

```sh
npm --prefix node/production run local -- status
```

`status` queries only the local `/healthz` endpoint, with a five-second deadline covering connection and response reading. It verifies the chain ID, Ledger address, and node address against the selected settings. `ready` and `busy` exit 0. `shutting_down`, `transaction_outcome_unknown`, an identity mismatch, an unreachable node, or malformed health data exit 1 with sanitized output. Status never starts or restarts a process and does not probe Ethereum or IPFS. An unknown transaction outcome requires inspection before restarting or retrying.

For direct runtime startup, the existing entrypoint remains available:

```sh
node --env-file=node/production/.env node/production/src/main.mjs node/production/config.local.json
```

The direct Node.js `--env-file` command gives inherited variables precedence; clear conflicting inherited Oya values when using it after the local commands.

Alternatively, with environment variables already loaded:

```sh
node -- node/production/src/main.mjs /absolute/path/to/config.json
```

Both CLI paths use `startNode(config, signer, { handleSignals: true })` from `src/main.mjs`, which starts the HTTP server and enables shared lifecycle logs and SIGINT/SIGTERM handling. Programmatic callers omit `handleSignals` and use the returned runtime's `close()` method themselves. Signal listeners remain installed until accepted work has drained and are then removed.

Startup checks the RPC chain and deployed Ledger bytecode before serving traffic. Configuration rejects unsupported fields. There is no state directory, publication journal, process lock, or startup replay.

`host` defaults to `127.0.0.1`, and `port` to `8787`. To host it remotely, use the direct runtime entrypoint, choose the binding explicitly, and provide HTTPS through your hosting environment. Other optional settings are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxBodyBytes` | 16,384 | Maximum HTTP request body size. |
| `maxTextBytes` | 8,192 | Maximum signed text size. |
| `bodyTimeoutMs` | 10,000 | Deadline for reading the request body. |
| `receiptTimeoutMs` | 60,000 | Deadline for observing a transaction receipt. |
| `operationTimeoutMs` | 180,000 | Overall deadline for the combined publication and logging operation. |
| `pollIntervalMs` | 1,000 | Interval between receipt polls. |
| `gasLimit` | 200,000 | Maximum transaction gas limit. |
| `maxFeePerGasWei` | `"30000000000"` | Maximum fee per gas, as a decimal string. |

Gas and fee values are ceilings; requests above them stop before signing. Transport attempts have a 10-second timeout and up to two kernel-managed retries. Transaction preparation has the kernel's 30-second deadline. The overall operation deadline bounds all stages together, including those retries; the host does not retry the complete operation.

## Submit a message

`POST /v1/messages` accepts `Content-Type: application/json` and exactly:

```json
{ "text": "Your exact ASCII message", "signer": "0x...", "signature": "0x..." }
```

The signature must be EIP-191 over exactly `text`; the signer must be in `allowedSigners`. The node caps bytes while reading the HTTP stream, and the kernel validates JSON, message size, schema, signature, and authorization before publication. The signed text should contain any context that its readers need; this first runtime does not interpret commitment-specific fields.

Put ASCII text in a file and store `OYA_AGENT_PRIVATE_KEY` in a separate private agent environment file outside version control. The sender needs its own key; keep the node and deployment keys in their respective environments. From the repository root, with the node already running:

```sh
node --env-file=/absolute/path/to/agent.env -- node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt
```

The script signs the complete file, including any final newline. A successful response looks like:

```json
{
  "status": "logged",
  "signer": "0x...",
  "publication": {
    "status": "logged",
    "cid": "bafk...",
    "uri": "ipfs://bafk...",
    "transactionHash": "0x...",
    "blockNumber": "2",
    "nodeAddress": "0x...",
    "ledgerContract": "0x..."
  }
}
```

Retrieve the original signed JSON with `ipfs cat <cid>` against the relevant Kubo repository, or `POST <ipfsUrl>/api/v0/cat?arg=<cid>`. Ledger's indexed node address identifies the node transaction signer, while the JSON retains the agent's separate signature.

## Results, retries, and shutdown

Every admitted valid request is an independent operation. Repeating the same signed envelope can return the same IPFS CID while producing a new Ledger transaction and another gas charge. There is no durable deduplication, exactly-once guarantee, or automatic restart recovery. Even a previously completed message receives `node_busy` while another operation is active.

| HTTP result | Meaning |
| --- | --- |
| `200`, `status: "logged"` | IPFS publication and successful mined Ledger execution were verified. |
| `503 node_busy` | Another operation is active. This request did not start; retry later using `Retry-After: 5`. |
| `503 shutting_down` | The node is draining. This request did not start. |
| `503 transaction_outcome_unknown` | An earlier transaction outcome is unresolved; the node is unavailable pending operator reconciliation. |
| `502 publication_failed` | An upstream publication or logging step failed; inspect the outcome and available CID/hash. |
| `504 operation_timeout` or `504 receipt_timeout` | The overall operation or receipt deadline elapsed; effects may already have occurred. |
| `500 internal_error` | An unexpected fault occurred; a started operation with an unknown outcome blocks further work. |

Validation errors retain their HTTP statuses, including `401` for invalid signatures, `403` for disallowed signers, and `413` for oversized requests. These requests cause no publication or signing. Signature and allowlist checks also run when the node is busy or unavailable.

Busy, shutdown, and unavailable rejections include `started: false`. Attempted failures include `started: true` and `loggingOutcome`, with a partial `publication` containing any known CID, URI, transaction hash, and mined block number:

- `not_submitted`: No Ledger transaction was submitted. IPFS publication may still have occurred. The node can accept another operation.
- `failed`: A validated mined receipt was observed, but execution reverted or Ledger verification failed. The nonce was consumed, so the node can accept another operation.
- `unknown`: The node cannot establish the logging outcome. A known transaction hash is not proof of acceptance or mining. Further authenticated requests receive `503 transaction_outcome_unknown` with no automatic retry advice.

An HTTP failure or lost connection cannot undo IPFS publication or transaction submission. Inspect the returned identifiers and the node account on the configured chain before retrying attempted work. For an unknown outcome, reconcile the transaction externally and deliberately restart only once it is resolved. Restart loses the in-memory unavailable flag; it does not reconcile transactions or recover a lost response. The signing account must be used exclusively by this one process, including across restarts.

`GET /healthz` returns `200` with `status: "ready"` or `"busy"`, or `503` with `"transaction_outcome_unknown"` or `"shutting_down"`. It includes `busy`, chain ID, Ledger address, and node address. It describes local lifecycle state and does not continuously probe RPC or IPFS.

A disconnected client does not cancel an admitted operation or release its guard. The operation finishes or reaches its deadline, and the node emits a sanitized `message_result` log containing its final public result. SIGINT/SIGTERM stops admission and waits for active work, including work whose client disconnected. Logs never include raw provider errors or signed transaction bytes; the host persists no intermediate progress.

A successful response confirms mined execution as reported by the configured RPC, without additional confirmation depth or protection against later chain reorganizations. IPFS content is public once published, including the signed text. Ledger records CID claims; consumers still verify retrieved content and the agent signature.
