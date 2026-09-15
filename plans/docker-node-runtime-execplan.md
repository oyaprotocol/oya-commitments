# Package a deployable Docker runtime for the log-only node

This ExecPlan is a living document maintained according to `PLANS.md`. The user authorized milestones 1 and 2 on 2026-09-14 and milestone 3 on 2026-09-15, with small diffs for manual line-by-line review. Work proceeds in the milestones below, with a review handoff after each milestone.

## Purpose / Big Picture

An operator should be able to build the Oya node image, configure an instance, and run it on a Linux Docker host without installing Node.js or the kernel packages on that host. Docker Desktop should support the same workflow for development on macOS or Windows using Linux containers. A locally running agent can submit a signed message through the published HTTP port and receive the existing verified IPFS/Ledger publication result.

Docker Compose, which describes related containers, networking, and storage in one file, will run the Oya process alongside Kubo, the IPFS service. The node's signing identity and configuration live outside the image. Kubo's repository lives in a named Docker volume that survives container replacement. Ethereum comes from an operator-supplied RPC endpoint with an already deployed Ledger and a funded node account.

This delivers a deployable, manually supervised log-only instance. It does not add durable transaction recovery, unattended node restarts, reimbursement verification, or a hosted service. A disposable Anvil chain will support container validation. Registry publication and a permanent deployment using real credentials are separate follow-up actions.

After milestone 3 proves that internal end-to-end flow, follow-up milestones add external HTTP access over HTTPS for users and agents. They preserve the existing signed-message format, `allowedSigners`, and independent processing of repeated submissions. General request limits bound incoming traffic. Sender funding, payment workflows, and duplicate suppression are outside this follow-up scope. Milestones 1–3 retain their existing scope and order.

## Progress

- [x] 2026-09-13 07:01Z: Reviewed plan requirements, the direct runtime entrypoint, configuration, existing deployment/publication tests, and current CI.
- [x] 2026-09-13: Checked Docker availability and official container lifecycle, networking, and storage documentation; drafted this plan without changing implementation files.
- [x] 2026-09-14: Clarified build and restore validation; exact commands and image digests remain implementation details, as requested by the user.
- [x] 2026-09-14: Rechecked status against the working tree at `1696f89`. Docker implementation files, `test:docker`, and container CI are still absent; the dependency pins match this plan. Docker remains unreachable. This status review did not rerun host tests or execute container validation.
- [x] 2026-09-14: User authorized milestone 1. Added the minimal Dockerfile and explicit build-input allowlist; started Docker Desktop and resolved the official Node 24.21.0 bookworm slim multi-platform digest.
- [x] 2026-09-14: Milestone 1 validation passed on Linux arm64: image build, all five dependency imports and licenses, UID/GID 1000:1000, direct Node PID 1, exact application files, no npm cache, and sanitized missing-config exit 1. A disposable build-context fixture retained exactly eight allowed files and excluded all 14 dummy artifacts. All 89 host tests passed under Node 24.21.0 with no skips; whitespace checks passed. Ready for human review.
- [x] 2026-09-14: User authorized milestone 2 and selected current stable Kubo 0.43.0. Verified the official release and amd64/arm64 image manifests; added Compose services and private-setting examples.
- [x] 2026-09-14: Milestone 2 complete: added the operator workflow and validated the Compose model, required files, raw environment values, read-only mounts, non-root file access, health-probe failures/timeouts, and startup on Linux arm64. Kubo identity, pins, and exact dummy content survived recreation and ordinary down/up. The documented cold backup restored into a fresh project volume with matching identity, content, UID/GID, and mode. All 89 host tests and whitespace checks passed. Ready for the requested human review.
- [x] 2026-09-14: Updated the host integration baseline to Kubo 0.43.0 at the user's request. Both local integration flows passed under Node 24.21.0, and both reject Kubo 0.40.1 before starting services. Regenerated all nine CID fixtures with 0.43.0; their CIDs are unchanged. Package build, 21 targeted package tests, and all 89 production host tests passed.
- [x] 2026-09-15: Milestone 3 implementation and local validation: added the Docker harness, test overlay, npm command, operator instructions, and container CI job. Complete publication/lifecycle/restore flows passed on native arm64 and emulated amd64 with Node 24.21.0, Foundry 1.5.1, and Kubo 0.43.0. Hardened-contract build, all 89 host tests, and a separate arm64 Buildx OCI export passed.
- [ ] Milestone 3 hosted validation: run the new container CI job on its native amd64 Ubuntu runner when the branch is published. Native Linux host permissions and Windows file sharing remain unverified.
- [x] 2026-09-14: Added the user-requested external HTTP follow-up plan after milestone 3. This update changes planning only; repeated signed messages remain expected behavior under general request limits and `allowedSigners`.
- [x] 2026-09-14: Clarified configurable proxy deadlines, aligned shutdown grace periods, and required coverage for an operation timeout above four minutes. Implementation and proxy-path tests remain pending in milestones 5–6.
- [ ] Milestone 4, after milestone 3 passes: Add configurable general message-request limits.
- [ ] Milestone 5, after milestone 4 passes: Add HTTPS proxy configuration and external-client operating instructions.
- [ ] Milestone 6, after milestone 5: Validate the complete flow through HTTPS and document a check from another machine.

