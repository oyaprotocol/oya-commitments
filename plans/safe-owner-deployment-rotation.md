# Safe Owner Deployment and Rotation

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

The commitment deployment flow should stop forcing every Safe into a dead-owner state immediately after deployment. Instead, operators should be able to choose the final Safe owners from the command line:

- no explicit owners: keep the deployer as the sole owner for a testing phase
- `0x`: finish with the dead address as the sole owner, matching the current "no human owners" posture
- multiple owners: finish with those owners and an `N/N` threshold so unanimous owner approval can bypass the Optimistic Governor flow

After this change, an operator should be able to deploy a commitment with a single command, inspect the final owner set onchain, and later use command-line scripts to add owners, remove owners, or rotate to the dead-owner posture while the deployer still has unilateral Safe control.

Observable success looks like:

1. A deployment command with no owner flag leaves the deployer as the only Safe owner.
2. A deployment command with `--owners 0x` leaves the Safe owned only by `0x000000000000000000000000000000000000dEaD`.
3. A deployment command with `--owners <a>,<b>,<c>` leaves the Safe owned by exactly those addresses with threshold `3`.
4. Follow-up owner-management commands can add or remove owners from the command line while the deployer is still the acting owner.
5. Repository docs explain the new default testing posture and how to later rotate ownership.

## Progress

- [x] 2026-03-30 03:33Z: Audited `script/DeploySafeWithOptimisticGovernor.s.sol`, `test/DeploySafeWithOptimisticGovernor.t.sol`, `docs/deployment.md`, `README.md`, `agent/README.md`, and `agent/scripts/lib/testnet-harness-deploy.mjs`.
- [x] 2026-03-30 04:12Z: Added shared Safe owner helpers in `script/SafeOwnerUtils.sol`, replaced unconditional burn-owner finalization in `script/DeploySafeWithOptimisticGovernor.s.sol`, and added standalone owner-management logic in `script/ManageSafeOwners.s.sol`.
- [x] 2026-03-30 04:12Z: Added `script/deploy-commitment.sh`, `script/set-safe-owners.sh`, `script/add-safe-owners.sh`, and `script/remove-safe-owners.sh`.
- [x] 2026-03-30 04:12Z: Extended deployment and owner-management tests in `test/DeploySafeWithOptimisticGovernor.t.sol` and `test/ManageSafeOwners.t.sol`; updated harness config parsing and phase-3 coverage in `agent/scripts/lib/testnet-harness-deploy.mjs` and `agent/scripts/test-testnet-harness-phase3.mjs`.
- [x] 2026-03-30 04:12Z: Updated `README.md`, `docs/deployment.md`, `docs/signers.md`, and `agent/README.md` to document the new owner flow and wrapper CLI.
- [x] 2026-03-30 04:12Z: Ran compile, targeted Foundry tests, harness phase-3 validation, and wrapper `--help` smoke checks.
- [x] 2026-03-30 04:33Z: Fixed the signer-removal ordering bug in `script/SafeOwnerUtils.sol`, upgraded mocks to validate the signing owner, added a regression test in `test/ManageSafeOwners.t.sol`, and re-ran the deployment, owner-management, and harness validations.
- [x] 2026-03-30 05:07Z: Added explicit deployment coverage for `SAFE_OWNERS=<ownerA>,<deployer>,<ownerB>` to confirm the signer is handled by membership rather than position in the requested owner list.
- [x] 2026-03-30 05:19Z: Scrubbed inherited `SAFE_OWNERS` from harness-triggered Forge deployments when `harness.deployment.owners` is unset, and added a phase-3 regression that contaminates the parent env to verify deployer-only default ownership is preserved.
- [x] 2026-03-30 05:42Z: Refactored the Forge deployment and owner-management scripts to expose parameterized entrypoints for tests, removed `vm.setEnv` dependencies from the new Safe-owner Forge suites, and verified the full Forge suite passes without `--isolate`.
- [x] 2026-03-30 05:57Z: Hardened harness owner-config parsing to reject explicit empty owner lists, and reordered wrapper CLI Forge argument assembly so the script path cannot be displaced by forwarded args.

