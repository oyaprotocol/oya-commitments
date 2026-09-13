# Make a local log-only node easy to deploy and run

This ExecPlan follows `PLANS.md`. **Status: accepted on 2026-09-12; milestone 1 is implemented and validated, with stage 1c awaiting review.** The user will personally review every line of code. Report each stage's diff and validation before proceeding to the next stage. This explicit user instruction takes precedence over the repository's default of continuing through milestones.

## Purpose / Big Picture

An operator should be able to prepare a checkout, configure an Ethereum connection, deploy or reuse Logger, and run a log-only Oya node on their own computer through a small set of commands. A separate local agent can then send signed messages to `http://127.0.0.1:8787/v1/messages`. The node publishes the signed envelope to IPFS, submits its CID to Logger on the configured Ethereum chain, and returns `200` with the verified result.

“Local deployment” describes where the Oya process runs. Its Ethereum RPC endpoint may be local Anvil or an external Ethereum network. IPFS may likewise be a local Kubo service or a supplied compatible API. Running the Oya node locally must not silently select Anvil, start an Ethereum node, replace an IPFS repository, change chain ID, or generate a new signing account.

The accepted first version runs in the foreground: logs appear in the terminal, Ctrl-C stops admission and drains active work, and another terminal can query status or run an agent. This plan does not create a supervisor, PID registry, automatic restart loop, cloud deployment, container setup, or boot-time service. Treat the local instance as maintained operating tooling with stable configuration and explicit failures. Use Node.js built-ins and the existing necessary dependencies; avoid disposable launch scripts in the operator workflow.

Verification, Safe/Governor proposals, agent strategy implementation, and new kernel signing support are outside this plan. The current single-operation HTTP behavior and ethers signing adapter remain unchanged. Operational configuration and deployment receipts are retained; message progress is not journaled.

## Progress

- [x] 2026-09-11 00:07Z: Read root `AGENTS.md`, `PLANS.md`, relevant package/contract guidance, current runtime, smoke, client, and Logger deployment interfaces at commit `5817192`.
- [x] 2026-09-11 00:08Z: Inspected installed Node and Foundry CLI support without making network requests or deploying contracts. Confirmed Node's built-in environment parser is available and Foundry configuration accepts RPC URL/header overrides through `FOUNDRY_ETH_RPC_URL` and `FOUNDRY_ETH_RPC_HEADERS`.
- [x] 2026-09-11: Drafted the local operations workflow and three reviewable milestones. Dates in this plan are UTC; the user's local date is September 10.
- [x] 2026-09-12: User accepted the plan and requested smaller stages, personal review of every line, and strict dependency discipline for a production-quality local instance.
- [x] 2026-09-12: Milestone 1a implementation: `local setup`, path overrides, private template creation, focused tests, and usage instructions. Validated actual locked installs/build and template creation with temporary files; fixed Node's handling of the CLI's `--env-file` argument.
- [x] 2026-09-12: Milestone 1a validation: all 23 host tests passed after the real setup; `git diff --check` passed and no lockfiles or kernel build outputs changed.
- [x] 2026-09-12: User authorized continuing with the small host dependency migration stage after kernel publication.
- [x] 2026-09-12: Kernel release handoff received: all four npm `@oyaprotocol` packages are public at `0.1.1`, with clean metadata, matching archive hashes, and a passing fresh registry-consumer check under Node.js 24.
- [x] 2026-09-12: Release handoff implementation: pin the production host to the four npm kernels at `0.1.1`, simplify setup and its existing tests, and separate the production CI job from the kernel build.
- [x] 2026-09-12: Release handoff validation: all existing external lock entries remain unchanged; real setup succeeded in an isolated copy containing no kernel implementation or build output; all 23 host tests passed under Node 24.21.0. The working checkout also completed a fresh locked host install, and `git diff --check` passed.
- [x] 2026-09-13: User requested a setup readability pass. Removed the repository-root calculation and shared failure state, extracted private template creation, and retained path overrides and file protections. Real setup from another directory, all 24 host tests under Node 24.21.0, and `git diff --check` passed.
- [x] 2026-09-13: Fixed config/environment destination aliases using filesystem identity checks before installation and after each template. Added hard-link and filesystem-aware case tests; all 26 host tests under Node 24.21.0 and `git diff --check` passed.
- [x] 2026-09-13: User authorized milestone 1b after reviewing setup and starting a separate local mainnet fork.
- [x] 2026-09-13: Milestone 1b implementation: selected environment loading, loopback validation, and bounded read-only Ethereum/IPFS checks, with focused CLI and transport tests.
- [x] 2026-09-13: Milestone 1b validation and documentation: all 39 host tests passed under Node 24.21.0, including actual npm check success/failure, selected-file credential precedence, redaction, prerequisite failures, and bounded stalled response bodies. `git diff --check` passed.
- [x] 2026-09-13: Replaced machine-specific validation paths with generic placeholders, preserving commands, tool versions, test conditions, and results.
- [x] 2026-09-13: Published and adopted Ethereum/messages `0.1.2` under the separate [quantity-parser release plan](ethereum-quantity-parser-release-execplan.md). Local checks now use the public kernel parser. Registry validation, a fresh locked host installation, and all 40 host tests passed; external dependency entries are unchanged.
- [x] 2026-09-13: User authorized milestone 1c on the existing roadmap and explicitly deferred config/signer hardening.
- [x] 2026-09-13: Implemented shared local settings loading, foreground child launch with signal forwarding, and bounded health/identity status checks.
- [x] 2026-09-13: Milestone 1c validation and documentation: all 62 host tests passed under Node 24.21.0, including actual CLI startup, npm status, signal forwarding with a held request, occupied ports, sanitized failures, and exit outcomes. `git diff --check` passed.
- [x] 2026-09-13: Updated launch examples and CLI help to use Node.js directly so a supervisor signals the wrapper PID. npm remains the setup/check/status convenience command. Direct help, all six existing CLI/setup tests under Node 24.21.0, and `git diff --check` passed.
- [ ] User reviews milestone 1c before Logger deployment tooling.
- [ ] Milestone 2: Explicit Logger deployment and reuse.
- [ ] Milestone 3: Local agent-to-node integration evidence and operator instructions.

