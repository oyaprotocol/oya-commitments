# Improve node upgrades and everyday operation

This ExecPlan is a living document maintained according to [PLANS.md](../PLANS.md). **Status: proposed for team approval; implementation has not started.** The initial pull request contains this plan only. Record the team's approval of a specific plan revision in this document before making implementation changes.

## Purpose / Big Picture

An operator should be able to upgrade a worker whose node signing key is in macOS Keychain, send a signed message with one command, and check whether the selected node is running without unlocking a signing key. New inbox jobs should remain eligible for execution for seven days, accommodating intermittently online devices. Operators should be able to configure warnings about a stopped node or low native-currency balance and see the local limits on gas spending.

The proposed implementation covers the production node under `node/production/`, its deployment bundle, and its operator documentation. Standardize host management on JavaScript ES modules (`.mjs`) with Node.js 24 on the host. Port the two existing Python helpers and their tests before extending them; the operator features then use the same language and test tooling as the existing JavaScript commands. Approval of this plan authorizes implementation and disposable local validation. Deployments, funded-chain transactions, notification delivery to real recipients, and enrollment in an external monitoring service require their own established operator authorization.

| Operator feedback | Proposed outcome |
| --- | --- |
| Upgrade supports only the Keychain worker token | Support Keychain node signing keys and optional runtime authorization headers through the same protected lifecycle; preserve existing token-only and file-backed installations. |
| No simple send/status commands | Add a bundled operator entrypoint with `send`, `status`, `job-status`, `balance`, and `gas-policy`, using one saved private profile. |
| Jobs expire while devices are closed | Change the client default from one day to exactly seven days, retaining the existing server maximum and signed-job recovery rules. |
| Warn when node stops or wallet runs low | Provide an independent local monitor with configurable thresholds and optional external heartbeat alerts that can detect a sleeping/offline host. |
| Configure a local gas policy | Expose and document the existing per-transaction gas and fee ceilings; add balance-warning configuration without introducing a competing spending-policy schema. |

## Progress

- [x] 2026-11-15 15:29Z: Read repository guidance and inspected upgrade, Keychain, client, health, expiry, gas, and release-packaging paths at `bda9c5c704c3fe296ae9ed602d4180eae0be3313`.
- [x] 2026-11-15 15:29Z: Confirmed upstream `main` matches the inspected revision and checked open PRs for overlapping production-node work.
- [x] 2026-11-15: Drafted the proposed behavior, milestones, compatibility boundaries, and acceptance tests below.
- [x] 2026-11-15 16:22Z: Revised the proposal toward JavaScript standardization after reviewing the existing host commands and the requester's language preference; team approval of the revised plan remains pending.
- [ ] Record team approval, the approved revision, and any requested design changes in the Decision Log. **Implementation gate.**
- [ ] Port the existing Python helpers and all 68 test cases to JavaScript, validating migration and recovery before adding features.
- [ ] Implement credential references and Keychain-safe worker upgrades.
- [ ] Implement operator commands and seven-day default job expiry.
- [ ] Implement optional monitoring and expose the existing gas policy.
- [ ] Complete release-bundle integration, documentation, integration validation, and review fixes.

## Surprises & Discoveries

