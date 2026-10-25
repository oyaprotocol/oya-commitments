# Deploy a local node through an agent

This ExecPlan follows `PLANS.md`. The authorized $5/month Akamai/Linode deployment and local IPFS-only worker are operating. Live acceptance, isolated backup restoration, Keychain-backed worker startup, reusable documentation, and repository validation are complete. Private installation details remain outside Git.

## Purpose / Big Picture

Run an Oya worker and Kubo (the IPFS storage service) on the operator's local device, with an HTTPS inbox and PostgreSQL at a location the operator chooses. An agent should perform setup, deployment, verification, and routine operations using existing repository tools. The operator supplies hosting choices and grants access through authenticated tools or protected credential files. Secrets must not pass through chat or enter Git.

Use this installation to validate a reusable deployment guide and agent skill. Another operator should be able to give an agent the guide, a mode, host access, and a hostname, then receive a working node and instructions for monitoring, restarting, backing up, and recovering it. Demonstrate that a signed message submitted while the worker is stopped remains queued and completes after the worker starts.

## Progress

- [x] 2026-10-25 18:02Z: Read repository instructions, both deployment guides, release instructions, Compose assets, sender client, and packaged integration fixture.
- [x] 2026-10-25 18:02Z: Confirmed GitHub's latest release is `node-v0.3.0`, with the image reference, release metadata, and deployment archive. Local Docker responds and Compose reports `2.31.0-desktop.2`; no containers were running in the active Docker context. Existing stopped containers, volumes, and private installation directories still need a scoped inventory.
- [x] 2026-10-25: Operator selected IPFS-only and confirmed that no inbox server or DNS hostname exists yet.
- [x] 2026-10-25: Checked current provider and DNS documentation. Proposed a DigitalOcean 2 GiB server with daily backups and a free DuckDNS hostname; this has not been selected or purchased.
- [x] 2026-10-25: Confirmed the local Docker daemon is Linux ARM64 and found an older stopped Oya node/IPFS installation. Its settings and storage require inspection before choosing reuse or a separate installation; nothing was started or removed.
- [x] 2026-10-25: Operator selected the alternative-provider/own-domain option. Asked for the desired provider and/or domain, or a budget and region for researching alternatives. DigitalOcean and DuckDNS remain unselected.
- [x] 2026-10-25: Operator clarified that cost should be very low because this is experimental. Checked current official pricing and selected Akamai/Linode Nanode 1 GB at $5/month as the recommendation, with free DNS and no paid database or backup add-ons. The operator has not yet established provider access or accepted this specific purchase.
- [x] 2026-10-25: Verified the minimal credential handoff against current provider documentation and the local macOS security tool. Request two tokens stored in Keychain, plus a reserved DuckDNS hostname. No provider credentials have been supplied or retrieved yet.
- [x] 2026-10-25: Operator authorized deployment at $5/month with the registered DuckDNS hostname. Both named Keychain tokens loaded into a private subprocess without printing their values. Linode confirms the plan price and available capacity in Los Angeles.
- [x] 2026-10-25: Inspected the stopped v0.2.0 IPFS-only installation. Prepared a verified v0.3.0 bundle and dedicated private SSH keys. Preserve the existing Kubo volume and older settings; use a separate inbox worker project and target. Created the cloud firewall with public HTTPS/HTTP and SSH restricted to the operator's current IPv4 address.
- [x] 2026-10-25: Created the authorized Nanode, updated DNS, verified its pinned SSH identity, and installed Docker. The remote inbox and PostgreSQL are healthy; public TLS verification remains pending. The existing stopped IPFS volume has a protected local backup.
- [x] Inspect existing local/remote installations and confirm the release, architecture, ports, storage, DNS, SSH identity, and credential handoff.
- [x] Configure and start the remote inbox, PostgreSQL, and HTTPS using the selected release.
- [x] 2026-10-25: Verified public HTTPS with normal certificate validation and confirmed public `/healthz` returns 404. A signed test job was accepted as queued while the local worker was offline.
- [x] 2026-10-25: Operator selected Keychain-backed worker startup. Added a macOS helper and Compose overlay, checked eight credential-lifecycle cases, and imported the worker token directly over authenticated SSH into Keychain without a persistent local plaintext copy.
- [x] 2026-10-25: Configured and started the local worker and Kubo with preserved IPFS storage, private monitoring/client wrappers, and Keychain-backed startup. Stop/start succeeded and temporary host credentials were absent afterward.
- [x] 2026-10-25: Verified two external signed submissions, offline queuing across inbox/PostgreSQL restart, subsequent publication, exact local IPFS retrieval, idempotent resubmission, and rejection of unauthenticated workers and unlisted senders.
- [x] 2026-10-25: Created a PostgreSQL dump, restored into a disposable database, compared job identities/payload hashes/status/CIDs/results, and verified an independent local copy by SHA-256. Recorded manual backup frequency and provided a tested persistent backup command.
- [x] 2026-10-25: Added the human guide, deployment skill, entry-point links, macOS Keychain helper/overlay, and future release packaging. All 165 runtime tests passed; the helper's expanded ten-case Python suite and skill validator passed separately.
- [x] 2026-10-25: Reviewed the proposed changes and delivered a private installation record with monitoring, restart, submission, backup, recovery, resource IDs, and credential references. No real deployment identity or secret belongs in public artifacts.

