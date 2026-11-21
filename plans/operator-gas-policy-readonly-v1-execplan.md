# Inspect configured gas policy offline

This bounded ExecPlan follows `PLANS.md` and implements the gas-inspection slice of [operator-experience milestone M5](node-operator-experience-execplan.md). A standalone interface lets operators inspect configuration independently of the profile/status work in PR #181.

## Purpose / Big Picture

Operators can run `node node/production/scripts/gas-policy.mjs --config FILE [--json]` on Node.js 24 to inspect configured per-transaction gas and fee ceilings without credentials or network access. Exact decimal output includes defaults versus overrides and the product in wei. This is a projection of mode and gas settings, not full runtime validation or evidence of what a running node loaded.

## Progress

- [x] 2026-11-16 00:38Z: Read guidance, roadmap and runtime/packaging paths. Selected independent standalone interface.
- [x] 2026-11-16: Extracted pure gas parsing and delivered bounded CLI, documentation and packaging.
- [x] 2026-11-16: Verified parser parity, hostile input, exact arithmetic, Node invocation through symlinks, offline dependency closure, direct/worker caps and worker/direct-batch checkpoint preservation.
- [x] 2026-11-16: Node 24 focused tests 103/103; full production tests 554/554; isolated Linux tests 85/85. Actual image imports passed. Diff and budget review complete.

## Surprises & Discoveries

Runtime gasLimit null selects its default; maxFeePerGasWei null is invalid. The fee parser accepts 78 digits, including values beyond uint256; downstream transaction preparation imposes a narrower bound. Preserve that behavior and describe the projection accurately. The runtime image uses an explicit `.dockerignore` allowlist.

The first full run had five release-coordinator failures because task-local fixture output was inside the checkout, which the existing release guard correctly rejects. The complete suite passed from an identical disposable source copy with fixture directories outside that copy, all inside the owned worktree. Initial new-test failures were an overly broad stack-trace regex matching “at most” and a preload guard denying the module loader’s public source reads; both test harness issues were corrected.

## Decision Log

- 2026-11-19 / Hermes: Share selection, not the status operation: gas inspection needs neither the worker target nor health transport. Both host dependency sets already ship in the same release bundle.

- 2026-11-16 / Hermes: Extract only gas defaults and validation, retaining configuration identity logic. Use a dependency-free module rather than copying unmerged profile/status code. This limits conflicts with the separate operator work.
- 2026-11-16 / Hermes: Read at most 64 KiB plus one overflow byte from an opened regular file with no-follow/nonblocking flags. Reject special files and sanitize errors. Output only enumerated public policy fields.

## Outcomes & Retrospective

Delivered the standalone command, shared runtime parser and public release assets. Focused macOS tests passed 103/103 on Node 24.22.2; full production tests passed 554/554, with no skips. Linux gas/worker/batch tests passed 85/85 on image Node 24.21.0 with networking disabled. Actual image imports of config, main, worker, processor and the gas module passed. The profile dispatch milestone is recorded below. Balance and monitoring remain separate. This slice exposes existing limits rather than introducing enforcement.

## Context and Orientation

`node/production/src/config.mjs` supplies gas limits to direct startup in `src/main.mjs` and durable worker processing in `src/inbox/processor.mjs`. The transaction preparer estimates before signing. A checkpoint is saved signed transaction bytes: lowering limits can block their validation and must never replace them. Default direct and worker transactions log one message; opt-in direct batching logs several messages in one transaction. Wei is the integer base unit of native currency.

## Plan of Work

First share pure parsing in `src/gas-policy.mjs`, preserving runtime accepted inputs and error behavior. Add `scripts/gas-policy.mjs` and `gas-policy.md`. Then extend existing runtime and publisher fixtures for policy parity, pre-sign cap failures, checkpoint preservation and dependency-free extracted execution. Add the module to the image allowlist and all three public assets to release packaging and upgrade allowlisting. Finish with actual local-image import validation and full regression tests.

## Concrete Steps

From repository root with Node.js 24 on PATH:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/gas-policy.test.mjs node/production/test/inbox-ledger.test.mjs node/production/test/batch-logging.test.mjs node/production/test/publish-image.test.mjs
    npm --prefix node/production test
    docker build -t oya-gas-policy:local node/production
    docker run --rm --network none --entrypoint node oya-gas-policy:local --input-type=module -e "await import('./src/config.mjs'); await import('./src/inbox/processor.mjs'); console.log('closure ok')"
    git diff --check

Tests use synthetic identities and mocked provider transports. Image validation is local only; no image publication or chain operations.

## Validation and Acceptance

Verify omitted/null/default/override/type/boundary parity against runtime parsing, exact large products, IPFS inapplicability, sanitized argument/file/JSON errors, regular-file bounds, Node invocation through a script symlink, and output with no secret fields. Exercise real CLI subprocesses. Existing publisher tests must extract the actual archive and run the tool without npm or checkout imports, and validate its upgrade allowlist. Direct and worker estimates above each cap must produce zero signatures/broadcasts. Lowered caps must preserve saved signed transactions and permit reconciliation after restoring the caps. Full production tests and actual image closure must pass. Count added/deleted code/test/config lines including untracked files against the 3000-line ceiling.