## Surprises & Discoveries

- Docker Desktop supports executing both selected image architectures here: the daemon is arm64, so the amd64 flow ran under emulation. The harness verifies the built image platform and reports the daemon architecture separately. OCI export was also verified with a disposable `docker-container` Buildx builder, matching the new CI job's driver; its export and builder were removed afterward.
- External ingestion can reuse `POST /v1/messages` and `scripts/send-message.mjs`; the present deployment publishes the API only on host loopback. Existing body/time/connection limits and one-operation admission bound individual work, but there is no general request-rate limit. Repeated signed envelopes already produce independent successful results, as checked by `scripts/smoke-local.mjs`; the user explicitly confirmed this behavior is intended.
- The host integration scripts previously selected any `ipfs` on `PATH`, which still resolved to 0.40.1 after Compose moved to 0.43.0. The installed CLI is now 0.43.0. Regenerating the package fixtures with offline `add --only-hash --quieter`, the committed import options, and `pin=false` produced the same nine CIDs.
- The runtime already has the required process entrypoint. `node/production/src/main.mjs` loads a config path, creates the signer, and calls `startNode(..., { handleSignals: true })`. Its SIGINT/SIGTERM handling drains accepted work. The local launcher intentionally requires a loopback bind address, so it should not launch the container process, which must listen on `0.0.0.0` inside its network namespace.
- `src/server.mjs` keeps the unresolved-transaction stop condition only in memory. Restarting clears that condition. Persistence of config and IPFS content does not provide transaction recovery; an automatic restart policy would obscure this limitation.
- The default operation deadline is 180 seconds. Docker's default stop grace is 10 seconds, so container shutdown needs an explicit longer allowance. The default proposed here is four minutes. See the [Compose service reference](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
- The existing environment example also contains agent and deployer credentials. The container needs a smaller, dedicated environment file containing only node credentials and optional transport authorization values.
- Docker client 27.4.0 and Compose 2.31.0 are installed in the inspected environment. `docker version` reported that it could not connect to the daemon. No image build or container test has been performed, and no daemon was started while drafting.
- The 2026-09-14 status review confirmed the same Docker connection failure and found Buildx 0.19.2 and Foundry 1.5.1 available. The default shell resolves Node 23.10.0; select Node 24 explicitly for the planned host validation.
- During milestone 1, starting Docker Desktop made its Linux arm64 daemon available. Docker socket access and host npm registry access required execution outside the sandbox. The resulting image built successfully, and the host suite passed after installing the locked dependencies under Node 24.21.0.
- Docker Desktop remapped the mode-0600 bind-mounted config's owner to the selected container UID, so a UID mismatch did not reproduce native Linux denial. A mode-000 config was unreadable, and both the config mount and application filesystem rejected writes. The guide requires an actual mount-access check and distinguishes Desktop sharing from native Linux ownership.

## Decision Log