## Surprises & Discoveries

- `node/production/src/main.mjs` already supports a supplied config file, chain and Logger bytecode checks, and SIGINT/SIGTERM draining. These are reusable runtime capabilities; a second server or shutdown implementation is unnecessary.
- The original host used local `file:../../packages/...` dependencies and built kernels during setup. It now installs exact npm releases from its own lockfile: Ethereum/messages `0.1.2` and utils/IPFS `0.1.1`.
- With published dependencies, setup only needs its package directory. Running `npm ci` there preserves the installation behavior without calculating the repository root. The real npm entry was validated from a temporary caller directory with relative config/environment paths.
- The former string comparison allowed both case aliases and existing hard links to return setup success for one underlying file. Reproduction used temporary files and a stub installer. Device and inode IDs identify existing files; previously missing aliases can be detected after the first template creates the file.
- The published Ethereum kernel exposes `requestEthereumJsonRpc` and the utils kernel exposes cancellation/deadline helpers. The check command reuses these with the existing host config parser and signer. Kubo's read-only version probe uses `POST /api/v0/version`; the fixture confirms that normalized API paths and authorization headers reach it.
- Node's `util.parseEnv` parses a file without updating the process environment. Merging its result over inherited values implements the selected-file precedence, including empty entries. Direct `node --env-file` startup gives inherited values precedence; the local commands use their shared file-first loader. The README explains this distinction.
- Milestone 1c shares settings loading in `scripts/local-config.mjs`; `run` forwards the selected environment directly to the existing CLI, preserving file precedence. `status` loads the same settings but only queries local health, allowing upstream service failures to be investigated independently.
- Lifecycle tests hold a real signed HTTP request in an IPFS fixture, signal the wrapper, and release the request before expecting process exit. The first fixture used an invalid CID and triggered the runtime's existing `500` classification; an explicit fixture `403` now exercises a definite upload rejection (`502`) without changing runtime behavior.
- Lifecycle tests launch the wrapper directly, while the original README launched it through npm. npm runs scripts through a shell, so signaling only the npm PID depends on npm/shell behavior. A minimal process-tree probe with npm 11.19.0 on macOS forwarded SIGTERM successfully; that result does not establish portable behavior. The documented launch now matches the direct entry used in lifecycle tests.
- npm initially retained the former local links after the manifest changed because the local packages already reported `0.1.1`. Removing only the old local-package/link entries before regenerating the lockfile resolved this. The final lock contains registry URLs and integrity hashes for all four kernels; every existing external package entry is unchanged. Noble `2.2.0`, formerly supplied by the kernel workspace, is now recorded under the consuming kernels in the host lockfile.
- The host tests share one static Logger ABI JSON fixture with `packages/ethereum/test/fixtures/`; they do not require kernel source or build output. A temporary copy containing only tracked host files and that fixture passed setup and all 23 tests. The first sandboxed test run could not bind localhost (`listen EPERM`); the same suite passed with permission to open its temporary HTTP listeners.
- `scripts/smoke-local.mjs --keep-running` starts a complete disposable Anvil/Kubo/node demonstration. It generates accounts, deploys a fresh Logger, and uses temporary artifacts. It is a test fixture rather than the operating configuration for a durable node identity.
- The existing runtime deliberately has no publication journal, deduplication, or automatic restart recovery. A health result of `transaction_outcome_unknown` must not trigger a management-script restart that clears that flag.
- A local agent already has a usable wire protocol and example client in `node/production/scripts/send-message.mjs`. Receiving messages does not require an agent-specific package or reimbursement logic.
- Foundry's script path is relative to the invoking working directory even when using `--root contracts`. Invoke `contracts/script/DeployLogger.s.sol:DeployLogger` from the repository root, as the working smoke does.
- A read-only configuration probe with non-secret loopback values confirmed `FOUNDRY_ETH_RPC_URL` and a JSON array in `FOUNDRY_ETH_RPC_HEADERS` populate Foundry's `eth_rpc_url` and `eth_rpc_headers`. The same probe did not populate `eth_rpc_url` through `ETH_RPC_URL`. Validate actual script behavior in the local integration test rather than assuming Cast and Forge use identical environment names.
- Node 23.10.0 consumed `--env-file` even after the script filename, causing setup to exit with code 9 before creating the selected file. `node -- scripts/local-node.mjs` prevents that interpretation. The npm command uses this separator, and a process test passes a nonexistent environment file through the actual npm entry to guard against regression.

## Decision Log