- `node/production/scripts/upgrade-node.py` already delegates worker-token retrieval to `keychain-worker.py`. Its `configuration_files()` exempts only `/run/secrets/worker.json` from persistent-file fingerprinting. A transient Keychain-backed `/run/secrets/node.env` needs explicit lifecycle and validation support; broad exemptions for missing secret mounts would weaken upgrade checks.
- `scripts/local-node.mjs status` already exists, but `loadLocalSettings()` in `scripts/local-config.mjs` constructs a Ledger signer before querying health. Its health parser expects direct-node states, while `src/inbox/worker.mjs` returns worker states such as `idle`, `processing`, and `inbox_unavailable`. Reuse these behaviors while addressing the operator-facing gap.
- `scripts/send-message.mjs` serves the direct HTTP API. Inbox sending currently requires separate `prepare`, `submit`, and `status` invocations in `src/inbox/client.mjs`. The saved signed job is necessary for safe resubmission and authenticated status lookup.
- `src/inbox/protocol.mjs:signJob()` defaults to `Date.now() + 86400_000`, while `validateJob()` already accepts deadlines up to seven days ahead. Existing signed envelopes bind the deadline cryptographically and cannot be extended in place.
- `src/config.mjs` already supports `gasLimit` (default `200000`) and `maxFeePerGasWei` (default `"30000000000"`). Both the direct runtime and inbox processor pass these limits to the transaction preparer. `scripts/local-check.mjs` currently checks only that the wallet balance is greater than zero.
- The basic Docker deployment workflow currently works without host Node.js, but optional host tools already use JavaScript: `local-node.mjs`, `local-deploy.mjs`, `send-message.mjs`, `peer-directory.mjs`, and `release-node.mjs`. The new host-management interface will explicitly require Node.js 24. The image contains `src/`, while `scripts/publish-image.sh` explicitly copies host helpers. New assets also need entries in the upgrader's `PUBLIC_FILES` allowlist. An existing older upgrader will reject an archive containing unfamiliar files; the release instructions must identify the reviewed helper needed to cross that boundary.
- The Python migration covers `scripts/keychain-worker.py` (155 lines) and `scripts/upgrade-node.py` (1,063 lines), plus 1,197 lines of Python tests containing 68 test methods. Counts include comments and blank lines. `test/publish-image.test.mjs` also embeds Python validation and must be migrated to remove the production tooling's Python dependency. Unix file locking, constrained archive extraction, and compatibility with old bundles need explicit migration validation.
- Open [PR #165](https://github.com/oyaprotocol/oya-commitments/pull/165) proposes optional direct-node batch logging, including HTTP 202 responses and durable transactions. Recheck its status before implementation and preserve its transaction/recovery semantics if merged. [PR #163](https://github.com/oyaprotocol/oya-commitments/pull/163) touches inbox configuration validation. Neither is a prerequisite for this plan; avoid copying changes from their unmerged branches.

## Decision Log

- Decision: Submit a plan-only PR and stop before implementation until team approval is recorded. Rationale: The requester explicitly requires team approval before code changes. Date/author: 2026-11-15 / Codex.
- Decision: Standardize host-management scripts on JavaScript ES modules and Node.js 24, superseding the initial Python proposal. Rationale: Existing host commands, runtime clients, shared libraries, and the test harness already use JavaScript. A single implementation language outweighs avoiding a host Node.js prerequisite. Port the existing Python helpers as a separate milestone so their safety checks can be evaluated before feature changes. Date/author: 2026-11-15 / Codex, following requester feedback; revised plan proposed for approval.
- Decision: Store credential references in a private manifest, with separate worker, node, and sender roles. Rationale: A worker token authorizes queue operations; a node key spends gas; a sender key signs messages. Their access and lifecycle must stay distinct. Date/author: 2026-11-15 / Codex; proposed for approval.
- Decision: Default new jobs to exactly seven days and leave the server's seven-day maximum, leases, and retention rule intact. Rationale: This addresses offline queuing without rewriting signed authorization or changing transaction recovery. Date/author: 2026-11-15 / Codex; proposed for approval.
- Decision: Keep existing transaction ceilings authoritative and make low-balance warnings advisory. Rationale: A daily spending ledger or new transaction-blocking policy would add recovery semantics beyond the requested configuration gap, which is already covered by existing caps. Date/author: 2026-11-15 / Codex; proposed for approval.
- Decision: Run monitoring outside the worker, with optional outbound heartbeat checks and configurable offline grace. Rationale: A stopped process cannot reliably report its own death; a sleeping host also needs an observer elsewhere. External delivery remains opt-in. Date/author: 2026-11-15 / Codex; proposed for approval.

## Outcomes & Retrospective

Planning identified two existing capabilities to build upon: seven-day server acceptance and enforced local gas ceilings. The main gaps are credential lifecycle support, everyday command usability, and independent monitoring. This revision adopts JavaScript for host management and adds a migration milestone ahead of the operator features. It makes host Node.js a prerequisite and preserves the team-approval gate. Runtime behavior, deployment state, and external monitoring configuration have not been changed; implementation acceptance remains pending.

## Context and Orientation

An **inbox** is the HTTPS service that stores signed jobs in PostgreSQL while a device is offline. A **worker** on that device claims one job at a time, publishes its signed message to IPFS through Kubo, and optionally logs its content identifier (CID) to the Ethereum Ledger contract. **Ledger mode** uses a dedicated node account to pay transaction fees. **IPFS mode** publishes without Ethereum. A **direct node** accepts synchronous `/v1/messages` requests instead of polling an inbox.

A signed **job envelope** contains the message, target name, request ID, expiration timestamp, and signatures. Saving the exact envelope allows the inbox to recognize retries and authorize status queries. A **checkpoint** is durable progress such as a CID or already-signed transaction. An expired queued job cannot start, but an in-progress transaction must still reconcile to its original hash. A short worker **lease** prevents two workers from advancing the same job concurrently; it is independent of job expiry.

Current paths and responsibilities:

| Area | Files to read and extend |
| --- | --- |
| Upgrade and secret lifecycle | `node/production/scripts/upgrade-node.py`, `scripts/keychain-worker.py`, `inbox/compose.worker.yaml`, `inbox/compose.keychain-worker.yaml`, `src/secrets.mjs` |
| Operator commands and health | `node/production/scripts/local-node.mjs`, `scripts/local-config.mjs`, `scripts/local-status.mjs`, `scripts/send-message.mjs`, `src/server.mjs`, `src/inbox/worker.mjs` |
| Inbox protocol and recovery | `node/production/src/inbox/client.mjs`, `protocol.mjs`, `http.mjs`, `store.mjs`, `processor.mjs` |
| Local gas limits | `node/production/src/config.mjs`, `src/main.mjs`, `src/inbox/processor.mjs`, `scripts/local-check.mjs`; read `packages/ethereum/src/transaction-preparer.ts` for existing enforcement |
| Packaging | `node/production/Dockerfile`, `scripts/publish-image.sh`, `scripts/upgrade-node.py:PUBLIC_FILES`, `test/publish-image.test.mjs`, `test/release-node.test.mjs` |
| Operator guidance | `node/production/README.md`, `run-locally.md`, `run-direct.md`, `host-inbox.md`, `inbox-api.md`, `deploy-with-agent.md`, `upgrade-node.md`, `release-image.md`, `skills/deploy-node/SKILL.md` |

Abbreviated production paths in this document are relative to `node/production/`; paths beginning with `packages/` or `skills/` are repository-relative. Runtime configuration and installation records belong outside Git. Follow root `AGENTS.md`, `CONTRIBUTING.md`, and the deployment skill when changing these workflows. The intended code changes stay within the production node; the Ethereum package is a reference for existing behavior.

## Plan of Work

### Milestone 0: Approve the plan

Open the initial PR with this document as its only changed file. Ask the team to review the proposed command/profile format, Keychain lifecycle, seven-day default, and monitoring approach. Record approval and its revision before proceeding. If the team changes scope, revise this self-contained plan first. No real credentials or operator environment are needed for design review.

### Milestone 1: Migrate the existing helpers to JavaScript

Create `node/production/scripts/keychain-worker.mjs` and `scripts/upgrade-node.mjs`, with small shared modules for subprocesses, private files, locking, and archive handling. Preserve the current actions, credential references, execution identities, literal Compose-environment parsing, release verification, backup checks, durable journal format, and failure behavior. Use argument arrays rather than shell interpolation, bounded subprocess/network output, explicit cancellation cleanup, and atomic writes with file/directory synchronization. Status and monitoring must be able to run on the host even when Docker is unavailable. Existing JavaScript release, peer-directory, and development scripts remain the baseline; shell launchers can continue invoking them.

Port the ten Keychain and 58 upgrade test cases into the existing `test/keychain-worker.test.mjs` and `test/upgrade-node.test.mjs` files. Replace the embedded fake-Docker Python program and packaging-test Python snippets with JavaScript fixtures. During migration, run the Python tests as a reference and compare normalized command traces, preserved files, and failure outcomes for the same fixture scenarios. Delete the migrated Python implementations/tests once their JavaScript equivalents and bundle compatibility tests pass; the completed production test suite must not invoke Python.

Start with a bounded portability prototype for advisory locking and archive inspection. The baseline is the current Python behavior, including locks released by the OS after a process exits, rejection of concurrent legacy operations, and rejection of archive traversal, links, special files, duplicate entries, extended metadata, excessive member counts, and decompression bombs. Use a maintained Node-compatible locking binding that preserves the existing `flock` behavior and a maintained archive parser; do not replace these with shell-based extraction or time-based stale-lock eviction. Pin and package required dependencies with the host tools. Validate binding availability on macOS/Linux and supported CPU architectures with Node.js 24, and validate that the archive parser exposes enough information to retain every rejection. Promote the prototype only after the existing adversarial fixtures and real subprocess lock/crash checks pass; otherwise revise the dependency/distribution design in this plan before proceeding. Record selected versions, platform constraints, and packaging cost in the Decision Log.

The JavaScript upgrader must support installations created with older bundles without dynamically importing their Python helper. Reuse the reviewed JavaScript lifecycle implementation against the explicitly validated old/new Compose assets and credential references. Preserve the same lock locations so old and new invocations cannot overlap. Require compatible helper/image capabilities before stopping services. Document the new `node .../*.mjs` invocations and how to obtain the trusted migration helper; do not modify old published bundles or reinitialize installations.

Acceptance for this milestone is behavior parity on the 68 cases, additional cross-version/process-lock tests, a disposable macOS Keychain lifecycle check, Linux upgrade validation, and a release-bundle fixture that operates with Node.js available and Python absent. Node.js becomes an explicit operator prerequisite; any native locking artifact must be provided for the supported host/runtime combinations rather than requiring operators to compile it.

### Milestone 2: Resolve credentials consistently and upgrade Keychain-backed workers

Add `node/production/scripts/operator-credentials.mjs` for typed credential references, bounded secret reads, and cleanup. Extend the migrated `keychain-worker.mjs` and `upgrade-node.mjs` with `--credentials FILE`. Keep the existing `--account`/`--service` worker helper flags and `--keychain-account`/`--keychain-service` upgrade flags compatible. Reject conflicting new and legacy selections. A manifest can select a protected file or Keychain for each supported role, allowing mixed installations.

Node Keychain entries map to the existing literal environment fields `OYA_NODE_PRIVATE_KEY`, `OYA_RPC_AUTHORIZATION`, and `OYA_IPFS_AUTHORIZATION`. Resolve only fields needed by the action. Validate node-key format and reject line breaks/NUL in environment values before creating a runtime file. Sender-key access belongs only to sending; the worker and upgrade process never retrieve it. `status`, upgrade preview, and stopping a worker never unlock signing keys. IPFS mode does not retrieve a node signing key.

Retain the current private-directory, exclusive-write, symlink-rejection, lock, read-only-mount, and `restart: "no"` safeguards. Add a separately selected overlay for transient `/run/secrets/node.env`, so token-only installations do not acquire a mandatory new mount. Materialize selected node secrets and worker credentials in mode-0600 files within the owned mode-0700 runtime directory. Capture Keychain stdout/stderr inside the helper; never put values in command arguments, Compose environments, logs, upgrade journals, or generated examples. Remove temporary host files after healthy startup and on handled failures. A crash can leave restricted plaintext until the next cleanup; unlinking is not secure erasure and a running consumer can still access loaded secrets.

Teach upgrade preflight, mount comparison, fingerprinting, stop/start, and failure recovery about exactly the declared ephemeral mounts. Fingerprint the reference manifest and persistent settings, and preserve public execution identity. During apply, derive the retrieved node key's public address using the pinned image's existing Ethereum library in an offline, captured subprocess and compare it with the saved identity before starting execution. Do not fingerprint or copy transient secret contents into recovery records. Detect changed references during an upgrade and stop safely. Missing unrecognized files must still fail preflight. Ensure old-bundle stop handling and new-bundle startup handling both work when the source installation predates the extended helper; unsupported helper/image combinations fail before stopping the worker and explain the required reviewed helper version.

Use mocked Keychain and Docker tests first. Then run a disposable macOS/Docker Desktop test with synthetic keys to verify that both mounted files can be removed after startup, restart requires the helper, failed startup cleans up, and the worker identity is preserved through upgrade. Real installation Keychain items are unnecessary.

### Milestone 3: Make status and sending one-command operations

Add `node/production/scripts/operator-node.mjs` as a thin command dispatcher with small sibling modules `operator-status.mjs` and `operator-client.mjs`. Select a private versioned `operator.json` using `--profile FILE` or `OYA_OPERATOR_PROFILE`. Resolve relative paths against the profile's directory, validate all settings before side effects, and reject unknown keys. The profile points at existing node/worker configuration, credential references, expected public identity, and a private state directory. It does not duplicate gas-policy values or contain private signing keys. Supply a clearly marked `operator.example.json` and a short optional shell alias in the guide; installation must preserve existing files.

Reuse or extract pure configuration, health-validation, and client functions from the existing JavaScript tools instead of maintaining competing implementations. Keep signing-key loading separate from read-only settings so status can share validation without retrieving a key. Preserve existing documented JavaScript commands as compatible entrypoints while promoting the unified operator interface.

`status` runs on the host with a five-second deadline and bounded response reading. It queries only the configured loopback health endpoint and works even when Docker is unavailable. Validate direct-node `ready`/`busy` and worker `idle`/`processing`, as well as the correct role, mode, target, and Ledger identity. Extend worker health with additive public execution identity fields; it already tracks last successful poll and processing state. Match the worker's existing freshness bound of `operationTimeoutMs + 60000` milliseconds and reject timestamps more than five seconds ahead of the host clock. Report stopped/unreachable, starting, retrying, inbox unavailable, shutting down, and unknown transaction outcome distinctly. Treat HTTP success with the wrong identity or malformed/stale health as failure. Older workers lacking identity fields can be described as reachable but unverified with a nonzero exit and an upgrade hint. The command must not need a node private key, inspect secret mounts, or treat inbox reachability alone as proof that a worker is running.

`send --file MESSAGE_FILE` resolves only the sender credential and validates the existing ASCII/size contract. Add a bounded signing entrypoint `node/production/src/operator-sign.mjs` using the existing `ethers` and inbox protocol functions. The host passes signing input over captured stdin to an isolated one-shot container using the already selected immutable image, `--network none`, no node-secret mounts, and no automatic pull. The entrypoint returns a signed envelope over captured stdout. The host persists the envelope exclusively with mode 0600, syncing the file and parent directory before making the HTTP request. This also avoids routing host loopback URLs from inside a container. Reuse/export pure preparation helpers from `src/inbox/client.mjs` instead of implementing a second signature format.

For a worker profile, submit to the configured inbox, print the request ID, absolute expiry, queued/processing/completed state, and a private job-file reference. Exit 0 means the request was accepted, including HTTP 202; only `published`/`logged` means completed. `job-status --job FILE` submits the saved envelope to `/v1/status` without reading a signing key. `send --job FILE` reuses the exact saved envelope after uncertain submission; it never creates a new request ID or extends expiry. Reject profile/target mismatches before sending. Expired jobs remain status-queryable but cannot be renewed by resubmission. An optional bounded `--wait SECONDS` polls the same job and reports pending when its wait budget ends; it does not replace the envelope.

For a direct profile, sign the direct message format, submit once to `/v1/messages`, and report publication or logging results. Keep the existing direct sender available and reuse its validation semantics. An ambiguous direct request must report the saved evidence and require reconciliation, because repeating it can spend gas again. If batch logging has merged, handle its documented 202/status interface as accepted/pending without pretending it is a completed log or falling back to another submission.

All HTTP requests use verified HTTPS off-host, reject redirects, and bound connection/body time and response bytes. Exception text and remote response bodies are not printed indiscriminately. `--json` returns a stable, sanitized result schema. Existing advanced clients remain usable. Document the new entrypoint prominently from both worker and direct-node guides and link it from existing local-command help.

### Milestone 4: Default new jobs to seven days

Define a named seven-day duration in `src/inbox/protocol.mjs` and use it for `signJob()`'s default and the existing validation maximum. Preserve explicit shorter `expiresAt` callers and the version-1 envelope format. Expose `--expires-in SECONDS` on new preparation/sending interfaces with a positive integer maximum of `604800`. Existing `prepare` positional arguments continue to work and inherit the new default. Display the absolute signed deadline so users can see remaining queue time.

Add fixed-clock tests for exactly `604800000` milliseconds, the seven-day boundary, one millisecond beyond the server maximum, expiry at the current time, shorter explicit deadlines, and signature tampering. A sender clock ahead of the server can fail an exact-maximum deadline; document clock synchronization and shorter explicit lifetimes rather than silently relaxing validation or changing a signed job after rejection.

Keep `InboxStore.claim()`'s expiry rule for queued jobs, current short leases, in-progress reconciliation, and pruning of terminal rows only after signed expiry plus seven days. Old jobs retain their signed deadlines. Test processing/recovery after a deadline and replay protection through the retention boundary. Explain that default jobs may retain terminal records for roughly fourteen days from creation, so `maxJobs`, disk usage, and prune scheduling deserve review. Update the 24-hour wording in deployment and inbox guides.

### Milestone 5: Expose gas policy and add useful alerts

`gas-policy` reads the selected node configuration and displays the effective `gasLimit`, `maxFeePerGasWei`, and their product as a worst-case execution-gas ceiling for one new transaction. The defaults are 200,000 gas and 30 gwei, giving a ceiling of 0.006 native units. Describe this as a per-transaction bound, not a daily budget or a complete fee estimate for every chain. Keep these fields in `node.json`; preserve explicit values through upgrades. IPFS mode reports that gas policy is inapplicable. Regression tests must show over-cap preparation stops before signing/broadcast in direct and worker paths. Keep the current warning that lowering caps below a persisted transaction can pause its reconciliation.

`balance` reads the public node address and approved RPC configuration, verifies chain ID, and calls `eth_getBalance` without constructing a signer. An optional RPC authorization reference is distinct from the node key. Parse quantities with exact integers and enforce bounded, redacted requests. Report RPC failure as unknown rather than zero. Monitoring thresholds are decimal-string wei values, with no floating-point comparisons.

Add `scripts/operator-monitor.mjs`, invoked by `operator-node.mjs monitor --once` or `monitor --watch`. Run it as a separate host process so Docker or worker shutdown does not kill it. Provide optional user-level launchd and systemd examples for installation under the operator's control. `monitor --once` only reports; `monitor --watch` enables configured notification delivery. Default settings when monitoring is enabled are a 60-second health poll, a 300-second balance poll, and three consecutive bad health samples before a stopped/degraded warning. Default low-balance warning is twice the configured one-transaction gas ceiling, overridable with `lowBalanceWei`; it is a conservative reserve threshold, not a forecast of messages remaining. Recover at 110% of the warning threshold to reduce repeated boundary alerts. Zero is always unhealthy for Ledger funding. IPFS mode skips RPC and balance warnings.

Persist only sanitized incident state under the private state directory, with atomic writes and a single-monitor lock. Emit one alert on transition, one recovery, and at most one reminder per hour. Local alerts go to structured stdout and, when `desktopNotifications` is explicitly enabled on macOS, native notifications through a bounded `osascript` subprocess with fixed script text and separate sanitized arguments. Honor OS permission prompts; unsupported explicitly selected notification backends must report a configuration error. Linux operators can use service logs and the external delivery option below. Keep runtime health, low balance, RPC failure, and notification failure distinct. Startup must detect an already stopped node after the grace period; a working HTTP listener without current worker progress is insufficient. A notification outage must not affect node execution, signing, or transaction recovery. Tests use an injected clock and fake transports rather than wall-clock waits.

Recommend two optional external heartbeat checks: runtime availability and wallet balance. Send an empty success POST only when the corresponding observation is healthy and fresh. An operator-selected service observes missing success pings and delivers email/chat/push alerts after its configured grace period. This catches host sleep, monitor failure, and network loss as well as node failure, without publishing the node's private health endpoint. Healthchecks is one compatible example; its [configuration guide](https://healthchecks.io/docs/configuring_checks/) describes periods, grace time, and schedules, and its [ping API](https://healthchecks.io/docs/http_api/) documents success pings. A self-hosted compatible receiver is also possible. Keep URLs in protected files or Keychain references; treat them as credentials and never log them. Use TLS, no redirects, finite deadlines, and bounded retries.

The local monitor provides diagnosis; missing remote pings indicate lost healthy observations, not a proven root cause. Configure external grace/schedules to tolerate the operator's normal laptop closures. Document planned maintenance and resuming external checks, without sending fabricated healthy pings during downtime. No external service is enrolled by default. A separate read-only balance monitor on an always-on host is an optional operational recommendation when balance observation must continue during laptop sleep; it needs only the public address and authorized RPC access.

### Milestone 6: Package, document, and validate the operator workflow

Include every new host module, overlay, template, and guide in `scripts/publish-image.sh` and the migrated upgrader's explicit archive allowlist. Package the host helpers and their pinned dependencies, including supported native locking artifacts, as reviewed release assets. Keep runtime JavaScript under `src/` so the image includes it. Test that extracted bundles work outside a checkout with no host npm installation and no implicit imports from the source tree. Specify minimum helper/image compatibility; old images lacking the signing entrypoint need a clear diagnostic. Update the deployment skill and human guides together, including new-installation handoffs and preserving existing private profiles during upgrade.

Extend the existing integration harnesses and add `node/production/scripts/test-operator.mjs` to drive the actual host CLI against disposable services. Cover offline submission, seven-day eligibility, restart, Keychain lifecycle, health, gas policy, and notification transitions. Use a controlled notification receiver, disposable PostgreSQL/Kubo, and Anvil with synthetic accounts. Finish by reviewing the full proposed change and resolving findings. Update this plan with exact validation results, implementation decisions, and any remaining limitations before requesting implementation review.

## Concrete Steps

All repository commands below run from the repository root. During the current plan-only stage, inspect this document and PR scope and run `git diff --check`; do not run implementation milestones. After approval, use Node.js 24, Docker/Compose, and Foundry for the integration harness. Python 3.9+ is needed only to run the old reference tests during the migration milestone. Existing locked dependencies can be installed with `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund` when needed.

Run the reference suites before removing the old implementations:

    python3 -B node/production/test/keychain-worker_test.py
    python3 -B node/production/test/upgrade-node_test.py

Run focused JavaScript checks as each milestone lands. New filenames below are planned test files; the existing helper test files will contain the migrated tests directly instead of invoking Python:

    node --test node/production/test/keychain-worker.test.mjs node/production/test/upgrade-node.test.mjs
    node --test node/production/test/operator-credentials.test.mjs
    node --test node/production/test/operator-node.test.mjs
    node --test node/production/test/operator-monitor.test.mjs
    node --test node/production/test/operator-sign.test.mjs
    node --test node/production/test/inbox.test.mjs node/production/test/inbox-client.test.mjs
    node --test node/production/test/inbox-worker.test.mjs node/production/test/inbox-ledger.test.mjs
    node --test node/production/test/local-status.test.mjs node/production/test/local-check.test.mjs node/production/test/send-message.test.mjs
    node --test node/production/test/runtime.test.mjs node/production/test/publication.test.mjs
    node --test node/production/test/publish-image.test.mjs node/production/test/release-node.test.mjs

After the focused checks pass, run the full production suite and the relevant real-service acceptance once for the integrated change:

    npm --prefix node/production test
    npm --prefix node/production run test:inbox
    npm --prefix node/production run test:inbox:docker
    node node/production/scripts/test-operator.mjs
    git diff --check

The new integration script must create isolated resources, report sanitized evidence, and clean up only the resources it created. It should build/select a local fixture image without publishing. Existing smoke helpers provide patterns for deploying Ledger on Anvil through `forge script --root contracts script/DeployLedger.s.sol:DeployLedger --rpc-url "$ANVIL_RPC_URL" --private-key "$ANVIL_TEST_KEY" --broadcast`; these variables refer only to the disposable local chain and generated test account. Contract source changes are not part of this plan.

After implementation, the operator-facing examples below work from a checkout or extracted bundle root after selecting a private profile. The environment variable holds a path, not a credential:

    export OYA_OPERATOR_PROFILE="$OYA_LOCAL_DIR/operator.json"
    node node/production/scripts/operator-node.mjs status
    node node/production/scripts/operator-node.mjs send --file "$MESSAGE_FILE"
    node node/production/scripts/operator-node.mjs job-status --job "$JOB_FILE"
    node node/production/scripts/operator-node.mjs send --job "$JOB_FILE"
    node node/production/scripts/operator-node.mjs gas-policy
    node node/production/scripts/operator-node.mjs balance
    node node/production/scripts/operator-node.mjs monitor --once

`MESSAGE_FILE` and `JOB_FILE` are operator-selected private files. The send commands publish content and can cause Ledger gas expenditure; execute them in acceptance only against the disposable fixture or within separately authorized live scope. Monitoring setup examples must name the expected service state and external grace configuration so a user can verify whether alerts are actually enabled.

## Validation and Acceptance

| Behavior | Required evidence |
| --- | --- |
| JavaScript migration | All 68 existing Python cases have equivalent JavaScript coverage; embedded Python fixtures are replaced; legacy/current helpers contend on the same locks; killed processes release locks; archive rejection and recovery invariants hold. Bundled host tools work without Python or a source checkout on supported macOS/Linux hosts with Node.js 24. |
| Keychain upgrade | Token-only, node-key-only, combined, and mixed-file selections pass; preview/stop do not retrieve secrets; denied/missing/locked items, changed manifests, Docker failure, symlinks, concurrent operations, partial startup, and cleanup failures leave recoverable state. Synthetic secret sentinels are absent from output, argv, Docker environments, and journals. |
| Real Keychain lifecycle | A disposable macOS installation upgrades with synthetic Keychain credentials, retains public node identity, removes temporary host files, preserves unrelated containers/volumes, and resumes the same saved job. Mock tests alone do not satisfy this platform check. |
| Simple status | Direct and worker healthy/busy states succeed; stopped Docker/node, wrong target/address/chain/mode, stale polling, malformed bodies, timeout, retrying, and unknown transaction outcome produce actionable nonzero results. No signing key is retrieved. |
| One-command send | Authorized file- and Keychain-backed sender keys submit in both supported modes. Offline worker submission reports queued, saves the envelope before HTTP, survives client restart, and resumes with the same ID. Invalid input/credentials cause no submission. Unknown direct outcomes never auto-resubmit. |
| Seven-day queue | Controlled clocks prove exact default and boundaries; integration proves an envelope aged beyond 24 hours but less than seven days remains eligible, expiry prevents new queued execution, and an already-checkpointed transaction still reconciles after expiry. Test age deterministically with signed timestamps and fixture database state; do not wait days. |
| Replay and retention | Identical envelopes retain their original result before expiry; status works after expiry; prune retains replay records through signed expiry plus seven days and never removes unresolved processing records. Old signed jobs retain old deadlines. |
| Gas limits | Effective defaults/overrides match `parseConfig()`; estimates above either ceiling produce no signature/broadcast. IPFS mode needs no RPC/key. Lowered limits do not replace a saved transaction. |
| Warnings | Injected balance and clock changes prove grace, zero/low/exact-boundary/recovered balance, RPC failure, bounded reminders, persistence, and recovery. Fake heartbeat receiver receives only empty successful-health signals; missing signals trigger a controlled external-test alert after configured grace. Stop the monitor entirely to demonstrate the failure case that local logging cannot detect. |
| Packaging and compatibility | Extracted bundle imports all helpers, offline image signing uses the intended digest/platform, older helper/image incompatibility is explicit, and file-backed/token-only installations keep working. Full suite and applicable integration checks pass. |

The plan-only PR requires document/scope validation, not claims about these future runtime tests. At implementation review, state explicitly if Docker, macOS Keychain access, or external heartbeat acceptance was unavailable, and provide the exact remaining procedure. Do not present mocked coverage as successful live operation.

## Idempotence and Recovery

Upgrade preview remains read-only with respect to the installation and Keychain. Apply/quiesce retain existing private journals, verified image/bundle identity, dependency containers, named volumes, and coordination rules. On failure, preserve the journal and signed transaction checkpoints; confirm shutdown before another worker starts. Credential failures must not regenerate keys, alter Keychain trust, fall back to a different account, or silently persist decrypted secrets.

Store signed job envelopes before sending and retain them through ambiguous results. Retrying a saved inbox job uses its original ID and signatures. Extending an expired message requires an explicit new request after checking the old result; changing its signed deadline is invalid. Direct submissions remain potentially repeatable operations, so the CLI must not add automatic retry after an uncertain response.

Changing the default lifetime needs no database migration. A rollback does not shorten previously signed seven-day jobs; existing inbox validators already accept them. Longer retention can increase capacity pressure, so operators should inspect queue utilization and preserve replay records rather than deleting unexpired jobs to reclaim space.

Monitoring changes do not restart the node, top up wallets, raise gas caps, replace pending transactions, or alter inbox jobs. Disable a monitor through its user service and pause its external checks deliberately. Retain private alert state across normal restarts to avoid notification storms. If a monitor's state is invalid, report the condition and require repair without modifying node state.

## Artifacts and Notes

The only artifact in this PR remains this ExecPlan. Future implementation artifacts include the migrated JavaScript upgrade/Keychain helpers and tests, packaged host dependencies, the operator CLI and modules, a credential-reference example, a profile example, a node-secret overlay, monitor service examples, tests, and a concise operator guide. Use fixture identities and placeholder paths in committed examples; real profiles, keys, job envelopes, alert URLs, and upgrade/monitor records stay outside Git.

Approval should identify the approved plan revision and any changes to the recommended defaults. Runtime evidence should contain command names, versions, pass/fail counts, and sanitized observations. Finish each milestone by updating Progress, discoveries, decisions, and outcomes. Recheck overlapping PRs before code changes and resolve compatibility with any newly merged batch logging behavior.

## Interfaces and Dependencies

Proposed host command interface:

    node operator-node.mjs [--profile FILE] status [--json]
    node operator-node.mjs [--profile FILE] send (--file FILE | --job FILE) [--expires-in SECONDS] [--wait SECONDS] [--json]
    node operator-node.mjs [--profile FILE] job-status --job FILE [--json]
    node operator-node.mjs [--profile FILE] gas-policy [--json]
    node operator-node.mjs [--profile FILE] balance [--json]
    node operator-node.mjs [--profile FILE] monitor (--once | --watch) [--json]

Use exit 0 for a successful read, accepted submission, or completed publication; 1 for unavailable/unhealthy/unknown/failed operation; and 2 for invalid arguments/configuration. Successful command output always includes an explicit state, so accepted work cannot be confused with completion. A `--wait` deadline ends with a pending result and exit 1, retaining the original acceptance and job identity. Reject `--expires-in` with `--job` or a direct profile and reject `job-status` with a direct profile. If direct batching exists at implementation time, expose its distinct documented result lookup without treating a batch as an inbox job.

`operator.json` version 1 selects `role` (`worker` or `direct`), `nodeConfig`, `workerConfig` for workers, `healthUrl` (loopback only), expected public `nodeAddress` in Ledger mode, `credentialsFile`, `stateDirectory`, and `imageFile`/`platform` for signing. Direct profiles may supply `messageUrl`, defaulting to the health endpoint's origin; remote origins require HTTPS. Mode, chain, Ledger, and gas values come from the selected node config; target/inbox URL come from the selected worker config. Monitoring settings are optional: `healthIntervalSeconds`, `balanceIntervalSeconds`, `failureSamples`, `lowBalanceWei`, `reminderSeconds`, `desktopNotifications` (default false), and credential references for separate runtime/balance heartbeat URLs. A balance below the configured threshold triggers warning; recovery requires at least the integer ceiling of 110% of that threshold. Validate schema, units, limits, owned private paths, and profile/config identity before use. The CLI must show the selected role and public identity so a second installation cannot be mistaken for the first.

`credentials.json` version 1 has optional `worker`, `node`, `sender`, and monitoring entries. Each role selects exactly one source. Worker files contain the existing worker-secrets JSON; node files contain the existing literal `KEY=value` format; sender files contain a private key. A worker/sender Keychain source contains only `kind: "keychain"`, `account`, and `service`. A node Keychain source contains `kind: "keychain"` and an `items` map of allowed node-secret environment names to account/service references. Monitoring URL references use protected files or Keychain entries. Missing required references fail the selected action; unrelated roles are not resolved. Both helper entrypoints consume this same schema, and legacy CLI selections adapt to it without writing migration files automatically.

Existing protocols remain authoritative: EIP-191 message signatures, version-1 inbox job signatures, `/v1/jobs`, `/v1/status`, and private `/healthz`. The new signing entrypoint imports existing protocol/validation helpers and returns captured structured data. Host code uses JavaScript ES modules on Node.js 24, with `security` on macOS; signing reuses the existing JavaScript `ethers`/Oya implementation in the pinned image. Host dependency versions are locked and distributed with the release bundle; native locking support is validated for each supported host/runtime combination in the migration milestone. Operators should not need npm installation or a compiler to run the extracted tools. No new database, contract, or paid service is required by the proposed core workflow.