- Decision: Use Foundry 1.5.1 for the disposable Anvil image and the new CI job, matching the existing host validation baseline. Pin the verified amd64/arm64 image index, override its shell entrypoint with direct Anvil execution, and generate/fund only fixture accounts. Rationale: This keeps deployment behavior reproducible across platforms without changing the production image or adding host Kubo requirements. Date/Author: 2026-09-15 / Codex.
- Decision: Make the proxy response deadline configurable and require at least one minute of headroom above the configured `operationTimeoutMs`, with aligned shutdown grace periods. Rationale: Accepted work continues after a client disconnects, so longer operation settings must not cause avoidable proxy failures while the node is still completing valid work. Repeated submissions remain expected behavior. Date/Author: 2026-09-14 / user direction, recorded by Codex.
- Decision: Schedule external HTTP work as milestones 4–6 after the existing internal Docker validation. Preserve signature verification, `allowedSigners`, and intentional repeated submissions; apply limits to incoming requests generally. Rationale: The user requested follow-ups rather than changing the current end-to-end milestone, and excluded sender-funding concerns and duplicate prevention. Keep each follow-up separately reviewable. Date/Author: 2026-09-14 / user direction, recorded by Codex.
- Decision: Use a small application-level request counter and an optional Compose overlay with the official Caddy HTTPS proxy. Rationale: A process-wide counter needs no per-client database or proxy plugin, and the overlay preserves the internal Compose workflow while providing a reproducible external entrypoint. Date/Author: 2026-09-14 / Codex.
- Decision: Require Kubo 0.43.0 in both host integration scripts and verify the fixture daemon version. Rationale: The user requested the same baseline as Compose; checking `ipfs` before starting services prevents silent use of another version from `PATH`. Keep this to small checks in the existing scripts. Date/Author: 2026-09-14 / Codex.
- Decision: Package the existing direct CLI without a new launcher, process supervisor, or runtime refactor. Rationale: `startNode()` already owns startup and shutdown, and additional wrappers would recreate the earlier signal-forwarding problem. Date/Author: 2026-09-13 / Codex; implemented in the user-authorized milestone 1 on 2026-09-14.
- Decision: Use a Node 24 Debian slim image, locked npm dependencies, a non-root process, and Linux containers. Rationale: This matches the CI baseline and avoids adding another runtime or application dependency. Build for Linux amd64 and arm64; record which architectures were actually executed. Date/Author: 2026-09-13 / Codex.
- Decision: Use a read-only config mount and a dedicated Compose `env_file` for the existing environment-variable interface. Rationale: This requires no signer changes or secret-loader wrapper. The file stays outside the build context; Docker administrators can still inspect the process environment. This is not encrypted secret storage. Date/Author: 2026-09-13 / Codex.
- Decision: Keep Oya at `restart: "no"`, with one running instance per signing account. Kubo may use `unless-stopped`. Rationale: Content storage can restart independently, while resuming node signing requires an operator to reconcile any uncertain transaction. Date/Author: 2026-09-13 / Codex.
- Decision: Keep Ledger deployment explicit and use external Ethereum RPC for normal operation. Add Anvil only to the disposable test configuration. Rationale: Starting or replacing the node must not deploy contracts, generate a new identity, fund accounts, or reset a chain. Date/Author: 2026-09-13 / Codex.
- Decision: Build and test images without publishing them. Rationale: A registry, image namespace, and release policy have not been chosen. A locally built image is sufficient to validate deployment. Date/Author: 2026-09-13 / Codex.
- Decision: Pin Kubo 0.43.0 by its multi-platform image digest. Rationale: The user requested the current stable release for this new deployment; the host fixture's older Kubo version is not a compatibility requirement. The [official release](https://github.com/ipfs/kubo/releases/tag/v0.43.0) and registry manifests were verified before selection. Date/Author: 2026-09-14 / Codex.
- Decision: Keep milestone 1 to a 13-line Dockerfile and 12-line `.dockerignore`, plus this progress record. Explicitly allow the five current runtime modules, keep installed code root-owned, and remove npm's cache in the installation layer. Rationale: This keeps the human review small, excludes unlisted files even under `src/`, and gives the runtime user read access without ownership of the application. A new runtime module must be added to the allowlist. Date/Author: 2026-09-14 / Codex.

## Outcomes & Retrospective

Milestone 1 is implemented and validated, ready for manual line-by-line review. `node/production/Dockerfile` packages the existing CLI with locked dependencies, and `.dockerignore` restricts the build inputs. The image runs as a non-root user and fails cleanly without configuration. A fresh host test run passed all 89 tests. Runtime source, manifests, and lockfile are unchanged.

Milestone 2 adds a 73-line Compose file, 17 lines of example settings, and an operator guide covering configuration, deployment prerequisites, operation, replacement, and cold backup/restore. Its validation ran the actual node against a disposable RPC fixture that permits only startup reads, alongside offline Kubo 0.43.0. Storage identity, pins, content, and ownership survived the documented lifecycle and restore operations. The fixture removed its two projects, volumes, and private files. No runtime source, npm dependencies, or operator settings changed.

The host integration follow-up adds small version checks to `scripts/test-local-operations.mjs` and `scripts/smoke-local.mjs`, includes `kuboVersion` in their existing evidence, and documents the matching prerequisite. On macOS under Node 24.21.0, `npm --prefix node/production run test:local -- --verbose` and `npm --prefix node/production run smoke:local` passed against Kubo 0.43.0. Both scripts reject 0.40.1 before starting services. The CID fixture values remain unchanged after regeneration; only their version metadata and documentation changed. `npm --prefix packages run build`, `node --test packages/ipfs/test/cids.test.js packages/utils/test/cid.test.js packages/messages/test/cid-flow.test.js packages/ethereum/test/log-cid.test.js` (21 tests), and `npm --prefix node/production test` (89 tests) passed.