- Decision: Keep node location separate from Ethereum/IPFS location. Rationale: a local node must still interact with the selected Ethereum network and supplied services. Date/Author: 2026-09-11 / user requirement, recorded by Codex.
- Decision: Use a foreground local command with terminal logs, status, and Ctrl-C shutdown. Rationale: reuses the existing lifecycle and avoids introducing a background service manager for the first local release. Date/Author: proposed 2026-09-11 / Codex; accepted 2026-09-12 / user.
- Decision: Keep Logger deployment an explicit action; running or restarting the node only uses an existing address. Rationale: service lifecycle operations should not unexpectedly deploy contracts or spend deployment gas. Date/Author: 2026-09-11 / Codex.
- Decision: Reuse the existing Foundry deployment script and signed-message client. Rationale: the missing work is operating-tool orchestration, not another contract deployer or agent implementation. Date/Author: 2026-09-11 / Codex.
- Decision: Keep dependencies, kernel interfaces, contract ABI, and runtime message semantics unchanged. Rationale: the scripts can use Node built-ins, the existing host dependencies, and Foundry. Add no compatibility options or migration layer. Date/Author: 2026-09-11 / Codex, following the user's constraints.
- Decision: Split milestone 1 into setup, readiness, and lifecycle review stages. Rationale: the user reaffirmed that each change must be small enough for personal line-by-line review. Date/Author: 2026-09-12 / Codex, following the user's instruction.
- Decision: Include existing development dependencies when installing the kernel workspace for setup (`ci --include=dev`). Rationale: its TypeScript compiler is required to build even when the caller has `NODE_ENV=production`; this adds no dependency or lockfile change. Date/Author: 2026-09-12 / Codex.
- Decision: After kernel publication and registry validation, migrate the host's existing kernel dependencies to exact npm `0.1.1` versions in a separate small review stage. That change supersedes the kernel build step in operator setup; kernel development retains its own build/test workflow. Date/Author: 2026-09-12 / Codex, following the user's packaging-first workflow.
- Decision: Give the production host its own Node 24 CI job, with its own lockfile cache key and no kernel install/build step. Rationale: validate the published dependency boundary on every run while retaining the existing kernel build job. Date/Author: 2026-09-12 / Codex, implementing the authorized dependency migration.
- Decision: Simplify setup using a package-relative directory, errors handled at each operation, and a small `prepareTemplate` helper. Rationale: the user requested clearer control flow while retaining safe file creation, path overrides, and test hooks. Date/Author: 2026-09-13 / Codex, following the user's instruction.
- Decision: Compare destination device/inode IDs with bigint stats before installation and after template preparation. Rationale: catches hard links and filesystem aliases without assumptions about operating-system case sensitivity. A newly created template may remain after an alias failure; preserve it and let the operator correct the paths. Date/Author: 2026-09-13 / Codex, implementing the user-approved edge-case fix.
- Decision: Load `scripts/local-check.mjs` dynamically only for `check`. Rationale: `setup` and help must work before npm dependencies are installed. The check module reuses installed kernels and ethers without changing runtime modules or adding dependencies. Date/Author: 2026-09-13 / Codex.
- Decision: Require the selected environment file to be readable, allow an empty file, and stop at the first failing probe with a 10-second deadline per probe. Rationale: a missing selected file must not silently select an inherited identity; separate deadlines keep readiness bounded while identifying the failing prerequisite. Deadlines include response bodies and RPC retries. Date/Author: 2026-09-13 / Codex.
- Decision: Adopt the public bounded quantity parser from Ethereum `0.1.2` and update messages to its matching `0.1.2` dependency pin. Rationale: removes the host's duplicate parser and preserves the single Ethereum instance required by error-class checks. Date/Author: 2026-09-13 / user-authorized release, implemented by Codex.
- Decision: Keep `run` as a foreground child process using `process.execPath` and inherited terminal output, with SIGINT/SIGTERM forwarding and no forced termination timer. Rationale: reuse the runtime's existing draining behavior and preserve the child's exit outcome. Date/Author: 2026-09-13 / Codex, implementing milestone 1c.
- Decision: Document `node -- node/production/scripts/local-node.mjs run` for foreground operation and supervision. Rationale: the supervised PID belongs to the wrapper with the tested signal handlers, avoiding dependence on npm/shell forwarding. Retain npm for setup/check/status and the `--` separator for script options. Date/Author: 2026-09-13 / user-approved review update, implemented by Codex.
- Decision: Give `status` a five-second deadline including body reading, reject redirects, and accept only recognized health states with consistent HTTP status and matching identity. Rationale: a different local service must not be reported as the configured node. Date/Author: 2026-09-13 / Codex.
- Decision: Forward only `OYA_NODE_PRIVATE_KEY`, `OYA_RPC_AUTHORIZATION`, and `OYA_IPFS_AUTHORIZATION` among Oya/Logger environment variables. Rationale: the node child does not need agent or deployment credentials; preserve other ordinary process environment settings. Date/Author: 2026-09-13 / Codex.

## Outcomes & Retrospective

Milestone 1a adds the maintained `local setup` command using Node built-ins, three focused tests, a package command, and brief operating instructions. Setup installs/builds from the existing lockfiles and creates private templates without overwriting existing regular files or their permissions. The actual command completed successfully with temporary config/environment destinations, followed by all 23 host tests passing. Existing operator node configuration files were not read or changed. No dependencies, lockfiles, runtime message handling, or contracts changed; no Ethereum or IPFS services were started and no blockchain transaction was submitted. Full milestone 1 still requires configuration loading, readiness checks, and lifecycle commands.

The intended outcome is a usable local node with a stable operator-selected identity and Logger address, exercised by a separate local client process. It does not claim unattended recovery after a crash or persistent availability after the terminal closes. Record each milestone's actual validation and remaining work here when implemented.

The kernel release plan completed on 2026-09-12 with `0.1.1`, superseding `0.1.0` as the host migration target. Published archives match the reviewed files and pass runtime/declaration checks in a fresh npm consumer.

The host dependency migration is implemented and validated for review. All four dependencies use exact npm `0.1.1` versions, setup runs only the host's locked install, existing setup tests cover the single install and its failure, and host CI runs independently of kernel building. The real setup and all 23 host tests passed under Node 24.21.0 in an isolated copy with no kernel source, compiled output, or TypeScript. Newly created template files have mode `0600`; the host lockfile was preserved by setup and installation. Existing external dependency versions and runtime source files are unchanged. No operator configuration or credentials were used. Milestones 1b onward remain unimplemented pending review of this stage.