## Surprises & Discoveries

The operator prefers approval-capable Keychain storage for the worker token, not only provider tokens. The released worker reads its token once at startup from a file, so a host-side helper can support this without a new image. `node/production/scripts/keychain-worker.py` retrieves the token, creates a protected temporary bind source, starts the worker using `inbox/compose.keychain-worker.yaml`, and removes the host file after health succeeds. The overlay disables automatic worker restart. Stop removes the worker container; Kubo and volumes remain. Temporary-file unlinking does not securely erase disk bytes or remove content from a running container. Abrupt termination can leave a protected file until the next helper operation. Other sender/SSH/ledger keys retain their existing storage.

The published `node-v0.3.0` image already contains the inbox, worker, and sender client for both execution modes. No new runtime feature or image publication is required just to deploy this architecture. The recent dependency remediation was confined to the frontend; the Compose CI fix changed test tooling.

The release archive's embedded guides still describe an earlier source-build workflow. Use the current repository's `run-locally.md` and `host-inbox.md` with the released Compose assets. The Oya release image is Linux amd64; inspect the actual Docker daemon architecture and use the documented platform override when emulation is required. Do not assume the shell's architecture matches the daemon.

The initial running-container check was empty, but the subsequent all-container inventory found a stopped Oya node and Kubo. Treat this as an existing installation until its configuration, keys, and volumes have been inspected. The Docker daemon reports `linux/aarch64`, so the published Oya image needs its documented amd64 override while Kubo can use its native platform.

Credential initialization in `host-inbox.md` already generates random database and worker credentials without printing them, using exclusive file creation. `src/inbox/client.mjs` similarly creates signing keys in protected files and prints only the public address. Reuse these mechanisms. The existing `scripts/local-node.mjs` workflow is not a substitute for the separate inbox/worker Compose deployment.

## Decision Log

- Decision: Use Keychain-backed startup for the local worker token and require explicit helper startup after reboot/failure. Rationale: The operator chose stronger protection while the worker is stopped over unattended restart. Keep the portable file-based flow available and document the exact limitations. Date/Author: 2026-10-25 / Operator and Codex.

- Decision: Start with existing released Compose assets and client operations; add automation only for concrete gaps discovered during deployment. Rationale: The runtime already supports the requested architecture, and a new deployment framework would delay the working installation. Date/Author: 2026-10-25 / Codex.
- Decision: Initially recommend IPFS-only for the first installation, with inbox, Caddy, and bundled PostgreSQL together on an operator-selected Linux host. Keep full Ledger mode and an independently hosted PostgreSQL service documented options. Rationale: This uses the portable default with fewer external inputs; at this point the operator had not yet selected the mode or host. Date/Author: 2026-10-25 / Codex.
- Decision: Use IPFS-only for this live deployment. Rationale: The operator explicitly selected it; blockchain configuration and funding are unnecessary for this installation. Full-mode instructions remain a reusable documentation option, not an additional live deployment. Date/Author: 2026-10-25 / Operator.
- Decision: Leave the hosting provider and DNS service open pending the operator's preferred alternative. Rationale: The operator chose a different provider and/or their own domain; this does not identify which part of the earlier proposal should change. Continue using the portable Compose architecture. Date/Author: 2026-10-25 / Operator and Codex.
- Decision: Recommend a $5/month Nanode, bundled PostgreSQL, a free DNS hostname, and private database dumps copied to the local device. Rationale: The operator clarified that this is a cost-sensitive experiment. Avoid paid managed databases, backup subscriptions, and domain registration initially. One GB RAM is a capacity hypothesis to validate with actual deployment measurements, not an established production sizing guarantee. Date/Author: 2026-10-25 / Codex.
- Decision: Use macOS Keychain for the Linode and DuckDNS API tokens, with explicit item names and no plaintext export. Rationale: The operator wants to gather the minimum credentials in one secure place before handing off deployment. The installed security tool supports an interactive password prompt; requiring approval for access is preferable to making tokens accessible to all applications. Date/Author: 2026-10-25 / Codex.
- Decision: Provision one Nanode in Los Angeles with bundled PostgreSQL and no paid add-ons. Rationale: The operator authorized the quoted $5/month setup, and the provider API confirms capacity and price. Date/Author: 2026-10-25 / Operator and Codex.
- Decision: Preconfigure a dedicated SSH host key through authenticated cloud-init user data and pin its public key locally. Rationale: This verifies the new host without trusting an unauthenticated first SSH connection. Keep generated host-key material in protected installation storage, never in source or logs. Date/Author: 2026-10-25 / Codex.
- Decision: Keep installation records and all credentials outside the checkout. Public instructions contain placeholders and credential references only. Rationale: A resumable agent workflow needs state, but an actual operator's infrastructure and secrets do not belong in reusable documentation. Date/Author: 2026-10-25 / Codex.