Milestone 3 implements a repository-owned Docker harness and small test overlay, reusing the existing deployment CLI and sender. Native arm64 and emulated amd64 runs verified signed publication, exact IPFS bytes and Ledger events, container recreation with persistent identity/pins/content, busy and unauthorized rejection, draining a pending transaction beyond ten seconds during SIGTERM, and cold backup restore with matching ownership/mode. A receipt timeout left the container unhealthy without restarting; its receipt was mined and verified before a deliberate restart accepted new work. All 89 host tests and a separate arm64 OCI export passed. The new CI job is configured for native amd64 execution and an arm64 cross-build; its first hosted run is pending. No image was published and no live deployment was performed.

The external-access extension remains planned only, following milestone 3's review and hosted validation. Milestones 4–6 add general message limits, HTTPS routing, and validation from an external client's perspective. Their acceptance includes repeated identical signed requests succeeding independently when capacity is available, plus proxy response and shutdown coverage with longer-than-default operation timeouts. Milestone 3 changes no runtime source or production Compose services.

## Context and Orientation

The standalone application is `node/production/`. Its `package.json` and `package-lock.json` target `@oyaprotocol/ethereum` and `@oyaprotocol/messages` at 0.2.0, `@oyaprotocol/ipfs` at 0.1.2, `@oyaprotocol/utils` at 0.1.1, and ethers at 6.17.0. The [Ledger naming migration](ledger-contract-rename-execplan.md) includes completed kernel publication and registry validation. The image installs kernels from npm without compiling their source. `src/config.mjs` parses the JSON configuration and optional RPC/IPFS Authorization headers. `src/signer.mjs` reads the node key through its caller and uses ethers for transaction signing.

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

### Milestone 4: General limits on received message requests

Begin only after milestone 3 passes and its internal end-to-end evidence is recorded. Extend `node/production/src/config.mjs` and `node/production/src/server.mjs`, add focused cases in `node/production/test/http-limits.test.mjs`, and document the setting in `node/production/README.md`. Keep the limiter in the existing runtime files so the image's source allowlist and kernel packages stay unchanged.

Add a positive integer `maxMessageRequestsPerMinute`, defaulting to 60. Use one process-wide counter in fixed 60-second windows, measured with a monotonic clock. Count every `POST /v1/messages` attempt before reading its body or verifying its signature, including malformed, disallowed, busy, and repeated requests. Once exhausted, return HTTP 429 with `{ "code": "rate_limited", "started": false }`, a `Retry-After` value for the remaining window, and a closed connection so an unread body cannot keep the connection occupied. Health checks and other routes do not consume this budget. The counter resets on process restart; document that fixed windows permit bursts across a boundary. Retain existing body-size, body-timeout, connection, and single-operation limits.

Requests admitted by the counter must still pass the existing signature and `allowedSigners` checks. Do not interpret a repeated signature or CID as a reason to reject a request. Acceptance covers configuration validation, the exact threshold and reset boundary using a controlled clock, no publication on a limited request, continued health checks at the limit, and normal authorization failures below the limit. Repeated valid messages below the limit must still be processed independently. Run the production host tests and the existing internal Docker flow before this milestone's review handoff.

### Milestone 5: External HTTPS access and operator instructions

Add `node/production/docker/compose.http.yaml` and `node/production/docker/Caddyfile`, plus the corresponding README instructions. A reverse proxy receives public HTTPS requests and forwards their HTTP requests to the node. The overlay adds a `proxy` service using an official Caddy image whose version and multi-platform digest are verified and pinned during implementation. Bind-mount the repository's Caddyfile read-only, publish TCP ports 80 and 443, and retain Caddy's certificate state and configuration in project-scoped named volumes. Use the required `OYA_PUBLIC_HOSTNAME` input for the operator's hostname. The base Compose file keeps the node's host-loopback mapping and Kubo's unpublished API/gateway ports.

