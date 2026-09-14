# Package a deployable Docker runtime for the log-only node

This ExecPlan is a living document maintained according to `PLANS.md`. It is a proposal for review; implementation has not begun. Work should proceed in the small milestones below, with a review handoff after each milestone to respect the user's requested pace.

## Purpose / Big Picture

An operator should be able to build the Oya node image, configure an instance, and run it on a Linux Docker host without installing Node.js or the kernel packages on that host. Docker Desktop should support the same workflow for development on macOS or Windows using Linux containers. A locally running agent can submit a signed message through the published HTTP port and receive the existing verified IPFS/Ledger publication result.

Docker Compose, which describes related containers, networking, and storage in one file, will run the Oya process alongside Kubo, the IPFS service. The node's signing identity and configuration live outside the image. Kubo's repository lives in a named Docker volume that survives container replacement. Ethereum comes from an operator-supplied RPC endpoint with an already deployed Ledger and a funded node account.

This delivers a deployable, manually supervised log-only instance. It does not add durable transaction recovery, unattended node restarts, reimbursement verification, or a hosted service. A disposable Anvil chain will support container validation. Registry publication and a permanent deployment using real credentials are separate follow-up actions.

## Progress

- [x] 2026-09-13 07:01Z: Reviewed plan requirements, the direct runtime entrypoint, configuration, existing deployment/publication tests, and current CI.
- [x] 2026-09-13: Checked Docker availability and official container lifecycle, networking, and storage documentation; drafted this plan without changing implementation files.
- [x] 2026-09-14: Clarified build and restore validation; exact commands and image digests remain implementation details, as requested by the user.
- [ ] Milestone 1: Build and inspect the minimal runtime image.
- [ ] Milestone 2: Add persistent Compose services and operator instructions.
- [ ] Milestone 3: Validate message publication and container lifecycle, then add CI coverage.

## Surprises & Discoveries

- The runtime already has the required process entrypoint. `node/production/src/main.mjs` loads a config path, creates the signer, and calls `startNode(..., { handleSignals: true })`. Its SIGINT/SIGTERM handling drains accepted work. The local launcher intentionally requires a loopback bind address, so it should not launch the container process, which must listen on `0.0.0.0` inside its network namespace.
- `src/server.mjs` keeps the unresolved-transaction stop condition only in memory. Restarting clears that condition. Persistence of config and IPFS content does not provide transaction recovery; an automatic restart policy would obscure this limitation.
- The default operation deadline is 180 seconds. Docker's default stop grace is 10 seconds, so container shutdown needs an explicit longer allowance. The default proposed here is four minutes. See the [Compose service reference](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
- The existing environment example also contains agent and deployer credentials. The container needs a smaller, dedicated environment file containing only node credentials and optional transport authorization values.
- Docker client 27.4.0 and Compose 2.31.0 are installed in the inspected environment. `docker version` reported that it could not connect to the daemon. No image build or container test has been performed, and no daemon was started while drafting.

## Decision Log

- Decision: Package the existing direct CLI without a new launcher, process supervisor, or runtime refactor. Rationale: `startNode()` already owns startup and shutdown, and additional wrappers would recreate the earlier signal-forwarding problem. Date/Author: 2026-09-13 / Codex, proposed for review.
- Decision: Use a Node 24 Debian slim image, locked npm dependencies, a non-root process, and Linux containers. Rationale: This matches the CI baseline and avoids adding another runtime or application dependency. Build for Linux amd64 and arm64; record which architectures were actually executed. Date/Author: 2026-09-13 / Codex.
- Decision: Use a read-only config mount and a dedicated Compose `env_file` for the existing environment-variable interface. Rationale: This requires no signer changes or secret-loader wrapper. The file stays outside the build context; Docker administrators can still inspect the process environment. This is not encrypted secret storage. Date/Author: 2026-09-13 / Codex.
- Decision: Keep Oya at `restart: "no"`, with one running instance per signing account. Kubo may use `unless-stopped`. Rationale: Content storage can restart independently, while resuming node signing requires an operator to reconcile any uncertain transaction. Date/Author: 2026-09-13 / Codex.
- Decision: Keep Ledger deployment explicit and use external Ethereum RPC for normal operation. Add Anvil only to the disposable test configuration. Rationale: Starting or replacing the node must not deploy contracts, generate a new identity, fund accounts, or reset a chain. Date/Author: 2026-09-13 / Codex.
- Decision: Build and test images without publishing them. Rationale: A registry, image namespace, and release policy have not been chosen. A locally built image is sufficient to validate deployment. Date/Author: 2026-09-13 / Codex.