## Outcomes & Retrospective

The $5/month base-cost Nanode runs the released inbox, PostgreSQL, and Caddy; the operator's local device runs the IPFS-only worker and Kubo. Two signed messages completed with exact local content retrieval and idempotency. One remained queued through an inbox/database restart, then completed after Keychain-backed worker startup. Valid public HTTPS, private health, unauthorized worker rejection, unlisted-sender rejection, worker restart, and isolated database restoration all passed. The verified dump was copied locally, and a persistent backup command was exercised. The existing IPFS volume and old installation were preserved.

The operator chose Keychain for the worker token. A reusable host helper and Compose overlay support the existing v0.3.0 image without rebuilding it. The helper briefly materializes a protected file, removes the host file after healthy startup, and removes the worker container on stop. Automatic worker restart is disabled. Provider tokens stay in Keychain; sender and SSH keys retain their protected-file storage. The public guide and skill explain these distinctions and can be used by another agent. All 165 runtime tests, ten focused Python lifecycle cases, release packaging, the skill validator, and whitespace checks passed.

The experimental server had about 514 MiB available RAM, 20 MiB swap used, and 18 GiB free disk after message processing and restoration. Local worker/Kubo memory totaled about 200 MiB. A brief 20-second Docker sample averaged roughly 3.4% worker CPU and 2.6% Kubo CPU, with transient higher readings; the Oya image uses amd64 emulation on the selected ARM daemon. Backups and pruning are manual, not scheduled; the private record makes the recovery gap explicit. This is a small experimental workload, not production sizing evidence. Independent public IPFS retrieval, replication, and real-chain Ledger execution were not established. The published image/release assets remain unchanged; new public helper/docs assets are covered for future bundles.

## Context and Orientation

`node/production/run-locally.md` configures the local worker and Kubo. `node/production/host-inbox.md` configures the remote HTTP service, database, and HTTPS proxy. `node/production/inbox-api.md` describes signed requests, worker leases, job states, and recovery. The worker polls the inbox over outbound HTTPS; incoming messages need no router forwarding or tunnel to the local computer.

`node/production/inbox/compose.worker.yaml` owns the local services. `compose.yaml`, `compose.postgres.yaml`, and `compose.https.yaml` in that directory compose the remote installation. The optional PostgreSQL overlay publishes no database port. Health routes are private. Caddy handles public HTTPS for the supplied DNS hostname. The private `compose.env` on each device records its release reference, paths, Compose overlays, platform override, and stable project name.

In IPFS mode, successful work ends in `published` with a content identifier (CID). In Ledger mode, it ends in `logged` with a CID and transaction receipt. Both modes require an authorized message sender; only Ledger mode requires a funded node transaction key and chain configuration. The sender key stays local and is not mounted into the worker. The node transaction key also stays local. The remote database stores message contents and, in Ledger mode, signed transaction checkpoints, so it is trusted infrastructure even though it does not hold private signing keys.

## Plan of Work