Forward the exact `/v1/messages` path to `node:8787` on the Compose network, preserving the method, signed body, status, and `Retry-After` response. Keep other public paths closed; existing internal health checks remain available. Serve clients over HTTPS and redirect plain HTTP to HTTPS. Keep proxy retries disabled so repeated requests remain under client control. Bound proxy logs and avoid logging signed request bodies or credentials. See the [Caddy reverse-proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [automatic HTTPS guidance](https://caddyserver.com/docs/automatic-https).

Make the proxy response deadline configurable through `OYA_PROXY_RESPONSE_TIMEOUT`, defaulting to `4m`. Require its resolved duration to be at least `operationTimeoutMs + 60_000` milliseconds; document this comparison and the necessary overrides whenever the operator changes `operationTimeoutMs`. Set the proxy's shutdown drain allowance at least as long as its response deadline, and give Docker's proxy stop grace additional time for the process to exit. Keep the node's `OYA_STOP_GRACE_PERIOD` above its configured operation deadline with headroom. Order shutdown so the proxy drains while the node and Kubo remain available.

Document DNS, inbound firewall access for ports 80/443, certificate renewal/storage, starting and stopping the overlay, and selecting allowed signer addresses. Show external users and agents signing locally with the existing sender and submitting to `https://node.example.com/v1/messages`; their private keys stay with their clients. Explain HTTP 429 and the existing busy response, and explicitly document that deliberate identical submissions are accepted subject to the same limits. Initial clients use the existing HTTP sender; a separately hosted browser frontend would need an explicit origin policy and CORS preflight support in its own follow-up. Acceptance for this milestone is valid merged configuration, a correctly routed proxy, and reviewable operating instructions; complete proxy-path validation follows in milestone 6.

### Milestone 6: Validate external-client message reception

Extend the milestone 3 harness with an `--http` mode, exposed as `npm --prefix node/production run test:http`, and add `node/production/docker/compose.http.test.yaml`. Reuse the existing disposable Anvil/Kubo/node setup and cleanup. The test overlay changes listener settings to dynamic loopback ports and selects `localhost` for Caddy's local certificate issuer; exercise the production proxy routing and message limits. Trust the fixture's generated CA only in test clients, with no host trust-store edits or disabled TLS verification. All reusable harness logic and configuration belong in the repository; generated keys, certificates, and service data remain disposable fixtures.

Send from a separate client process through HTTPS, verifying the returned result, exact IPFS envelope, and Ledger event as in milestone 3. Submit the identical signed envelope again after the first completes: require another successful result with the same CID and an independent Ledger event. Cover malformed and disallowed signatures, request-size limits, HTTP 429 and recovery, busy responses, pending-operation response/shutdown timing, and the absence of proxy-generated resubmissions. Inspect the merged model and running containers to verify the node's loopback-only host binding and Kubo's unpublished API/gateway ports. Add this mode to the existing container CI job and retain the original internal flow.

Include a nondefault `operationTimeoutMs` above four minutes with matching proxy and shutdown overrides. Verify the resolved timeout relationships, then keep an accepted operation pending beyond the old four-minute proxy deadline and complete it before its configured operation and receipt deadlines. Require the final successful response to reach the client and the same deadline relationships to permit graceful shutdown without terminating accepted work.

Finish the README with the tested proxy version, TLS/port setup, and a command for a sender on another machine. Record a real remote-host check separately from the local HTTPS fixture when an operator-selected host, hostname, and allowed signer are available; verify from that machine that the node port and Kubo API/gateway cannot be reached directly. Until then, report that live reachability as pending; do not deploy to an unspecified host or substitute a localhost test for that evidence. This check adds no sender-funding or payment step. Keep this final validation diff separate from the request limiter and proxy configuration for human review.

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

After milestone 3 passes, validate milestone 4 with `npm --prefix node/production test` and `npm --prefix node/production run test:docker -- --verbose`. For milestone 5, retain the existing private config/environment inputs and substitute an operator-owned hostname for the placeholder below. The first command checks the merged model without printing credentials; starting public services is a later operator action after DNS and certificate prerequisites are satisfied:

```sh
export OYA_PUBLIC_HOSTNAME=node.example.com
docker compose -p oya -f node/production/compose.yaml -f node/production/docker/compose.http.yaml config --quiet
docker compose -p oya -f node/production/compose.yaml -f node/production/docker/compose.http.yaml up -d --build
```

For milestone 6, run `npm --prefix node/production run test:http -- --verbose` and `npm --prefix node/production test` from the repository root. The HTTPS fixture requires no public DNS or real credentials. Once a real hostname is configured, a separate machine with Node 24 and the repository's installed sender dependencies can run the following command, substituting its hostname and private client-file paths:

```sh
node --env-file=/absolute/path/to/agent.env node/production/scripts/send-message.mjs https://node.example.com /absolute/path/to/message.txt
```

The client environment contains its own `OYA_AGENT_PRIVATE_KEY`, whose address is in the node's `allowedSigners`. Require a successful result and verify its published content and Ledger event. Repeating the same command after completion is an intended new submission, subject to general rate and capacity limits.

## Validation and Acceptance

Completion requires observable evidence for the following behaviors:

1. A clean image build installs the locked published packages without kernel source builds, authentication, or extra npm dependencies. Image configuration uses direct Node execution and a non-root user; private files never enter the build context or layers.
2. Compose starts the configured node and Kubo, publishes only the documented ports, and reports node identity through health. Missing settings, unreadable config, or a wrong chain fail clearly. Healthy status is described accurately as local lifecycle status.
3. A separate agent gets a verified publication response. Retrieved IPFS bytes match the signed envelope, and independent receipt decoding confirms the corresponding Ledger event. Unauthorized and busy requests do not submit another transaction.
4. Recreating containers with the same configuration and named volume preserves node identity, Kubo identity, pinned content, and the ability to publish again. Test the documented cold backup by restoring it into a fresh, fixture-owned Kubo volume and retrieving the earlier CID.
5. A pending publication survives Docker's normal ten-second window during an explicit stop, finishes within the selected grace, and exits normally without being killed. Unknown-outcome health stays unhealthy until the operator reconciles and deliberately restarts; health failure does not trigger automatic signing resumption.
6. Container tests and existing host tests pass on the recorded platform. An arm64 build is recorded separately from native execution. CI builds/tests without publishing images or uploading private fixture data.

Items 1–6 remain the milestone 3 acceptance gate. Only after they pass, the external HTTP follow-ups add these requirements:

7. A configurable general request limit returns HTTP 429 before publication when exhausted, resets as documented, and leaves health checks usable. Signature verification and `allowedSigners` continue to gate every accepted message. Repeated signed messages remain eligible and count like other requests.
8. An external client submits through verified HTTPS and receives the existing publication result. Proxy-path tests establish rejection behavior, timeout/shutdown handling at both default and longer operation timeouts, repeated-message success, and the intended port exposure. CI covers the fixture; actual reachability from another machine is separately recorded or explicitly pending operator deployment details.

Offline Kubo validation proves publication, pinning, and retrieval within the stack. It does not establish discoverability from unrelated public IPFS peers. A live operator must use online Kubo and check peer connectivity and independent retrieval before relying on public availability. Pinning on one host is not a backup or replicated storage guarantee.

## Idempotence and Recovery

For the HTTP follow-ups, intentional repeated signed submissions are expected independent operations. Do not add replay rejection or deduplication. Limits reset with the process as documented. To withdraw external access, stop only the overlay's `proxy` service; preserve the node/Kubo state and certificate volumes. Restore the previous proxy configuration and validate the merged Compose model before enabling access again.

Repeated image builds and dependency installation do not deploy contracts. Repeated Compose starts with the same project reuse its named volume. Ordinary `docker compose down` retains named volumes; `down --volumes` deletes them. Restrict destructive cleanup to the test harness's uniquely named project. See [Docker's down command reference](https://docs.docker.com/reference/cli/docker/compose/down/).

Before changing images or settings, stop the node and let accepted work finish. If shutdown was forced, the host failed, or the outcome is unknown, inspect the available result/log transaction hash, transaction receipt, Ledger event, and account nonce before restarting or retrying. A request with no final client response may still have succeeded. Resubmitting the same signed text can create another paid Ledger transaction. Do not run two containers with the same node account, including during rolling replacement or migration to another host.

For node rollback, preserve the config/key and previous image ID, stop the current instance, reconcile any pending work, and start the previous image with the same settings. Node image updates and Kubo updates should be separate operations. Before a Kubo upgrade or host migration, stop writers and Kubo, back up the complete repository volume with ownership intact, and retain the old image/version information. Restore into a separate volume for verification. An image downgrade alone is not a repository-format rollback.

Changing the signing key intentionally changes the node identity and needs new gas funding. Losing the key cannot be repaired from IPFS content. Losing IPFS data cannot be repaired from a CID in Ledger alone. Keep operator settings/key backups private and separate from public deployment evidence. Docker provides storage and process controls; durable automatic transaction reconciliation remains future work.

## Artifacts and Notes

Planned implementation files are `node/production/Dockerfile`, `node/production/.dockerignore`, `node/production/compose.yaml`, the three files under `node/production/docker/`, and `node/production/scripts/test-docker.mjs`. Existing `node/production/README.md`, `node/production/package.json`, `.github/workflows/test.yml`, and this plan receive focused updates. No package release, contract modification, or production credential change is part of this work.

After those milestones, external-access files are `node/production/test/http-limits.test.mjs`, `node/production/docker/compose.http.yaml`, `node/production/docker/Caddyfile`, and `node/production/docker/compose.http.test.yaml`. Focused edits extend the existing runtime config/server, Docker harness, npm scripts, CI job, and operator README. The original milestone 3 fixture remains independently runnable.

Record public image digests, tested platform/tool versions, relevant exit statuses, CIDs, transaction hashes, and pass/fail evidence as milestones finish. Keep real environment files, endpoint credentials, account keys, private artifact paths, and full container inspection output out of the plan and committed documentation. Use repository-relative paths or placeholders for examples.

Milestone 1 evidence (2026-09-14):

- Base: [official Node image](https://hub.docker.com/_/node), `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`. `docker buildx imagetools inspect node:24.21.0-bookworm-slim` confirmed Linux amd64 and arm64 manifests in this index.
- Build: `docker build --tag oya-node:local node/production` passed using Docker Desktop 4.37.2 / Engine 27.4.0 on Linux arm64. The application build context was 25.25 kB; npm installed 16 locked packages without authentication or lifecycle scripts.
- Local image ID: `sha256:ca17ea6b3e7b1f22e63b9b36adff351862edeb79ca20bbd4cdbc0be60d2b3550`. Image inspection confirmed `/app`, user `node`, entrypoint `["node","src/main.mjs"]`, and command `["/config/node.json"]`.
- Isolated `docker run --rm --network none --entrypoint node oya-node:local --input-type=module -e '<assertions>'` checks imported all five direct dependencies at their pinned versions and the application entrypoint, verified dependency license files, Node v24.21.0, UID/GID 1000:1000, PID 1, and the exact `/app` and `/app/src` file lists. A separate root inspection verified npm caches and operator settings were absent.
- `docker run --rm --network none oya-node:local` exited 1 with only `Node startup failed. Check config, signer, and RPC/Ledger availability.` No settings or keys were supplied.
- Build-context verification used a temporary copy of the eight allowed inputs plus `.dockerignore`, with 14 dummy artifacts at the root and under `src/`, `node_modules/`, `test/`, `scripts/`, `.state/`, and `docker/`. An external two-line Dockerfile (`FROM scratch`, `COPY . /`) exported the filtered context using `docker build --file <fixture>/context-inspect.Dockerfile --output type=local,dest=<fixture>/export <fixture>/context`. Exactly the eight intended files remained, with unchanged bytes. No repository test harness was added.
- With Node 24.21.0 selected on `PATH`, `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund` and `npm --prefix node/production test` passed: 89 tests, zero failures/skips. `git diff --check` passed. Disposable validation containers removed themselves; no chain or IPFS services were started.

Milestone 2 evidence (2026-09-14):

- Kubo: `ipfs/kubo:v0.43.0@sha256:63f5502f7a01b82a675e45bae81b2f5dfa90248ec4a86cd0a58c218347e1f2d2`, verified with `docker buildx imagetools inspect ipfs/kubo:v0.43.0` and `ipfs version` inside the image. The index includes Linux amd64 and arm64; execution used arm64 on Docker Desktop 4.37.2 / Engine 27.4.0, Compose 2.31.0.
- `docker compose config --quiet` and `docker compose build node` passed with private fixture settings. The parsed production model confirmed loopback-only node HTTP, only TCP/UDP 4001 published for Kubo, the selected restart/stop-grace policies, healthy-IPFS dependency, and bounded local logs. Missing required variables, a missing env file, and a nonexistent config mount failed; the nonexistent config path remained absent.
- Disposable validation used a unique project, generated node key, offline Kubo, an RPC fixture supporting only `eth_chainId` and `eth_getCode`, and an override replacing node ports with a dynamic loopback mapping and removing Kubo's swarm mappings. Actual container inspection confirmed node isolation settings, restart policies, stop grace, health, and port bindings. An in-container request reached Kubo 0.43.0 through `http://ipfs:5001`. No Ethereum transaction was submitted.
- One-off node commands verified readable private config, rejected writes to the config and application filesystem, literal dollar signs/quotes in raw environment values, and denial of a mode-000 config. The actual node health-probe command passed HTTP 200, rejected HTTP 503 and an unreachable server, and aborted a stalled response body within its three-second deadline. Kubo's explicit API probe failed without a daemon.
- The README's tar backup and fresh-project restore commands passed after stopping the services. Restored peer identity, recursive pin, exact dummy bytes, and config UID/GID/mode matched. Kubo recreation left the node container unchanged, and ordinary `down` retained the repository for a successful `up`. All fixture projects/volumes and generated private settings/archive were removed afterward; no permanent test harness was added in this milestone.
- `npm --prefix node/production test` passed under Node 24.21.0: 89 tests, zero failures/skips. `git diff --check` passed. The full Anvil/publication flow in Docker and cross-platform CI remain milestone 3 acceptance work.

Milestone 3 evidence (2026-09-15):

- Anvil uses [Foundry 1.5.1](https://github.com/foundry-rs/foundry/releases/tag/v1.5.1), pinned to `ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e`. Registry inspection confirmed amd64 and arm64 manifests. The test replaces the image's shell entrypoint with `anvil`, disables default accounts, and funds only generated node/deployer accounts.
- `npm --prefix node/production run test:docker -- --verbose` passed on native Linux arm64 through Docker Desktop 4.37.2 / Engine 27.4.0 and Compose 2.31.0. The final run completed in about 128 seconds. Adding `--platform linux/amd64` passed under emulation on the same daemon in about 155 seconds. Both flows built the repository image and exercised actual HTTP/IPFS/Ledger publication, persistence, shutdown, reconciliation, and cold backup restore.
- The merged Compose model and actual port bindings exposed only dynamic loopback node, Anvil, and test-only IPFS API ports; no swarm/gateway bindings remained. The node received only its generated node key. Busy/disallowed requests did not advance its nonce. During SIGTERM, an accepted transaction stayed pending for twelve seconds after the stopping event, then produced a verified response and exit 0. A separate receipt timeout produced HTTP 504 and unhealthy state without a restart; mining and verifying its receipt alone did not restore health. An explicit restart preserved the nonce and allowed a subsequent publication.
- A separate `docker buildx build --platform linux/arm64 --output type=oci,dest=<fixture>/node-arm64.tar node/production` using a disposable `docker-container` builder passed. Inspection of the exported OCI image confirmed Linux arm64, user `node`, and direct Node entrypoint. The export and builder were removed. CI uses the same export flow after its native amd64 integration job; no images or fixture data are uploaded.
- An additional run with invalid inherited Oya, deployer, Foundry, and Compose settings still published through its generated fixture. Sending SIGTERM after publication produced a nonzero test result and removed its generated files, containers, volumes, and image tag.
- `forge build --root contracts`, all 89 production host tests, script syntax, workflow YAML parsing, and whitespace checks passed. The hosted CI job has not yet run; native Linux host permissions and Windows sharing remain unverified. All reusable test logic and configuration live in the repository; generated credentials and service data stay in disposable fixtures.

## Interfaces and Dependencies

The image preserves `startNode(config, signer, options)`, the direct CLI config-path argument, `GET /healthz`, and `POST /v1/messages`. It continues to use the current published kernel versions and ethers through the lockfile. The runtime API and config schema do not gain Docker-specific fields.

Compose inputs are `OYA_CONFIG_FILE` and `OYA_ENV_FILE` (required absolute file paths), `OYA_CONTAINER_USER` (default `1000:1000`), `OYA_HTTP_PORT` (default 8787), and `OYA_STOP_GRACE_PERIOD` (default `4m`). Application credentials remain `OYA_NODE_PRIVATE_KEY` and optional `OYA_RPC_AUTHORIZATION` / `OYA_IPFS_AUTHORIZATION`. Agent and Ledger-deployer credentials belong only to their separate tools.

Additional operational dependencies are Docker Engine with Linux containers, Compose 2.30+, Buildx for multi-platform validation, and the pinned official Node/Kubo images. The container test additionally uses the official Foundry image for Anvil and host Node 24/Foundry for the existing sender and deployer. There are no new application npm dependencies, no Docker socket mounted into services, and no registry credentials required for public dependency pulls or local image builds.

`test:docker` accepts `--verbose` and optional `--platform linux/amd64|linux/arm64`; the default is the daemon's architecture. The harness supplies `OYA_TEST_PLATFORM`, its own Compose project name, and generated config/environment paths to the test overlay. These are fixture inputs, not additional production settings. The overlay's `!override` port lists deliberately replace the production mappings.

External HTTP follow-ups add the `maxMessageRequestsPerMinute` node-config field, `OYA_PUBLIC_HOSTNAME` and `OYA_PROXY_RESPONSE_TIMEOUT` (default `4m`) for the optional HTTPS overlay, Caddy with persistent certificate/configuration volumes, and the `test:http` harness mode. Real external access additionally needs operator-controlled DNS and host networking; fixture validation uses local certificates. The signed-message schema, allowed-signer policy, and repeated-submission semantics remain unchanged.