## Idempotence and Recovery

Inspection reads one selected config and writes only stdout/stderr. Repeating it is safe. Tests create and remove disposable fixtures. Remove only this task's local image if desired. There are no migrations, private configuration edits, or running-node changes to reverse.

## Artifacts and Notes

Public artifacts are the pure module, CLI, concise guide, tests and packaging edits. The final feature spans 13 files: 388 added and 14 deleted code/test/config lines (402 total), below the 3000-line ceiling. Private validation logs remain outside Git. The standalone command and all acceptance checks are complete; the next candidate is described below.

## Interfaces and Dependencies

The CLI accepts exactly `--config FILE` plus optional `--json`, or `--help`. Exit 0 means successful projection; exit 2 means invalid arguments, unreadable input or invalid projected settings. JSON schema version 1 contains scope, mode, applicable, decimal caps/product and origins. Node built-ins suffice. Runtime dependencies remain locked and unchanged.

## Profile integration milestone: operator-gas-policy-profile-v1

- [x] 2026-11-19 05:34Z: Confirmed that both host commands and their release assets are present in the selected base.
- [x] 2026-11-19 05:37Z: Shared the bounded profile reader and policy formatter, documented both entrypoints, and verified byte parity. On macOS with Node 24.22.3, 50/50 focused tests and 600/600 full production tests passed, including extracted direct/worker Ledger/IPFS profiles.

Select the installation with `operator-node.mjs gas-policy --profile FILE [--json]` (or `OYA_OPERATOR_PROFILE`). Validate the private v1 profile and read its node JSON once using the existing bounded reader. Validate the worker reference as a path without opening it: the policy belongs to the node config. Reuse `projectGasPolicy` and the standalone formatter. Status must continue checking its worker target and health independently of gas validity.

From repository root on Node 24, run `node --test node/production/test/{operator-node,gas-policy,publish-image}.test.mjs` and `npm --prefix node/production test`. Accept when both CLIs give byte-identical policy output, invalid inputs fail privately, and the actual extracted command works without npm, secret reads or health requests. No runtime or release format change is needed. Reverting the host changes rolls back the command without migrating private profiles.

## Balance snapshot milestone: operator-balance-snapshot-v1

- [x] 2026-11-21 UTC: Rechecked M5 after #199 merged and reused the profile loader for `balance`. Added bounded read-only RPC and host bundle coverage. All 670 production tests passed on Node 24.22.3 with a canonical temporary directory.

From the repository root run `node node/production/scripts/operator-node.mjs balance --profile FILE --json`. Select the node’s public address and explicit RPC URL. Check chain ID, read the current block number, then pass that number to the balance query. Decimal strings preserve exact wei and block numbers. Reject redirects and limit the whole observation to five seconds and each body to 64 KiB. Bind optional authorization in the private profile to the exact selected endpoint. The [operator guide](../node/production/operator-status.md#read-the-native-balance) describes exit codes and rollback compatibility.

Run `node --test node/production/test/{operator-balance,publish-image}.test.mjs` and `npm --prefix node/production test` after installing locked dependencies. Loopback tests distinguish zero from failure and check authentication boundaries, malformed or oversized replies, timeout, wrong chain and IPFS. Retry safely after correcting configuration or restoring RPC. No balance or RPC error state is persisted.

## Selected milestone — operator-monitor-once-v1

- [x] 2026-11-21 02:35Z: Recorded the operator action before coding. Run `node node/production/scripts/operator-node.mjs monitor-once --profile FILE [--json]` to see both observations even if one is unavailable. Today the operator must invoke `status` and `balance` separately through that dispatcher. Reuse their existing bounded host readers, not a new service.
- [x] 2026-11-21 02:38Z: Implemented separate health and balance projections from one private profile. On Node 24.22.3 the focused operator/bundle suite passed 47/47 and the full production suite passed 673/673 with no skips.

Capacity at selection: earliest gate verified 0/3; #212 is frontend only and #213 merged.

From the repository root run `node --test node/production/test/{operator-node,operator-balance,publish-image}.test.mjs` and `npm --prefix node/production test` with Node 24 and a canonical temporary directory. Worker config references and RPC binding must be validated within their respective checks: a bad reference must not discard a valid sibling observation. Shared identity or private profile failures still stop both. Both human and JSON output use only the public observation fields. Direct/worker fake endpoints cover partial failures and exact balance; extracted bundles cover both roles, IPFS and missing RPC configuration. Re-run safely or revert the dispatcher changes; no profile migration is needed.

## Next bounded candidate — operator-balance-floor-v1

Let an operator optionally pass a minimum balance in decimal wei to `monitor-once`. Distinguish below-floor from unknown without calling zero or a missing observation healthy. Scope: host dispatcher, operator guide, operator and extracted-bundle tests. Estimate 80–160 changed code/test lines. Accept when below/equal/above comparisons are exact above JavaScript’s safe integer range, malformed thresholds fail before network access, absent thresholds retain current behavior, IPFS stays inapplicable, and a balance warning never suppresses health. Use a bounded unsigned integer; keep the comparison local, with no extra requests, credential access, state or notification delivery. This is a proposed follow-up, not an implemented flag.