The subsequent setup readability pass preserves the CLI options, `0600` creation, existing-file checks, and sanitized failures. It replaces the mutable failure message and empty throws with explicit returns near each failure, and runs `npm ci` in the package directory. A focused test now verifies that a template failure is sanitized and stops before preparing the next file. `npm --prefix node/production test` passed all 24 tests under Node 24.21.0. Real setup from a temporary caller directory with relative `--config config.json --env-file node.env` created matching private templates there and preserved the lockfile. No operator configuration or credentials were used; milestone 1b remains unimplemented.

Validation records use generic placeholders for temporary directories so contributors can reproduce the checks in their own environment. Normal setup installs the published npm releases into `node/production/node_modules` and creates the default `node/production/config.local.json` and `.env`. Validation used separate config files, an npm cache, and a temporary Node 24 installation to preserve the operator's settings and system Node version.

The destination-alias fix adds a small `sameFile` helper and two regression tests. Existing aliases fail before installation or file changes; newly discovered aliases fail before setup can report success. The case test probes the destination filesystem and permits distinct case-sensitive names. Repetition verifies that a detected alias fails before another install. `npm --prefix node/production test` passed 26 tests with no skips under Node 24.21.0, and `git diff --check` passed. Tests used temporary files and stubbed installation; no dependencies, operator files, or kernel/runtime interfaces changed. The user subsequently authorized milestone 1b.

Milestone 1b is implemented and validated for review. `local check` loads the selected files, validates loopback binding, derives the public node address, and checks chain ID, Logger code presence, positive node balance, and Kubo API reachability. It reports sanitized results without changing files, publishing content, or sending transactions. All 39 host tests passed under Node 24.21.0 using generated credentials and controlled endpoints. No operator configuration or credentials were used, and the independently running mainnet fork was not changed. Successful fixture checks do not establish readiness of that fork: an actual Logger deployment, funded node identity, and IPFS endpoint still need validation in the subsequent stages. Milestone 1c is next after review.

The subsequent parser release replaces the local `quantity` helper with `parseTransactionQuantity` from the installed Ethereum kernel. Ethereum/messages `0.1.2` are published, hash-verified, and installed through the host lockfile; utils/IPFS remain at `0.1.1`. All 40 host tests pass, including oversized RPC balance rejection and the existing failure-classification paths. Config/signer hardening and milestone 1c remain separate work.

Milestone 1c completes the first operating milestone with `local run` and `local status`. Shared settings loading preserves the selected-file precedence and strips unrelated Oya/Logger credentials from the node child. Run performs read-only readiness checks, starts the existing CLI, forwards shutdown signals once, and waits for the child to finish. Status checks local health and identity with a five-second deadline and reports uncertain outcomes without recovery actions. All 62 host tests pass under Node 24.21.0 on macOS. Validation used generated keys and controlled local endpoints; the operator's configuration, background fork, dependencies, and runtime source were unchanged. Full Anvil/Kubo deployment and publication evidence remain milestones 2 and 3. The user explicitly deferred config/signer hardening.

The launch-guidance review aligns README examples, CLI help, and this plan with direct Node.js supervision. Runtime behavior and dependencies are unchanged; existing lifecycle tests already exercise this entry path. From the repository root, `node --test node/production/test/local-operations.test.mjs` passed all six tests under Node 24.21.0. `node -- node/production/scripts/local-node.mjs run --help --env-file missing-for-help.env` printed the new guidance without reading configuration, and `git diff --check` passed.

## Context and Orientation

The standalone runtime is `node/production/`. `src/config.mjs` validates configuration and constructs authorized RPC/IPFS transports. `src/signer.mjs` loads `OYA_NODE_PRIVATE_KEY` and signs transactions with ethers. `src/main.mjs` starts the server after checking the chain and Logger. `src/server.mjs` owns `/healthz`, `/v1/messages`, authentication, the single-operation guard, deadlines, and final responses. Preserve these responsibilities.

`packages/` supplies the hardened libraries; application setup, environment loading, CLI commands, and Foundry orchestration belong in the host tooling. `contracts/script/DeployLogger.s.sol` already deploys Logger and enforces `LOGGER_CHAIN_ID`. It consumes `LOGGER_DEPLOYER_PK`, which is a deployment credential separate from the running node's key.

`node/production/config.example.json` and `.env.example` are templates. The existing default local files, `config.local.json` and `.env`, are ignored by Git. `scripts/send-message.mjs` signs a nonempty ASCII file using `OYA_AGENT_PRIVATE_KEY` and submits the existing JSON envelope. The prior completed runtime plan is `plans/production-node-direct-handler-execplan.md`; its 20 host tests and real local smoke are the regression baseline.

### Operator interface

The `setup`, `check`, `run`, and `status` actions are implemented with published dependencies. `deploy-logger` remains planned for the next review milestone.

Use `node -- node/production/scripts/local-node.mjs run` from the repository root to launch the node. A supervisor must execute this command directly and signal the wrapper's Node.js PID. Use the package command `npm --prefix node/production run local -- <action>` for setup/check/status and the planned explicit deployment action. Both entry paths use `node/production/scripts/local-node.mjs`. Support `--config <path>` and `--env-file <path>` for commands that consume settings. Their defaults are `node/production/config.local.json` and `node/production/.env`, resolved from the package location. Resolve supplied relative paths against the caller's original working directory (`INIT_CWD` under npm, otherwise `process.cwd()`), and show absolute paths in examples with overrides. Running from another directory must not break repository-relative build or deployment commands.