## Outcomes & Retrospective

Planning is complete; all implementation milestones remain pending. The expected change is primarily packaging and operations configuration. The existing HTTP API, kernel dependencies, single-operation behavior, and transaction semantics should remain unchanged. Update this section after each milestone with files changed, validation evidence, and any remaining limits.

## Context and Orientation

The standalone application is `node/production/`. Its `package.json` and `package-lock.json` target `@oyaprotocol/ethereum` and `@oyaprotocol/messages` at 0.2.0, `@oyaprotocol/ipfs` at 0.1.2, `@oyaprotocol/utils` at 0.1.1, and ethers at 6.17.0. Complete the [Ledger naming migration](ledger-contract-rename-execplan.md), including kernel publication and registry validation, before resuming Docker implementation. The image then installs kernels from npm without compiling their source. `src/config.mjs` parses the JSON configuration and optional RPC/IPFS Authorization headers. `src/signer.mjs` reads the node key through its caller and uses ethers for transaction signing.

The direct command is `node node/production/src/main.mjs /absolute/path/to/config.json`. Startup checks the chain ID and code presence at `ledgerContract`. It does not establish that the node can afford a transaction, that the code is the intended Ledger implementation, or that IPFS publication is available.

`GET /healthz` reports public identity and local lifecycle state. Ready and busy return HTTP 200; an unknown transaction outcome or shutdown returns HTTP 503. It is not a continuous probe of Ethereum or IPFS. `POST /v1/messages` accepts `{text, signer, signature}`, verifies the signed ASCII text and allowlist, and calls the kernel's `publishAndLogSignedMessage`. Only one accepted operation runs at a time. Success means IPFS publication and a successful Ethereum receipt with the expected Ledger event. It does not mean extra confirmations or finality through a reorganization.

`scripts/local-deploy.mjs`, reached through `scripts/local-node.mjs deploy-ledger`, already supports explicit Ledger deployment and reuse. It leaves adoption of a new address to the operator. `scripts/send-message.mjs` is the existing separate agent sender. `scripts/test-local-operations.mjs` demonstrates generated accounts, Ledger deployment, exact IPFS retrieval, independent receipt/event checks, and restart validation. `scripts/smoke-local.mjs` also exercises pending transactions. These are references for the new container test; this work should not consolidate their fixture machinery.

Normal container operation needs Docker Engine, Compose, network access to Ethereum/IPFS peers, private runtime settings, a funded dedicated node account, and an allowlisted agent address. One-time Ledger deployment still needs the existing host Node.js/Foundry tooling. Container integration testing needs Node 24 and Foundry on the test host, plus Docker; it does not need an operator's accounts, existing fork, or IPFS repository. No Solidity or hardened-kernel changes are planned.

## Plan of Work

### Milestone 1: A minimal image with the existing entrypoint

Add `node/production/Dockerfile` and `node/production/.dockerignore`. Use `node/production` as the build context. The ignore file should allow only the Dockerfile, package manifests, and required `src/` files into that context. Explicit `COPY` instructions should copy those same application inputs. Operator settings, `.env` files, `.npmrc`, local `node_modules`, tests, deployment artifacts, and the rest of the repository must be excluded. Git ignore rules do not filter Docker's build context.

Use the official Node 24 Debian bookworm slim image. During implementation, resolve and record its exact available version and multi-platform digest, then pin that digest in the Dockerfile. Install with `npm ci --omit=dev --ignore-scripts`, retaining dependency licenses and avoiding npm cache in the resulting image. Public package installation needs no npm token. Do not add Foundry, Kubo, curl, TypeScript, or new npm dependencies to the Oya image.