## Surprises & Discoveries

- Observation: The deployment docs already mention `SAFE_OWNERS` and `SAFE_THRESHOLD`, but the current Solidity deployment script ignores both and always deploys with `[deployer]`, threshold `1`, then burns the deployer owner.
  Evidence: `docs/deployment.md` lists those variables, while `script/DeploySafeWithOptimisticGovernor.s.sol` hard-codes `owners[0] = deployer`, `threshold = 1`, and always calls `burnOwner(...)`.

- Observation: Finalizing directly to a multi-owner `N/N` Safe is not possible in the current one-key deployment transaction sequence because enabling the Optimistic Governor module requires a valid Safe owner signature.
  Evidence: `enableModule(...)` signs the Safe transaction with `DEPLOYER_PK` only. A Safe initialized directly with non-deployer owners or with threshold `N > 1` would not accept that single deployer signature.

- Observation: The safe way to support all requested end states is to bootstrap with the deployer as temporary sole owner, enable the module, then reconcile the owner set to the requested final state.
  Evidence: The current burn-owner flow already uses this pattern for the `0x` posture by adding the burn owner and removing the deployer after module enablement.

- Observation: The testnet harness deploy helper shells out to the same Foundry deployment script, so deployment semantics will change there too and should be kept aligned.
  Evidence: `agent/scripts/lib/testnet-harness-deploy.mjs` calls `forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor` with env vars.

- Observation: Forge suites that mutate env vars with `vm.setEnv` need isolated execution in this repo or the env-dependent tests can interfere with one another.
  Evidence: `forge test --offline --match-path test/DeploySafeWithOptimisticGovernor.t.sol` and `forge test --offline --match-path test/ManageSafeOwners.t.sol` were flaky until re-run with `--isolate --threads 1`.

- Observation: Removing the signer before other non-desired owners leaves no valid signer for later Safe mutations, and separate broadcast transactions can strand the Safe in a partially reconciled state.
  Evidence: The initial reconciliation loop in `script/SafeOwnerUtils.sol` removed the first non-desired owner it encountered; the fix now prunes other owners first and removes the signer last, with `test_RemoveOwnersRemovesSignerLast` covering the regression.

- Observation: The requested owner list order is not used as a canonical final ordering; reconciliation treats the signer and other requested owners by membership, then validates count and membership after mutation.
  Evidence: `reconcileOwners(...)` uses `_containsOwner(...)` checks rather than positional comparisons, and `test_DeploysSafeWhenDeployerIsSpecifiedMidList` passes with `SAFE_OWNERS=<ownerA>,<deployer>,<ownerB>`.

- Observation: The harness deployment helper inherited ambient `SAFE_OWNERS` from the parent process unless `harness.deployment.owners` was explicitly set, which could silently override the intended deployer-only default.
  Evidence: `deployHarnessCommitment(...)` built the Forge env from `...env` and only conditionally overrode `SAFE_OWNERS`; the fix now deletes inherited `SAFE_OWNERS` when `effectiveConfig.owners` is `undefined`, and the phase-3 harness test passes with a contaminated parent env.

- Observation: Forge tests that mutate env with `vm.setEnv` can still race under the normal `forge test` runner even if targeted `--isolate --threads 1` invocations pass, because env state is process-global and shared across concurrently executed tests.
  Evidence: the initial Safe-owner test suites passed in isolated runs but failed under plain `forge test -vvv` with cross-test contamination of `SAFE_OWNERS` and `SAFE_REMOVE_OWNERS`; refactoring those tests to use parameterized script entrypoints eliminated the failures.

- Observation: An explicit empty `harness.deployment.owners` value is dangerous because it can collapse to the same deployer-owned default as "owners omitted", even though those meanings are operationally different.
  Evidence: `parseOwnersConfig([])` previously returned `""`, which the Solidity deployment script treated as unset ownership; the parser now rejects empty arrays and blank strings, and phase-3 harness coverage asserts those misconfigurations throw.