| Action | Behavior |
| --- | --- |
| `setup` | Install the production package and its pinned npm kernels from the host lockfile, then create missing config/environment files from the templates. Never overwrite existing files or generate real-network keys. |
| `check` | Validate settings, derive the node's public address, check Ethereum chain ID, Logger bytecode, node gas balance, and IPFS API reachability. Read-only and bounded by timeouts. |
| `run` | Check the configured environment and launch the existing node CLI in the foreground. Print its local URL and public identity; preserve terminal logs and graceful signal handling. |
| `status` | Query the configured local `/healthz`, check the returned identity against configuration, and report ready, busy, unavailable, unreachable, or identity mismatch. Never start or restart anything. |
| `deploy-logger` | Simulate the existing Logger deployment script, or report that a configured deployment is already usable. Broadcast only with explicit `--broadcast`; record and apply a newly verified address. |

Use `--help` to describe these actions and their exit behavior. No action other than `deploy-logger --broadcast` submits a transaction by itself. In particular, neither `check` nor `status` sends a test message. Normal HTTP messages received during `run` retain their existing blockchain effects.

### Configuration and secrets

Keep the existing runtime schema. Required settings remain chain ID, Logger address, signer allowlist, and RPC/IPFS URLs. The local runner accepts only loopback binding addresses, initially `127.0.0.1` and `::1`; its default remains `127.0.0.1:8787`. Do not bind to all interfaces or assume an external agent needs inbound public access. A local agent uses the printed node URL and must sign with an address in `allowedSigners`.

Use Node's built-in `.env` support instead of a new dotenv dependency. Define precedence explicitly: values in the selected environment file override corresponding inherited values; missing values may be supplied by the operator's environment. Do not silently load additional files. For the node child, forward the selected node key and provider authorization values, and remove agent/deployer keys. For deployment, pass only the deployment credential and selected RPC configuration among the Oya/Logger settings. Tests must demonstrate that an unrelated inherited key cannot override an explicitly selected file.

Milestone 1c moves the existing loading into `scripts/local-config.mjs` using `util.parseEnv`, shared by check, run, and status. The selected file must be readable, even when empty and using inherited credentials. The node child receives the merged environment with unrelated Oya/Logger variables removed and reads the selected config file through its existing CLI; keep that file stable while launching. Readiness probes stop at the first failure, with 10 seconds per probe covering transport, response reading, and any RPC retries. Nonempty bytecode, positive balance, and the version endpoint establish basic prerequisites only; they do not prove contract identity, sufficient gas for a particular transaction, or IPFS upload permissions.

Create new private config/environment files with mode `0600`; never overwrite or loosen existing permissions. RPC URLs can contain credentials, so output only public chain/address information and local paths, not complete config objects, URLs for providers, private keys, headers, raw child-process exceptions, or unsanitized provider failures. Installation, startup, and deployment failure messages should name the failed step and give a safe next action.

Use one new ignored `node/production/deployment.local.json` for successful Logger deployment metadata: chain ID, contract address, deployment transaction hash, block number, and deployer address. For a custom config path, use a sibling filename derived from that config's basename so separate configurations do not overwrite each other's metadata. This record contains no signing material or message progress. Do not add `stateDir`, transaction replay, process locks, or runtime persistence.

### Prerequisites and service boundaries

The local node requires Node 22 or newer, npm, configured Ethereum RPC access, a funded node account, and a Kubo-compatible IPFS API with publication access. Foundry and the `lib/forge-std` submodule are required only when deploying Logger or running the full local integration fixture. Anvil and Kubo executables are required only for the all-local test path.

`setup` runs only `npm ci` with `node/production` as the child working directory, equivalent to `npm --prefix node/production ci` from the repository root. Operators need no kernel source build or TypeScript installation. Use only built-in imports for setup, and lazy imports for later actions that need the kernel or ethers packages, so setup can run before production dependencies are installed. Do not install global tools, upgrade packages, rewrite lockfiles, or reinstall packages during `run`. A failed setup exits nonzero with the failed step identified; repeating it is permitted.

The `check` action uses configured authorization headers. Check chain ID and Logger code through the existing Ethereum RPC API, inspect the node's native balance, and query the IPFS API's version endpoint without uploading. A zero gas balance is a readiness failure; a positive balance is not a guarantee that every later transaction fits the budget. Reachability does not prove IPFS write permission or long-term content availability; the explicit integration test proves publication. These checks must not depend on Anvil-specific RPC methods.

The operator owns the supplied Ethereum and IPFS processes. This CLI must not stop them, reset them, fund accounts through development RPC methods, or overwrite their data. For a disposable demonstration, retain the existing `smoke:local -- --keep-running` workflow and label it clearly. A persistent IPFS service retains the uploaded data independently of this node's process lifetime.

## Plan of Work

### Release handoff: Install published kernels

This stage is implemented using the verified `0.1.1` releases recorded in `plans/kernel-packages-release-execplan.md`. The production host's four local `file:` dependencies have been replaced with exact `@oyaprotocol/{utils,ethereum,ipfs,messages}` versions `0.1.1`. Its regenerated lockfile preserves all existing external entries. Kernel installation/building was removed from `local setup`; affected host instructions and existing tests were updated. The production CI job now installs and tests independently of the kernel build job. Kernel APIs and HTTP runtime behavior are unchanged.

Fresh locked installation, real setup with temporary config/environment destinations, and all 23 host tests passed under Node 24.21.0. The isolated validation copy contained no kernel source or compiled output, and no TypeScript was installed. See Artifacts and Notes for commands and evidence. Present this stage for line-by-line review before readiness work.

### Milestone 1: Prepare and run a configured local node

Implement this milestone in three separate review stages: 1a provides setup, private template creation, path options, and help; 1b loads configuration/environment and implements `check`; 1c implements `run` and `status` with lifecycle tests. Each stage updates this plan and stops for the user's code review. Do not advertise commands as available before their implementation. During 1a, installation is exercised with temporary config destinations; blockchain and IPFS services are not needed.