First, collect non-secret choices and establish access. Accept an existing SSH alias and DNS hostname, or research current hosting options within a stated budget if the operator needs a new host. An existing SSH agent or authenticated provider CLI is preferable to new long-lived credentials. Verify a new host's SSH fingerprint through the provider console or another trusted channel. The operator performs account login, MFA, payment, or credential entry in a trusted interface when necessary. Once the scope is established, continue routine deployment steps without asking for repeated confirmation.

Inventory only the selected installation locations, relevant containers/volumes, ports, and tooling. Do not dump shell environments, credential files, Docker authentication, or full container inspection output. Preserve existing keys and project state. Verify the selected archive checksum and immutable image reference before extraction. Use the same Oya release for both roles and `tar -xzpf` so public bind-mounted assets retain their archived permissions under a restrictive umask.

Prepare a private directory on each device with mode 0700 and private files with mode 0600. Generate a fresh sender key only for a new installation. Configure the same target, sender allowlist, and execution identity on both sides. Generate database credentials on the inbox host. Transfer only the worker token file over authenticated SSH to the local device. Managed database credentials, if selected, are entered directly into the protected remote secret file; do not paste connection URLs into chat or command arguments. Pass credentials through files without echoing their contents. File permissions protect against other users, not an agent or administrator already authorized to access those files.

Start the remote Compose stack, check its private database health, and verify public TLS and allowed routes. Point the local worker at that HTTPS hostname and start worker/Kubo. Save private deployment metadata so another agent can resume: release/digest, target, public identities, SSH alias, configuration file locations, project names, selected overlays, and completed checks. Record credential file references, never secret values. Do not put instance-specific hostnames or local directory layouts into the public plan.

Prove the deployment using a benign signed message. Stop only the selected worker, submit through the public hostname, confirm `queued`, restart the worker, and poll the same request until `published` or `logged`. Retrieve the exact content from local Kubo. Test public IPFS retrieval separately before claiming availability to arbitrary peers: inbox connectivity does not establish IPFS reachability. Re-submit the same signed envelope to verify it retains the original job identity. Check a controlled service restart and private database backup restored into an isolated database. Restore testing must not roll back the live database.