- Observation: The wrapper shell scripts must anchor the target script path before caller-forwarded args or a forwarded positional token can be parsed as `<PATH>` by `forge script`.
  Evidence: the wrappers previously assembled `forge script <extra args> <path>`; they now assemble `forge script <path> ...`, preserving the script target while still forwarding caller args and wrapper-injected flags.

## Decision Log

- Decision: Use a bootstrap-then-reconcile owner flow in the Solidity deployment script instead of initializing the Safe directly to the requested final owner set.
  Rationale: This is the only approach that supports all three requested modes while still allowing the deployment process to enable the Optimistic Governor module using the deployer's key.
  Date/Author: 2026-03-29 / Codex.

- Decision: Expose `--owners` through a wrapper CLI and keep the Solidity script driven by environment variables under the hood.
  Rationale: Foundry scripts do not naturally expose named flags like `--owners`; a wrapper script gives the requested UX while preserving a simple Foundry implementation and backwards-compatible env-driven automation paths.
  Date/Author: 2026-03-29 / Codex.

- Decision: Derive the final Safe threshold from the requested owner count (`1/1` or `N/N`) instead of supporting arbitrary thresholds in the new standard flow.
  Rationale: The user requirement is explicit that multi-owner deployments should require all owners to sign. Allowing a separate threshold input would create ambiguity and conflicts with that rule.
  Date/Author: 2026-03-29 / Codex.

## Outcomes & Retrospective

Implemented the owner-bootstrap and reconciliation flow as planned. The deployment script now always starts from deployer-only Safe control, enables the Optimistic Governor, and then reconciles the Safe to the requested final owner set with threshold equal to owner count.

Added a reusable owner-management primitive in `script/ManageSafeOwners.s.sol`, plus wrapper commands for deployment, set, add, and remove flows. The docs now present the deployer-owned testing posture as the default and document the handoff to dead-owner or unanimous multi-owner control.

The main operational lesson is that owner-management commands using only `DEPLOYER_PK` are intentionally limited to the threshold-1 transition phase. Once operators finalize to a non-deployer `N/N` Safe, future owner changes must go through the owners themselves or the Optimistic Governor process.

Follow-up hardening fixed a bug where the signer could be removed before other non-desired owners. The reconciliation helper now removes all other prunable owners first, then removes the signer last while applying the final threshold in that same removal transaction when necessary.

## Context and Orientation

The main deployment logic lives in `script/DeploySafeWithOptimisticGovernor.s.sol`. Today it:

1. reads deployment config from env
2. deploys a Safe with the deployer as sole owner
3. deploys an Optimistic Governor module owned by that Safe
4. enables the module via a Safe transaction signed by the deployer
5. adds the burn owner and removes the deployer

The deployment behavior is covered by `test/DeploySafeWithOptimisticGovernor.t.sol`, which currently verifies only the burn-owner final state.

User-facing deployment docs live in `README.md`, `docs/deployment.md`, and `docs/signers.md`. The docs currently describe direct `forge script` usage and contain stale references to `SAFE_OWNERS` / `SAFE_THRESHOLD`.

The offchain harness deploy path lives in `agent/scripts/lib/testnet-harness-deploy.mjs`. It currently forwards deployment config to the same Foundry script via env vars and is exercised by `agent/scripts/test-testnet-harness-phase3.mjs` and related harness tests.

Post-deploy owner management does not currently exist as a first-class command-line workflow in this repository. New operator scripts will likely live under `script/` beside the existing Foundry scripts and wrapper shells.

## Plan of Work

First, update the Solidity deployment script so it accepts a requested final owner list from env, normalizes the special `0x` value to the burn address, always bootstraps with the deployer as temporary sole owner, enables the Optimistic Governor module, and then reconciles the Safe to the requested final owner set and threshold.

Second, add a user-facing deployment wrapper in `script/` that exposes `--owners` as the canonical CLI. The wrapper should parse comma-separated owners, accept `0x` as the dead-owner sentinel, source an optional `ENV_FILE` the same way existing wrappers do, and map the parsed result into the env expected by the Foundry deployment script.