The implemented `scripts/local-node.mjs` dispatches setup, check, run, status, and help. Launch `run` directly with Node.js; the other actions use the `local` package command. `scripts/local-config.mjs` owns shared settings loading and loopback URL formatting; `scripts/local-check.mjs` owns readiness probes; `scripts/local-run.mjs` owns the foreground child lifecycle; `scripts/local-status.mjs` owns the health query. All new tooling stays outside `packages/`, with no HTTP runtime changes.

`setup` copies templates only when missing and clearly identifies fields the operator must fill. The template Logger address is not a deployment; bytecode readiness checks must still reject it unless it actually identifies code on the selected chain. `run` delegates to `src/main.mjs` through `process.execPath`, forwards SIGINT/SIGTERM, waits for the child to finish draining, and preserves its exit outcome. Do not use Node watch mode, an automatic restart policy, or a short force-kill timeout. Startup failure or an occupied port must not leave another process running.

`status` is a bounded health query. Treat ready and busy as a running service, and distinguish them in output. Return nonzero for unavailable, unreachable, malformed health data, or a mismatched chain/Logger/node identity. It must remain useful when the node deliberately reports `transaction_outcome_unknown`; that result is not an instruction to restart. Terminal output is the log interface. Stop with Ctrl-C in the owning terminal; restart by an explicit subsequent `run` after appropriate reconciliation.

Focused tests live in `test/local-operations.test.mjs`, `test/local-check.test.mjs`, `test/local-lifecycle.test.mjs`, and `test/local-status.test.mjs`, included by the existing `npm test` glob. They cover preservation of settings files, environment precedence and secret redaction, wrong-chain/Logger/IPFS readiness failures, occupied ports, unavailable health without restart, and signal forwarding that waits for the child. Fixtures use generated credentials and controlled endpoints without external services.

This milestone is independently usable with an already deployed Logger and supplied RPC/IPFS endpoints. Show its diff and `npm --prefix node/production test` results, then pause for review.

### Milestone 2: Deploy Logger explicitly and retain its identity

Add the `deploy-logger` action as orchestration of `contracts/script/DeployLogger.s.sol`. No Solidity changes are expected. First initialize the existing `lib/forge-std` submodule if needed and build the contracts. Validate the selected chain and deployment key before invoking Forge. This action can operate before the running node is funded or has usable Logger bytecode; do not call the full node-readiness check as its prerequisite.

If the configured Logger already has code, report that the existing address is in use and do not deploy another contract. Otherwise, `deploy-logger` without `--broadcast` runs the Foundry simulation only. With `--broadcast`, repeat simulation as part of the normal Foundry script execution and broadcast explicitly. Use the configured chain ID for `LOGGER_CHAIN_ID`, the separately supplied `LOGGER_DEPLOYER_PK`, and the configured RPC endpoint and authorization. An external network is allowed by configuration, but implementation validation broadcasts only on isolated Anvil; approval of this plan is not permission to use unspecified live credentials or funds.

Invoke Forge from the repository root with argument arrays, not shell-interpolated commands. Supply `FOUNDRY_ETH_RPC_URL` and `FOUNDRY_ETH_RPC_HEADERS` through its child environment so credential-bearing RPC URLs and headers do not appear in process arguments. Validate the installed Foundry behavior in the local tests, including authorized RPC access. Do not log the child environment. Contract deployment remains implemented by the existing Solidity script; host code only orchestrates it and reads the result.

After a broadcast, verify the successful receipt, expected chain, and deployed code using the existing Ethereum kernel primitives. Read the current invocation's Foundry artifact, not an unrelated stale `run-latest.json`; isolate broadcast output or check invocation freshness and identity before selecting its transaction. Only then write public deployment metadata and update `loggerContract` in the selected config. Preserve all other settings and file permissions, and replace config atomically. Simulation, failure, or uncertain receipt observation must leave the configured address unchanged.

Do not automatically retry, redeploy, or invoke `forge --resume` after an ambiguous broadcast. Retain the available Foundry artifact and report any known hash through sanitized output for operator inspection. If onchain deployment succeeded but recording configuration failed, report the verified address so it can be adopted without another deployment. There is no replacement-deployment flag in this first version; a separate intentional configuration can be used for a different deployment.

Add a blank, documented `LOGGER_DEPLOYER_PK` entry to `.env.example`; existing local environment files remain untouched. Extend CLI tests for simulation without broadcast, chain mismatch before effects, preservation of configuration on failure, verified address recording, and reuse without redeployment.

Introduce `node/production/scripts/test-local-operations.mjs` and a `test:local` package command in this milestone. Initially this fixture owns a fresh Anvil process, temporary config/environment files, and a generated funded deployment account. Exercise the actual CLI to simulate, broadcast, verify the recorded address, and repeat deployment as a reuse operation with no additional transaction. Always stop the owned process. Run the host tests, contract build, and `test:local` before reviewing this milestone; milestone 3 will extend this same fixture to publication and node lifecycle checks.

### Milestone 3: Prove operation with a separate local sender

Extend `node/production/scripts/test-local-operations.mjs` to run isolated offline Kubo alongside its disposable Anvil, using the existing smoke's approach. Generate separate deployer, node, and agent identities, and fund only the test deployer and node through that owned Anvil. Create private config/environment files in a temporary directory; do not touch the operator's default files or services.

Exercise the actual local CLI to simulate and deploy Logger, run `check`, launch `run`, and query `status`. From a separate child process, use the existing `scripts/send-message.mjs` with an agent-only environment to submit a signed file. Assert the `200` / `logged` response, retrieve the exact signed envelope from Kubo, and independently inspect the expected Logger event on Anvil. A disallowed signer must be rejected before any Logger transaction. No new agent implementation is needed to prove the same interface is usable by a local agent.