Set the working directory to `/app`, run as the image's non-root `node` user, and use `ENTRYPOINT ["node", "src/main.mjs"]` with `CMD ["/config/node.json"]`. Node must receive SIGTERM directly as the container's main process. Docker documents the signal behavior of [exec-form entrypoints](https://docs.docker.com/reference/build-checks/json-args-recommended/).

Acceptance for this milestone is an image that imports the published packages, runs as a nonzero UID, contains only intended application inputs, and exits with the existing sanitized startup error when required configuration is absent. Inspect the image configuration and filesystem using dummy inputs. No real RPC, signer, or deployment is needed yet. Record its base digest and application image ID. Update this plan and hand off the small diff for review.

### Milestone 2: Persistent Compose services and an operator workflow

Add `node/production/compose.yaml`, `node/production/docker/config.example.json`, and `node/production/docker/runtime.env.example`. Extend `node/production/README.md` with a single Docker operating workflow. Use Compose's own commands; do not add a Docker management wrapper.

Define two services, `node` and `ipfs`, on the default Compose network. The node builds from the Dockerfile and uses the local tag `oya-node:local`. Mount the operator's config at `/config/node.json` read-only; use the long bind-mount form with host-path creation disabled so a missing config cannot silently become a directory. Keep the application root filesystem read-only, drop Linux capabilities, and disable privilege escalation. There is no node data volume because the application has no durable local state to put in it.

The container example fixes the internal HTTP port at 8787 and `host` at `0.0.0.0`. Publish it on `127.0.0.1:${OYA_HTTP_PORT:-8787}` on the Docker host. Use `http://ipfs:5001` for `ipfsUrl`; a container's `127.0.0.1` refers to itself. Supply a reachable external `rpcUrl`, its chain ID, a deployed Ledger address, and allowed agent addresses. Keep the existing 180000 ms operation deadline in the example.

Use required absolute-path variables `OYA_CONFIG_FILE` and `OYA_ENV_FILE` to select operator files outside the checkout. Read the latter through service `env_file` using `format: raw`, requiring Compose 2.30 or newer. Its template contains only `OYA_NODE_PRIVATE_KEY`, `OYA_RPC_AUTHORIZATION`, and `OYA_IPFS_AUTHORIZATION`. Document literal, unquoted `KEY=value` entries so Compose does not reinterpret authorization values. Do not duplicate those keys in Compose's `environment` section. See Docker's [environment-file guidance](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).

Default to container UID/GID `1000:1000`, with an `OYA_CONTAINER_USER` override for a different non-root owner. Document file ownership explicitly: a host file with mode 0600 is not readable by an unrelated container UID. The operator must select a matching non-root UID/GID or grant a dedicated group read access. Preserve private file contents and test actual access through the mounted container before startup; do not solve permissions by making credentials world-readable. Compose reads the environment file on the host, whereas the Node process reads the mounted JSON file. Docker administrators retain access to both kinds of settings, and expanded Compose configuration may expose environment values.

Give the node a bounded health check using Node's built-in HTTP support against `http://127.0.0.1:8787/healthz`; it must consume the response and fail on non-200 or timeout. No extra executable is needed. Set `stop_signal: SIGTERM`, `stop_grace_period: ${OYA_STOP_GRACE_PERIOD:-4m}`, and `restart: "no"`. Any increase in the operation deadline requires a corresponding grace increase with headroom. Do not attach an automatic restart-on-unhealthy service.

Use the official `ipfs/kubo` image with a verified version and pinned digest, selected and recorded during this milestone. Mount the project-scoped named volume `ipfs-data` at `/data/ipfs`. Use the server profile for first initialization and normal online operation. Publish swarm port 4001 for TCP and UDP; leave API port 5001 and gateway port 8080 unpublished. The API is available to the Oya container on the Compose network. Use a health probe through Kubo's own CLI that contacts the daemon explicitly, and make the node depend on healthy IPFS. Dependency order must allow the node to drain before Kubo stops; do not enable dependent-node restarts when IPFS restarts. See the [Kubo Docker guide](https://docs.ipfs.tech/install/run-ipfs-inside-docker/) and [Compose dependency ordering](https://docs.docker.com/compose/how-tos/startup-order/).

Give Kubo `restart: unless-stopped` and a one-minute stop grace. Use Docker's rotating `local` log driver for both services. Document `up`, `ps`, logs, deliberate node replacement, and `down` without deleting volumes. Keep the Compose project name stable because it determines which IPFS volume is reused. Explain offline backup and restore of the complete Kubo repository, including its identity and pins, separately from the operator's config/key backup. A named volume stays on its Docker host; moving an image to another host does not move its data.

The README must cover explicit Ledger deployment/reuse before node startup, gas funding, local-agent submission, and inspecting public results. The local deployment CLI requires a host-facing config with a loopback HTTP bind; do not claim it accepts the container's `0.0.0.0` config unchanged. Reuse the selected chain and Ledger address in both configurations. Never mount the agent or deployer key into the running node.

Acceptance is a valid Compose model using dummy files, readable settings under the selected non-root UID, retained IPFS identity after container recreation, bounded logs, and the documented network exposure. Full publication follows in milestone 3. For access by agents on other machines, document TLS termination and access controls at the deployment platform's proxy; adding a bundled proxy, certificates, or a cloud-specific deployment is outside this milestone.

### Milestone 3: Container publication and lifecycle validation

Add `node/production/scripts/test-docker.mjs`, a `test:docker` npm script, and `node/production/docker/compose.test.yaml`. Use Node built-ins and the existing installed ethers dependency. The test override adds a disposable Anvil service from a verified, pinned official Foundry image, runs Kubo offline, and replaces production port mappings with dynamically allocated loopback ports. It must remove the production swarm mappings, rather than accidentally retaining them through Compose merging. Ensure the node stops before Anvil as well as IPFS. Record the chosen image versions and platform support.

The harness creates a unique Compose project and private temporary configuration, sanitizes inherited Oya/deployer settings, generates independent node/deployer/agent keys, and funds only its test accounts through Anvil. It starts Anvil and IPFS first, waits for their APIs, and deploys Ledger through the existing local deployment command with a generated host-facing config. It then adopts the verified address into the generated container config and starts the actual Compose node service. Do not add contract deployment to the image entrypoint. The existing operator fork and volumes must never be touched.

Exercise the existing sender in a separate host process with only the agent key. Retrieve the exact signed JSON through Kubo and independently decode the Ethereum receipt to check Ledger address, sender, CID, and successful event. Then recreate the Oya and Kubo containers while retaining the named volume, keeping Anvil running: the node address, Ledger address, IPFS peer identity, old content, and pins must survive, and a new message must succeed without a transaction caused by startup alone.

Test Docker's real shutdown path by pausing Anvil mining, accepting a request, confirming its transaction is pending, and issuing `docker compose stop node`. Leave it pending for more than ten seconds but less than the configured receipt deadline, then mine and confirm a verified result and normal container exit. This checks the entrypoint and configured stop grace together. Also verify a disallowed signer and a concurrent busy request cause no additional node transaction.

In a separate pending-transaction case, allow the receipt deadline to expire. Confirm the HTTP unknown-outcome result, unhealthy container status, rejected subsequent work, and absence of an automatic restart. Mine and reconcile the known hash before an explicit restart. Do not merely restart to make health green. Existing host tests remain responsible for the wider failure matrix; do not reproduce all of them in Docker.

The harness must bound polling and subprocess lifetimes, clean up only its own containers/volumes, remove private fixture files, and retain only public evidence. A `--verbose` option should print stages, public addresses, CIDs, transaction hashes, and checks, following the existing local test's style. Raw environment files, image/container inspection output containing credentials, private keys, and provider errors must not enter retained output.

Extend `.github/workflows/test.yml` with a container-validation job using Node 24 and host Foundry. Keep existing host tests. Build and run the flow on Linux amd64; also build the Oya image for Linux arm64 with Buildx, Docker's multi-platform builder. Do not push images or provide registry credentials. Execute the flow on an arm64 Docker host when available, and distinguish a successful cross-build from an executed test in the evidence. Do not require native arm64 availability for the amd64 job.

Acceptance is the complete observable flow below, including storage persistence and real Docker SIGTERM behavior. Finish the operator README with commands actually exercised, the tested version/platform matrix, a verified Kubo backup/restore procedure, and any unresolved platform limitation. Keep this plan current before the review handoff.

## Concrete Steps

All commands below run from the repository root unless stated otherwise. Commands referencing new files or `test:docker` become available only in their corresponding milestone.

First check prerequisites and existing host behavior:

```sh
docker version
docker compose version
docker buildx version
node --version
forge --version
npm --prefix node/production ci --ignore-scripts
npm --prefix node/production test
```

Require a reachable Linux Docker daemon and Compose 2.30 or newer. Use Node 24 for validation. If the daemon is unavailable, record the missing prerequisite and leave container checks pending; do not report a build or test as passing.

For milestone 1, build the image and inspect its public execution configuration:

```sh
docker build --tag oya-node:local node/production
docker image inspect oya-node:local --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .Config.User}}'
docker run --rm --entrypoint node oya-node:local --input-type=module -e 'await import("@oyaprotocol/messages"); console.log(process.version, process.getuid())'
docker run --rm oya-node:local
```

The import check must report Node 24 and a nonzero UID. The last command intentionally lacks configuration and should exit nonzero with the sanitized startup error. It must not remain running.

For milestone 2, prepare an operator-owned directory outside the checkout. Copy the two Docker examples there as `node.json` and `node.env`, fill in actual settings without printing them, and restrict file access. Set these variables in the operator's shell, substituting actual absolute paths; the following `/path/to/...` values are placeholders:

```sh
export OYA_CONFIG_FILE=/path/to/private-oya/node.json
export OYA_ENV_FILE=/path/to/private-oya/node.env
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
docker compose -p oya -f node/production/compose.yaml config --quiet
docker compose -p oya -f node/production/compose.yaml build node
docker compose -p oya -f node/production/compose.yaml run --rm --no-deps --entrypoint node node -e 'require("node:fs").readFileSync("/config/node.json"); console.log("Config is readable")'
```

The UID/GID example assumes a non-root POSIX operator and compatible bind-mount ownership. Document the explicit numeric equivalent for Windows/Docker Desktop and verify access there rather than assuming Unix permissions transfer unchanged. Use `config --quiet`; do not print the expanded service environment.

When a Ledger must be deployed, prepare a separate host-facing config and deployer environment outside the checkout, then use the existing command explicitly:

```sh
npm --prefix node/production run local -- deploy-ledger --config /path/to/private-oya/deploy.json --env-file /path/to/private-oya/deployer.env
npm --prefix node/production run local -- deploy-ledger --broadcast --config /path/to/private-oya/deploy.json --env-file /path/to/private-oya/deployer.env
```

These commands use the configured Ethereum chain; the second can spend funds. During implementation validation they must target only the disposable Anvil chain and a generated deployment key. For a real deployment the operator selects the chain and funds the account. If code already exists at the configured Ledger address, the command reports reuse. Adopt any newly verified Ledger address manually in the node config. Authenticated-RPC deployment testing remains outside scope.

After configuration, Ledger adoption, and node funding, the operating commands are:

```sh
docker compose -p oya -f node/production/compose.yaml up -d
docker compose -p oya -f node/production/compose.yaml ps
docker compose -p oya -f node/production/compose.yaml logs --follow node
```

Stopping log-following does not stop the services. From a separate terminal, with only the agent key loaded into `OYA_AGENT_PRIVATE_KEY`, use the existing sender:

```sh
node node/production/scripts/send-message.mjs http://127.0.0.1:8787 /path/to/message.txt
docker compose -p oya -f node/production/compose.yaml exec ipfs ipfs pin ls --type=recursive
docker compose -p oya -f node/production/compose.yaml exec ipfs ipfs cat /ipfs/REPLACE_WITH_RETURNED_CID
docker compose -p oya -f node/production/compose.yaml stop node
docker compose -p oya -f node/production/compose.yaml down
```

The sender requires the host npm installation, appends `/v1/messages` to the supplied base URL, returns the existing JSON result, and exits zero only on HTTP 200. Host port 8787 assumes the default. Substitute the returned CID in the retrieval command. A deliberate node replacement after reconciliation uses `docker compose -p oya -f node/production/compose.yaml up -d --no-deps --force-recreate node`. This also reloads changed settings; `docker compose restart` does not apply a changed service environment.

For milestone 3:

```sh
git submodule update --init lib/forge-std
forge build --root contracts
npm --prefix node/production run test:docker -- --verbose
npm --prefix node/production test
git diff --check
```

The new test owns all its fixtures and must fail clearly if required tools are missing. It should not ask the operator to supply production credentials or reuse a background Anvil instance.

Build validation must cover Linux amd64 and arm64 without publishing images, recording separately which platforms ran the integration flow. Restore validation must stop the node and Kubo, back up the complete repository, restore into a fresh fixture-owned volume, and verify the peer identity, pins, and message bytes. Resolve image digests and document the exact tested commands in the README during the corresponding implementation milestone; record results here. These checks remain pending until executed.

## Validation and Acceptance

Completion requires observable evidence for the following behaviors:

1. A clean image build installs the locked published packages without kernel source builds, authentication, or extra npm dependencies. Image configuration uses direct Node execution and a non-root user; private files never enter the build context or layers.
2. Compose starts the configured node and Kubo, publishes only the documented ports, and reports node identity through health. Missing settings, unreadable config, or a wrong chain fail clearly. Healthy status is described accurately as local lifecycle status.
3. A separate agent gets a verified publication response. Retrieved IPFS bytes match the signed envelope, and independent receipt decoding confirms the corresponding Ledger event. Unauthorized and busy requests do not submit another transaction.
4. Recreating containers with the same configuration and named volume preserves node identity, Kubo identity, pinned content, and the ability to publish again. Test the documented cold backup by restoring it into a fresh, fixture-owned Kubo volume and retrieving the earlier CID.
5. A pending publication survives Docker's normal ten-second window during an explicit stop, finishes within the selected grace, and exits normally without being killed. Unknown-outcome health stays unhealthy until the operator reconciles and deliberately restarts; health failure does not trigger automatic signing resumption.
6. Container tests and existing host tests pass on the recorded platform. An arm64 build is recorded separately from native execution. CI builds/tests without publishing images or uploading private fixture data.

Offline Kubo validation proves publication, pinning, and retrieval within the stack. It does not establish discoverability from unrelated public IPFS peers. A live operator must use online Kubo and check peer connectivity and independent retrieval before relying on public availability. Pinning on one host is not a backup or replicated storage guarantee.

## Idempotence and Recovery

Repeated image builds and dependency installation do not deploy contracts. Repeated Compose starts with the same project reuse its named volume. Ordinary `docker compose down` retains named volumes; `down --volumes` deletes them. Restrict destructive cleanup to the test harness's uniquely named project. See [Docker's down command reference](https://docs.docker.com/reference/cli/docker/compose/down/).

Before changing images or settings, stop the node and let accepted work finish. If shutdown was forced, the host failed, or the outcome is unknown, inspect the available result/log transaction hash, transaction receipt, Ledger event, and account nonce before restarting or retrying. A request with no final client response may still have succeeded. Resubmitting the same signed text can create another paid Ledger transaction. Do not run two containers with the same node account, including during rolling replacement or migration to another host.

For node rollback, preserve the config/key and previous image ID, stop the current instance, reconcile any pending work, and start the previous image with the same settings. Node image updates and Kubo updates should be separate operations. Before a Kubo upgrade or host migration, stop writers and Kubo, back up the complete repository volume with ownership intact, and retain the old image/version information. Restore into a separate volume for verification. An image downgrade alone is not a repository-format rollback.

Changing the signing key intentionally changes the node identity and needs new gas funding. Losing the key cannot be repaired from IPFS content. Losing IPFS data cannot be repaired from a CID in Ledger alone. Keep operator settings/key backups private and separate from public deployment evidence. Docker provides storage and process controls; durable automatic transaction reconciliation remains future work.

## Artifacts and Notes

Planned implementation files are `node/production/Dockerfile`, `node/production/.dockerignore`, `node/production/compose.yaml`, the three files under `node/production/docker/`, and `node/production/scripts/test-docker.mjs`. Existing `node/production/README.md`, `node/production/package.json`, `.github/workflows/test.yml`, and this plan receive focused updates. No package release, contract modification, or production credential change is part of this work.

Record public image digests, tested platform/tool versions, relevant exit statuses, CIDs, transaction hashes, and pass/fail evidence as milestones finish. Keep real environment files, endpoint credentials, account keys, private artifact paths, and full container inspection output out of the plan and committed documentation. Use repository-relative paths or placeholders for examples.

Current evidence is limited to source review, official documentation, and client availability checks. Docker reported an unavailable daemon; the initial working tree was clean. No Docker acceptance result is claimed yet.

## Interfaces and Dependencies

The image preserves `startNode(config, signer, options)`, the direct CLI config-path argument, `GET /healthz`, and `POST /v1/messages`. It continues to use the current published kernel versions and ethers through the lockfile. The runtime API and config schema do not gain Docker-specific fields.

Compose inputs are `OYA_CONFIG_FILE` and `OYA_ENV_FILE` (required absolute file paths), `OYA_CONTAINER_USER` (default `1000:1000`), `OYA_HTTP_PORT` (default 8787), and `OYA_STOP_GRACE_PERIOD` (default `4m`). Application credentials remain `OYA_NODE_PRIVATE_KEY` and optional `OYA_RPC_AUTHORIZATION` / `OYA_IPFS_AUTHORIZATION`. Agent and Ledger-deployer credentials belong only to their separate tools.

Additional operational dependencies are Docker Engine with Linux containers, Compose 2.30+, Buildx for multi-platform validation, and the pinned official Node/Kubo images. The container test additionally uses the official Foundry image for Anvil and host Node 24/Foundry for the existing sender and deployer. There are no new application npm dependencies, no Docker socket mounted into services, and no registry credentials required for public dependency pulls or local image builds.