Third, add post-deploy owner-management commands. The safest shape is one core owner-rotation implementation that can reconcile the Safe from the current deployer-controlled state to a requested final owner list, plus user-friendly add/remove entry points if needed. The implementation must be explicit that deployer-only operation is supported only while the deployer remains able to satisfy the Safe threshold on its own.

Fourth, extend Foundry tests and harness tests so the new owner semantics are covered. This includes the default deployer-owner path, the dead-owner path, multi-owner `N/N` finalization, and at least one post-deploy owner-management flow.

Fifth, update docs so the canonical deployment path uses the new wrapper, explains the new default testing posture, documents `--owners`, documents how `0x` maps to the dead-owner posture, and explains how to add owners or remove all human owners later.

## Concrete Steps

1. Update `script/DeploySafeWithOptimisticGovernor.s.sol`.

   - Add parsing for a requested final owner list from env, for example `SAFE_OWNERS`.
   - Normalize input modes:
     - unset / empty: final owners = `[deployer]`
     - literal `0x`: final owners = `[BURN_OWNER]`
     - comma-separated addresses: final owners = normalized address list
   - Remove the unconditional `burnOwner(...)` call.
   - Replace it with a generalized reconciliation step that:
     - keeps bootstrap ownership as `[deployer]`, threshold `1`
     - enables the module
     - if final owners differ from `[deployer]`, adds requested owners with Safe owner-management calls
     - sets final threshold to `finalOwners.length`
     - removes the deployer when the final owner set should not include it
   - Preserve the existing burn-owner behavior only when the requested final owner mode is `0x`.

2. Add operator scripts under `script/`.

   Candidate file set:

   - `script/deploy-commitment.sh`: wrapper exposing `--owners`
   - `script/ManageSafeOwners.s.sol`: core Foundry script that reconciles a Safe to a requested final owner list using `DEPLOYER_PK`
   - thin wrappers `script/set-safe-owners.sh`, `script/add-safe-owners.sh`, and `script/remove-safe-owners.sh`

   Wrapper behavior:

   - support `ENV_FILE`
   - read `RPC_URL` (or documented fallback)
   - require `DEPLOYER_PK`
   - parse `--owners=<csv-or-0x>`
   - pass through extra Forge flags where safe
   - print concise usage on `--help`

3. Update tests.

   Foundry:

   - extend `test/DeploySafeWithOptimisticGovernor.t.sol` to assert:
     - default final owner is deployer
     - `SAFE_OWNERS=0x` final owner is burn owner
     - `SAFE_OWNERS=<a>,<b>` final owners are exactly those addresses with threshold `2`
   - add a focused test file for the new owner-management script(s), using mocks similar to the current Safe mock

   Node / harness:

   - update `agent/scripts/lib/testnet-harness-deploy.mjs` if harness config should be able to pass requested owners through env
   - add or extend harness tests, most likely `agent/scripts/test-testnet-harness-phase3.mjs`, to assert the default deployer-owner behavior and any new config passthrough

4. Update docs.

   - `README.md`: switch the quick-start deployment command to the new wrapper and mention the default deployer-owner testing posture
   - `docs/deployment.md`: make `--owners` the canonical deployment option, remove or correct stale `SAFE_THRESHOLD` language, and document post-deploy owner rotation
   - `docs/signers.md`: show wrapper usage with `agent/with-signer.mjs`
   - `agent/README.md`: update any examples that still show the raw direct deployment command if the wrapper becomes the standard path

5. Validate.

   From repo root:

   - `forge fmt`
   - `forge build --offline`
   - `forge test --offline --isolate --threads 1 --match-path test/DeploySafeWithOptimisticGovernor.t.sol`
   - `forge test --offline --isolate --threads 1 --match-path test/ManageSafeOwners.t.sol`
   - `node agent/scripts/test-testnet-harness-phase3.mjs`

   If wrapper scripts are added:

   - run their `--help` output manually
   - dry-run at least one wrapper invocation against Anvil or an existing local harness profile