Stop the foreground node via SIGINT and confirm its child exits; keep the fixture RPC/IPFS services alive. Restart with the same config and node identity and assert the Logger address is unchanged and no transaction was submitted merely by restarting. Submit another explicit message and verify it succeeds. Exercise `status` after shutdown and inspect output for secret markers. Stop every fixture-owned process in cleanup and leave unrelated processes alone. Record public addresses, hashes, and checks in a temporary evidence file, with no secret values.

Update `node/production/README.md` with the setup/run/status/deploy workflow, explicit foreground stopping, supplied-service ownership, separate agent signing, failure handling, and the distinction between a local node and its Ethereum network. Add concise pointers in `node/README.md` and the completed direct-handler plan where useful. Keep the old smoke as a regression test; do not turn it into the production launcher or refactor it broadly just to share a few fixture lines.

Run the host tests, contract build, new local integration test, existing smoke, and whitespace checks. Review evidence and documentation before declaring the plan complete.

## Concrete Steps

Use the repository root unless otherwise specified. Setup, check, run, and status are available. Deployment commands and `test:local` below remain planned for milestones 2 and 3; the examples describe the complete intended workflow.

The intended operator workflow is:

    npm --prefix node/production run local -- setup

Edit the created `config.local.json` and `.env` with the intended chain, RPC/IPFS endpoints, allowed agent addresses, and node key. Supply an existing Logger address, or load a deployment key and explicitly use:

    npm --prefix node/production run local -- deploy-logger
    npm --prefix node/production run local -- deploy-logger --broadcast

The first deployment command simulates; the second broadcasts only when a usable Logger is not already configured. Then:

    npm --prefix node/production run local -- check
    node -- node/production/scripts/local-node.mjs run

In another terminal:

    npm --prefix node/production run local -- status
    node --env-file=/absolute/path/to/agent.env node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt

The agent environment contains `OYA_AGENT_PRIVATE_KEY`, and its corresponding address is allowlisted in the node config. The file contains the exact nonempty ASCII text to sign. A successful response contains the CID and verified Logger transaction hash. The node process never needs the agent key. Ctrl-C in the node's terminal drains and stops it.

An alternate config uses explicit paths, for example:

    node -- node/production/scripts/local-node.mjs run --config /absolute/path/to/node.json --env-file /absolute/path/to/node.env

Underlying build/deployment commands used by the wrapper are:

    npm --prefix node/production ci
    git submodule update --init lib/forge-std
    forge build --root contracts --sizes
    forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --offline
    forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --broadcast --offline

Setup uses the host install shown above. The planned Forge invocations receive `LOGGER_CHAIN_ID`, `LOGGER_DEPLOYER_PK`, and selected Foundry RPC settings through the child environment. `--offline` prevents compiler downloads; it does not prevent RPC access. Build before deployment. The tooling must make the selected chain and deployer address visible without printing secrets.

Milestone 1 validation:

    npm --prefix node/production test
    git diff --check

Milestone 2 validation (the local fixture at this stage exercises deployment and reuse on isolated Anvil):

    npm --prefix node/production test
    forge build --root contracts --sizes
    npm --prefix node/production run test:local
    git diff --check

Final validation:

    npm --prefix node/production test
    forge build --root contracts --sizes
    npm --prefix node/production run test:local
    npm --prefix node/production run smoke:local
    git diff --check

No kernel or contract source changes are planned. If implementation actually requires such changes, record the reason and applicable additional checks before expanding scope. Dependency installation may require network access; tests that bind loopback sockets may require workspace escalation. No external-network broadcast is necessary for acceptance.

## Validation and Acceptance

Acceptance is an operator-visible flow from a prepared checkout to a foreground node receiving a separately signed local request and producing an actual Logger event. The RPC endpoint and expected chain come from configuration, independent of the loopback node address. The local integration fixture must exercise the public CLI rather than calling only internal helpers.

Setup must leave existing operator files untouched, use existing lockfiles, and avoid installing the legacy agent runner. Readiness checks and status must submit no transactions and publish no data. Correctly authenticated RPC/IPFS endpoints must work; wrong chain, missing bytecode, zero node balance, unreachable services, and missing secrets must yield useful sanitized failures. An already running listener or mismatched health identity must not be mistaken for a successful launch.

A deployment simulation must not alter the chain or configured Logger address. A successful broadcast must be verified before configuration changes. Reuse and ordinary node restarts must preserve the Logger address and signing identity without creating transactions. Failure or lost deployment receipts must not trigger automatic redeployment.

The local agent client must succeed when authorized and fail when unauthorized. Verify actual IPFS content and Logger event fields. Launch the wrapper directly with Node.js as documented, and send SIGINT/SIGTERM to that PID; it must preserve draining and leave no child node process behind. Status must accurately surface the existing uncertain-transaction state without restarting the node. Do not re-test every kernel invariant in the new CLI tests; retain the existing host suite and smoke for those behaviors.

## Idempotence and Recovery

Repeated setup may reinstall from lockfiles but never overwrites configured identities or endpoints. Checks and status are read-only. Logger reuse does not broadcast. Publishing a signed message remains an explicit operation that can create another event and spend gas if repeated.

Stopping the foreground runner does not stop supplied Ethereum/IPFS services or remove their data. Restart the Oya process explicitly after a clean drain. If a prior transaction or deployment has an unknown outcome, inspect its known hash and account state before restarting or retrying. This tooling neither reconciles transactions automatically nor restores application progress after a hard crash.