Finish with `node/production/deploy-with-agent.md` and `skills/deploy-node/SKILL.md`, based on the commands actually exercised. Read the available `skill-creator` instructions when implementing the skill. The human guide includes a copyable task prompt, minimal input checklist, secure credential handoff, and operations/recovery steps. The skill directs agents through discovery, setup, verification, and a private handoff record, respecting existing authorization. Link the workflow from `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and the production README/local/inbox guides where appropriate. Include the new human guide in future bundles through `scripts/publish-image.sh` and its packaging test. Existing immutable release assets remain usable and are not replaced.

## Concrete Steps

Credential preparation happens in the operator's own Mac terminal and provider account interfaces, before any cloud creation. In Linode Cloud Manager, create a short-lived personal access token with `linodes:read_write` and `firewall:read_write`; leave unrelated categories disabled. The issuing account user must have permission to create/manage instances and firewalls. Query public image, region, and plan metadata without authentication so additional token scopes are unnecessary. Current [instance creation](https://techdocs.akamai.com/linode-api/reference/post-linode-instance), [firewall creation](https://techdocs.akamai.com/linode-api/reference/post-firewalls), and [token documentation](https://techdocs.akamai.com/linode-api/reference/get-started) specify these scopes. Public SSH keys can be supplied directly when creating the instance, so no separate account-profile key permission is required.

Sign into DuckDNS, reserve an available hostname, and obtain its account token. Its [HTTPS API](https://www.duckdns.org/spec.jsp) updates an existing subdomain; do not assume the token alone registers a new name. The actual hostname is non-secret but belongs in the private installation record, not this public plan.

Store the two tokens in the Mac's default keychain by running the following commands in the operator's own terminal. Enter each token only at its password prompt. The trailing `-w` without a value is explicitly supported by the installed tool's help; `-T ""` prevents the creating application from receiving automatic access. These commands do not overwrite existing items.

    /usr/bin/security add-generic-password -a oya-deploy -s oya-deploy-linode -T "" -w
    /usr/bin/security add-generic-password -a oya-deploy -s oya-deploy-duckdns -T "" -w

Retrieve these exact service/account pairs only through a subprocess whose secret output remains captured inside the deployment program. Do not return token output to the model, terminal log, shell command arguments, or repository. Do not execute a standalone `security find-generic-password ... -w` through an output-returning agent tool. macOS can require the operator to allow the retrieval; do not weaken Keychain access controls to avoid that prompt. Tokens may be held in process memory while constructing authenticated HTTPS requests. DuckDNS needs its token in the HTTPS request URL, so redact URLs and exception details and never put that URL in command-line arguments. Generate or reuse deployment SSH keys and application secrets locally; they are not additional credentials the operator needs to gather. The Mac must remain available and Docker running for local setup and validation.

From the repository root, perform read-only discovery:

    git status --short
    docker version
    docker compose version --short
    docker info --format '{{.OSType}}/{{.Architecture}}'
    docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
    gh api repos/oyaprotocol/oya-commitments/releases/latest --jq '{tag: .tag_name, assets: [.assets[].name]}'

At planning time the selected deployment release is `node-v0.3.0`. `node/production/release-image.md` records archive SHA-256 `8c8cd6f5ecf4c9de1b0704b8f81a7be05d574a68af8ce6eef45a17e2f8c4ae73` and image `ghcr.io/oyaprotocol/oya-node@sha256:848806de43f0afa056d1dea533320bfc1b503cb4409a96abb3101d7cedbb69de`. Fetch the archive and `release.txt` from that GitHub release, compare the checksum, and confirm the bundle's `image.txt`. A newer release is a deliberate version choice, not a reason to follow a mutable image tag.

Follow the current two deployment guides for exact first-install configuration commands. Once their private settings have been written, run from the appropriate host's shell, with `OYA_COMPOSE_ENV` set to that host's saved settings file:

    source "$OYA_COMPOSE_ENV"
    docker compose config --quiet
    docker compose pull
    docker compose up -d --wait --wait-timeout 120
    docker compose ps
    docker compose logs --tail 100

Keep remote and local Compose environments separate. From the local worker environment, `docker compose stop node` pauses execution, `docker compose start node` resumes it, `docker compose logs -f --tail 100 node` monitors progress, and `docker stats --no-stream` reports resource use. Use the published image's client entrypoint `/app/src/inbox/client.mjs` as documented in `run-locally.md`: `keygen KEY_FILE`, `prepare KEY_FILE TARGET TEXT_FILE JOB_FILE`, `submit INBOX_URL JOB_FILE`, and `status INBOX_URL JOB_FILE`. Paths passed to that client must refer to its private bind mount. Retry the saved job file without preparing a new request.

For repository validation after documentation and packaging changes, from the repository root run:

    node --test node/production/test/publish-image.test.mjs node/production/test/keychain-worker.test.mjs
    git diff --check

The Keychain tests run Python 3 with mocked credential-manager/Docker subprocesses. They exercise denial, unavailable Docker, failed-start cleanup, stale files, permissions, and keeping tokens out of arguments/errors without accessing a real Keychain. Validate real macOS startup separately: after sourcing the local Compose settings, run `python3 node/production/scripts/keychain-worker.py start --account OPERATOR_ACCOUNT --service WORKER_SERVICE`, verify health and absence of the temporary host file, then use `stop` and `start` to prove recovery. The actual account/service references belong in the private installation record. The helper and overlay must ship together in future bundles; the existing v0.3.0 image remains unchanged.

If deployment reveals a runtime or Compose defect, fix it with focused tests and run the affected existing integration commands. The packaged regression check uses disposable fixtures for both modes:

    forge build --root contracts
    npm --prefix node/production run test:inbox:docker

That fixture is source-based validation, not proof that the installed release or public hostname works. Record live checks separately. Real-chain transactions require the selected network and funded account; Anvil results must not be described as live-chain validation.

## Validation and Acceptance

The chosen local worker and remote inbox must run the recorded image digest. HTTPS must validate without disabling certificate checks. PostgreSQL and health routes must remain private. An unauthorized signed submission must be rejected. A harmless authorized message submitted while the worker is stopped must survive in PostgreSQL and finish after restart, with the expected content retrievable by CID. Repeating the original request must preserve its identity. For Ledger mode, independently check the receipt on the configured chain and preserve transaction checkpoints across restarts.

Verify readable public assets and protected secret files under the actual container UID. Confirm that existing keys and volumes survived retries/restarts. Create a protected database backup and restore it into an isolated database, keeping live workers away from the restored copy. Describe the operator's ongoing backup schedule and storage choice; a single successful dump is not an ongoing backup policy. Public documentation must distinguish inbox availability while the local device sleeps from IPFS content availability when that device holds the only copy.

For the proposed experimental budget, use private logical dumps and copy them to the local device when it is online, including before upgrades. State the actual backup frequency and last successful copy in the private installation record. A host loss can lose jobs received since the last independent backup. Paid automatic backups are optional later. Measure total host memory, disk, swap use, and container resource use during startup, normal polling, and queued message processing before declaring a one GB host adequate. Do not silently upgrade to a paid larger instance if resources are insufficient.

The final public guide must let a fresh agent identify required inputs, operate using credential references, resume an existing installation, and reproduce acceptance checks. Review all intended changes, tests, generated release contents, and documentation for secrets and private installation details before handoff. Do not claim a full-mode live deployment if only IPFS mode was exercised.

## Idempotence and Recovery

Initialization uses exclusive file creation and must stop on existing state. Resume from saved settings instead of regenerating keys, tokens, target identities, or Compose project names. Inspect partial initialization and repair only identified missing pieces. Do not use `down --volumes`, delete database rows to unblock work, or replace an unresolved transaction with a new request.

Retain the exact release, selected Compose overlays, credentials, and volume identities for updates. Stop workers before database migration or restoration; reconcile any Ledger transactions before resuming from older database state. An older image cannot undo an incompatible schema migration. If deployment fails, preserve its private state and report the failing stage with redacted diagnostics. Prepare fixes within existing authorization and ask only for genuinely missing access, scope, or irreversible choices.

## Artifacts and Notes

Public deliverables are this living plan, the verified human guide, the reusable agent skill, entry-point links, and future bundle packaging coverage. Private deliverables are per-host settings, credentials, saved signed test requests, backup artifacts, and an installation record with enough non-secret metadata to resume. Never copy the private record into a pull request. Deployment credentials have been generated only in protected installation storage outside the checkout.

Hosting research on 2026-10-25: DigitalOcean lists a Basic regular-CPU server with 2 GiB RAM, one vCPU, and 50 GiB disk at $12/month. Daily backups add 30%, making the proposed base total $15.60/month before taxes or overages. This is an initial capacity choice to validate with actual resource measurements, not a measured workload requirement. See [Droplet pricing](https://www.digitalocean.com/pricing/droplets) and [backup pricing](https://www.digitalocean.com/pricing/backups). [DuckDNS](https://www.duckdns.org/about.jsp) offers free subdomains pointed at a chosen IP, and its [HTTPS API](https://www.duckdns.org/spec.jsp) supports subsequent updates. Reserve a name through the account interface; use the token only from a protected file for updates. Hetzner's [cost-optimized product page](https://www.hetzner.com/cloud/cost-optimized/) currently marks its entry CX23/CAX11 offerings unavailable, so do not assume their advertised prices imply capacity. Recheck prices and capacity before provisioning. The proposed provider is an example installation; the reusable workflow remains based on Linux, SSH, Docker, HTTPS, and PostgreSQL.

Revised recommendation after the experimental-cost clarification: Akamai's [official CPU pricing](https://www.akamai.com/cloud/pricing/cpu) lists Nanode 1 GB at $5/month ($0.0075/hour), with one shared CPU, 25 GB disk, and 1 TB transfer. Its [billing overview](https://www.akamai.com/cloud/pricing) describes hourly billing with a monthly cap; backup services are extra. The estimate excludes tax and traffic overages. Use the bundled PostgreSQL service, free DNS, and local backup copies to keep the proposed recurring base cost at $5. Account approval, region capacity, and the actual checkout price must be checked before creating the instance. No annual commitment or promotional credit is needed for this estimate.

## Interfaces and Dependencies

The baseline requires Docker, Compose 2.30 or newer, Bash or zsh, curl, tar, a writable private directory per host, an inbox hostname, and public TCP 80/443 on the inbox host. SSH is the portable remote administration path. Use provider-specific APIs only for provisioning or DNS when the operator selects and authorizes them. PostgreSQL may use the bundled pinned PostgreSQL 17 image or a separate durable service with verified TLS and compatible transactions. No provider SDK belongs in the worker.

IPFS-only needs a local sender key and shared worker credential. Full Ledger mode additionally needs the chain ID, Ledger contract, authenticated RPC access when applicable, and a dedicated funded node key kept locally. The operator supplies account access and any externally managed credentials through secure tooling or protected files. The agent can generate application secrets and wire their file references without exposing their values. Publishing a new release, buying hosting, and changing execution identity are separate actions whose scope must be established if they become necessary.
