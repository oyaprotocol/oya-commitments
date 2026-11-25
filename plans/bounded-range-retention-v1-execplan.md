# Retain verified bytes from one Ledger range

Maintain this single-milestone plan according to `PLANS.md`.

## Purpose / Big Picture

Operator action: choose two mined block numbers, a verifier settings file, and an existing private history directory. Result: retain exact bytes named by their content identifier (CID), and see which transaction/log positions still need attention. Existing path: `discover-ledger.mjs` lists positions, then `verify-ledger.mjs --save` requires a separate input per position and refuses existing destinations. Neither alone retries a mixed range. Dialogue Q022, Q024 and Q030 motivate historical retrieval; retention here is a local observation, not a fee or finality decision.

## Progress

- [x] 2026-11-25 03:33Z: Checked the pinned base, related branches, existing discovery, single-record save and offline check. Recorded operator action before implementation.
- [x] 2026-11-25 03:37Z: Implemented retention and exercised partial success, retry, conflicting bytes and bounded rejection. On Node 26.12.1, 77/77 focused and 696/696 production tests passed, with no skips.

- [x] 2026-11-25 04:36Z: Resolved the #245 test overlap and repeated focused (77/77) and production (696/696) validation on Node 26.12.1, with no skips.

## Surprises & Discoveries

The first overlap check against #245 conflicted only in the imports of `node/production/test/ledger-evidence.test.mjs`. The range test needs the existing child-process fixture, not a separate `execFile` import.

A candidate from discovery contains no CID. A retry must authenticate the receipt and its block again before trusting a saved file.

## Decision Log

- 2026-11-25 / Hermes: Use an explicit rerun, not a queue or progress file. A fresh scan and local digest check tolerate interruption and avoid trusting stale names after a chain reorganization.

- 2026-11-25 / Hermes: Share the existing bounded subprocess runner between the verifier and range tests. Keep verifier-specific arguments in `cli` and keep the loopback fixture in one file.

## Outcomes & Retrospective

The loopback CLI recovered a missing file without another content request for its neighbor. Reusing the single-record fixture avoided duplicating the Ethereum receipt and binary CID setup. The shared runner now gives both commands the same timeout and restricted test environment.

## Context and Orientation

Under `node/production/src`, `discover-ledger.mjs` asks the selected Ethereum RPC (chain data service) for logs emitted by the Ledger contract. `ledger-evidence.mjs` authenticates a candidate against its receipt, canonical block and raw CID digest. The verifier already bounds each request and response. `verify-ledger.mjs` writes verified bytes by hard link without replacing files.

## Plan of Work

Add `retain-range.mjs` and a command guide. Reuse discovery, stop verification before remote content retrieval for an authenticated local copy, and share the existing save operation. Test through a loopback chain and content service. Package the command alongside discovery.

## Concrete Steps

From the repository root run `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`, `node --test node/production/test/ledger-evidence.test.mjs`, and `npm --prefix node/production test`. Run `git diff --cached --check` and inspect the complete staged change before committing.

## Validation and Acceptance

Check compatibility from the repository root with `git merge-tree --write-tree HEAD 1132e8671ab0e40226abcb822d3bbe290bc95447`. A clean merge prints only the tree ID and exits zero. On macOS the first full run passed 695/696: the gas-policy symlink test denied access to a system temporary-directory alias. Rerunning with `TMPDIR` set to an existing private, non-symlinked directory passed 696/696.

A mixed run must save good bytes and report the missing position. An explicit retry must fill the gap without downloading the first copy again. Wrong bytes, out-of-range receipts and conflicting local entries must never become successful writes. A dense range must fail before partial processing.

## Idempotence and Recovery

Use the same range and directory to retry. Preserve conflicting files for manual inspection. Only trust a directory whose contents and parent path are controlled by the operator. A crash may leave a private `.ledger-save-` temporary file; inspect abandoned temporary files when no writer is active.

## Artifacts and Notes

Use `node node/production/src/retain-range.mjs FROM TO SETTINGS DIRECTORY` from the root. Exit zero means every returned candidate was retained or checked locally, including an empty result.

## Interfaces and Dependencies

Reuse production Node dependencies and operator-selected RPC and Kubo (IPFS content service) settings. No signing identity is needed. Validation uses only synthetic loopback fixtures and temporary files.

## Next feature candidate

An operator catching up on a block with more than 32 candidate logs could retain a selected subset without preparing a separate verifier input for each log. First exercise discovery and `verify-ledger.mjs --save` on a loopback block with 33 small logs. If the existing workflow suffices, document it instead of adding a command option. Otherwise, prototype selection by explicit transaction hash and log index. Accept it only if two selected records can be retained and retried, no unselected content is fetched, and a position that moved out of the chosen block is rejected. Keep the 32-record processing cap and the discovery response-size limit.