Retain the private configuration, environment, and public deployment receipt across ordinary process restarts. They describe how to run the node; they are not a publication journal. Restoring a stopped or reset Anvil chain is the operator/test fixture's responsibility. The same chain ID alone does not guarantee that an earlier Logger still exists, so startup must continue checking its code.

Source changes are reversible through normal review. Do not delete operator config, credentials, IPFS repositories, or blockchain data as part of setup, cleanup, or rollback. Test cleanup is limited to the processes and temporary resources owned by that test.

## Artifacts and Notes

This plan is grounded in the current checkout at `5817192`. The planning probes printed only boolean results for non-secret Foundry RPC configuration and confirmed that the working tree was clean before drafting. No application tests or deployments were run during planning.

The `/path/to/...` paths below are placeholders for temporary validation directories. Replace them with your own paths and create the parent directories before reproducing the checks.

Milestone 1a began from clean commit `beda816`. Setup validation used this command from the repository root:

    npm --prefix node/production run local -- setup --config /path/to/setup-validation/config.json --env-file /path/to/setup-validation/node.env

After adding the Node argument separator, it exited 0 after both locked installs, the kernel build, and template creation. Both files have mode `0600` and contain only example configuration and empty credential fields. No operator node configuration or signing credentials were used. The focused tests inject an installer to prove failure handling and file preservation without repeatedly reinstalling; a separate process test exercises the real npm entry and argument parsing. `npm --prefix node/production test` then passed all 23 tests (zero failures or skips), and `git diff --check` passed. Git status confirmed that no lockfiles or kernel build outputs changed. Stage 1a is ready for review; 1b has not started.

The release handoff was validated using Node 24.21.0 and npm 11.19.0 on `PATH`. The temporary validation copy contained only tracked production host files and the static `packages/ethereum/test/fixtures/logger-abi.json` fixture. From that copy's root:

    npm --prefix node/production run local -- setup --config /path/to/host-validation/operator/config.json --env-file /path/to/host-validation/operator/node.env
    npm --prefix node/production test

Setup exited 0 after one host install and created both matching templates with mode `0600`. All four installed kernel directories are real npm packages at `0.1.1`, not local links; neither TypeScript nor kernel implementation/build files exist in the copy. All 23 tests passed (zero failures or skips). The host lockfile still matches the reviewed working copy. The working checkout also completed `npm --prefix node/production ci --ignore-scripts --offline --no-audit --no-fund --cache=/path/to/npm-cache` using the same Node/npm versions and the populated validation cache. These checks used no operator credentials or Ethereum/IPFS services.

During implementation, record the exact commands and outcomes at each milestone. Final evidence should include the local node URL, chain ID, Logger address, deployment and publication hashes, agent/node public addresses, successful stop/restart checks, and confirmation that temporary services were stopped. Never include environment file contents, private keys, provider credentials, or signed raw transaction bytes in the plan.

Milestone 1b validation used Node 24.21.0 on `PATH`, from the repository root:

    npm --prefix node/production test
    git diff --check

All 39 tests passed with no failures or skips. The check fixture invokes the actual npm entry from another directory with relative paths, verifies file credentials override deliberately different inherited credentials, observes exactly three read-only Ethereum methods and one IPFS version request, and verifies both settings files retain their contents. A second invocation with the wrong chain exits 1 after the first request. Other tests cover inherited fallback, explicitly empty keys, missing files, invalid config, loopback restrictions, missing Logger, zero/malformed balance, RPC/IPFS failures, output redaction, and stalled RPC/IPFS bodies. Fixture-owned listeners and temporary settings are cleaned up. Validation used no Anvil transactions, IPFS uploads, or operator secrets; the existing background fork was left alone.

Milestone 1c used the same `npm --prefix node/production test` and `git diff --check` commands under Node 24.21.0 on macOS. All 62 tests passed with zero failures or skips. The actual CLI starts the existing node with selected file credentials over conflicting inherited values; npm status reports ready without contacting upstream services. Held signed requests report busy and survive SIGINT/SIGTERM until the fixture returns its final rejection and the child exits cleanly. The tests verify unavailable health after shutdown, unchanged settings files, supplied services left running, wrong-chain refusal before launch, occupied-port startup failure, child exit-code propagation, launch-error redaction, and signal-listener cleanup. Controlled health responses cover ready/busy, draining, uncertain outcomes, malformed data, each identity mismatch, IPv6 URL formatting, and bounded stalled connections/bodies. Every test-owned process/listener is cleaned up; no real-chain transaction or IPFS publication was performed.

## Interfaces and Dependencies

Operating helpers are `node/production/scripts/local-node.mjs`, `scripts/local-config.mjs`, `scripts/local-check.mjs`, `scripts/local-run.mjs`, and `scripts/local-status.mjs`, with corresponding local tests. Subsequent milestones add `scripts/test-local-operations.mjs`, package command entries, `.env.example`'s empty deployment-key setting, relevant README updates, and an ignore rule for local deployment metadata. Reuse `src/config.mjs`, `src/main.mjs`, `src/signer.mjs`, and `scripts/send-message.mjs`. Existing contracts remain in `contracts/`, and deployment is performed by `contracts/script/DeployLogger.s.sol`.

The release handoff additionally changes `node/production/package.json` and its lockfile to pin published kernels, with focused updates to setup, host tests/docs, and affected CI assumptions. This is the planned exception to retaining the existing lockfile; subsequent operating commands must use it without rewriting it.

Use Node built-ins for argument handling, process execution, filesystem operations, and environment parsing; reuse the existing kernel Ethereum calls and signer for read-only checks. Keep child-process invocation structured and environment-scoped. Retain ethers as already accepted; add no external npm dependencies and change no kernel interfaces. No agent-specific module, commitment verifier, proposal endpoint, supervisor, compatibility shim, or background process manager is introduced by this draft.