## Validation and Acceptance

Acceptance requires all of the following:

- deployment with no explicit owners finishes with the deployer as the sole Safe owner
- deployment with `--owners 0x` finishes with the burn address as the sole Safe owner
- deployment with multiple owners finishes with threshold equal to the number of owners
- the Optimistic Governor module is still enabled successfully in every deployment mode
- a post-deploy owner-management command can add or remove owners while the deployer still controls the Safe
- documentation examples and operator instructions match the implemented CLI

Validation evidence should include:

- passing Foundry tests for deployment and owner rotation
- passing relevant harness deployment tests if harness config is touched
- one documented example command for each owner mode

## Idempotence and Recovery

Deployment itself is not idempotent on the same salt nonce, so the plan must preserve existing guidance about unique `SAFE_SALT_NONCE` and `OG_SALT_NONCE` values. Re-running a failed deployment on the same chain may require new salt values if any contract was already created.

Owner-management scripts must be written to fail before broadcasting when input is invalid, for example malformed addresses, duplicate owners, or attempts to produce an impossible final state. The docs should clearly state that deployer-only owner-management commands are intended for the period where the deployer is still able to meet the Safe threshold alone.

If an operator has already rotated the Safe to a multi-owner `N/N` state that excludes the deployer, future owner changes can no longer be completed with only `DEPLOYER_PK`; the recovery path is to execute the owner change through the Safe itself with all required owner signatures or through the Optimistic Governor path.

## Artifacts and Notes

Useful current-file references:

- deployment script: `script/DeploySafeWithOptimisticGovernor.s.sol`
- shared owner helpers: `script/SafeOwnerUtils.sol`
- standalone owner-management script: `script/ManageSafeOwners.s.sol`
- wrapper CLIs: `script/deploy-commitment.sh`, `script/set-safe-owners.sh`, `script/add-safe-owners.sh`, `script/remove-safe-owners.sh`
- deployment test: `test/DeploySafeWithOptimisticGovernor.t.sol`
- owner-management test: `test/ManageSafeOwners.t.sol`
- deployment docs: `docs/deployment.md`
- top-level quick start: `README.md`
- signer docs: `docs/signers.md`
- harness deploy helper: `agent/scripts/lib/testnet-harness-deploy.mjs`
- harness deployment integration test: `agent/scripts/test-testnet-harness-phase3.mjs`

Validation evidence captured during implementation:

- `forge build --offline`
- `forge test --offline --isolate --threads 1 --match-path test/DeploySafeWithOptimisticGovernor.t.sol`
- `forge test --offline --isolate --threads 1 --match-path test/ManageSafeOwners.t.sol`
- `node agent/scripts/test-testnet-harness-phase3.mjs`
- `bash script/deploy-commitment.sh --help`
- `bash script/set-safe-owners.sh --help`
- `bash script/add-safe-owners.sh --help`
- `bash script/remove-safe-owners.sh --help`
- `forge test --offline -vvv`

## Interfaces and Dependencies

Primary contracts and scripts:

- `DeploySafeWithOptimisticGovernor` in `script/DeploySafeWithOptimisticGovernor.s.sol`
- Safe owner-management calls such as `addOwnerWithThreshold(...)` and `removeOwner(...)`
- any new Foundry owner-rotation script added under `script/`

Primary documentation surfaces:

- `README.md`
- `docs/deployment.md`
- `docs/signers.md`
- `agent/README.md`

Primary validation surfaces:

- `test/DeploySafeWithOptimisticGovernor.t.sol`
- any new owner-management test file under `test/`
- `agent/scripts/test-testnet-harness-phase3.mjs`

Likely environment variables and CLI inputs:

- `DEPLOYER_PK`
- `RPC_URL` / network-specific RPC env vars used by wrappers
- `OG_COLLATERAL`
- `OG_BOND_AMOUNT`
- `OG_RULES`
- `SAFE_OWNERS` as the internal env passed to Foundry
- `--owners` as the user-facing wrapper flag
