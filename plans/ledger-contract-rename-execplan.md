# Rename the logging contract to Ledger

This ExecPlan follows `PLANS.md`. The user authorized a consistent rename across the contract, deployment tooling, node runtime, and hardened kernels. Docker implementation is paused. Keep this a naming migration with focused validation.

## Purpose / Big Picture

Operators and package consumers should use Ledger terminology for the onchain contract everywhere in the maintained interface. Preserve the existing `log(string)` function and `Log(address,bytes32,string)` event, including indexed fields, calldata, topics, and logging behavior. Existing deployed contracts remain usable at the same addresses.

## Progress

- [x] 2026-09-14: Audited tracked references, package consumption, contract ABI, and area instructions from a clean working tree.
- [x] 2026-09-14: Renamed contract/deployment interfaces, kernel exports/options, node configuration/results, tests, maintained docs, and Docker-plan references. Preserved generic logging callbacks and old private-artifact ignore protection.
- [x] 2026-09-14: Rebuilt tracked kernel output; passed identical-ABI, contract, gas, kernel runtime/type, packed-consumer, 89 node tests, full local operations, and smoke validation.
- [x] 2026-09-14: Prepared three publication directories that reproduce the reviewed archives exactly, and node registry pins using those archive integrity hashes. Confirmed no external dependency changes.
- [x] 2026-09-14 13:33Z: User authorized publishing Ethereum/messages 0.2.0 and IPFS 0.1.2. Rechecked reviewed archive hashes and publication files against the current checkout.
- [x] 2026-09-14: Renewed npm browser authentication and published Ethereum 0.2.0 from its reviewed directory.
- [x] 2026-09-14: Published IPFS 0.1.2 and messages 0.2.0 from their reviewed directories.
- [x] 2026-09-14: Verified registry archive hashes, clean metadata, package contents, dependency graph, imports, and declarations with an independent consumer. Installed the node from its registry lockfile and passed all 89 host tests. Updated maintained release-status docs; Docker implementation remains paused.

## Surprises & Discoveries

The production node previously installed Ethereum/messages 0.1.2 from npm. Renaming their public exports and options requires a coordinated release before a fresh registry installation can use the changed node. Package build output is tracked and was regenerated. Unrelated `logger` parameters in the older agent code mean console logging and are outside this contract rename.

The first isolated full-flow attempt failed because a symlinked Foundry dependency resolved outside Solidity's allowed source directories. Copying that existing dependency into the temporary checkout fixed the fixture; the full flow then passed. No application change was needed. Old `LOGGER_*` values remain excluded from child-process environments, and old artifact directories remain ignored, to preserve credential protection during migration.

The first publication attempt returned npm `E404` without an authentication link; `npm whoami` then returned `E401`, and the exact new version was absent. A fresh browser login restored authentication, and the retried publication supplied the separate browser 2FA challenge and succeeded.

npm accepted IPFS 0.1.2 with a notice that processing could take a few minutes. The initial registry verification returned `E404` for that version while it was processing. After the version became available, registry verification passed without republishing.

## Decision Log

- 2026-09-14 / user: Rename Logger to Ledger while retaining the logging function and event.
- 2026-09-14 / Codex: Rename contract-specific interfaces, including `loggerContract` to `ledgerContract`, `logger` publication options to `ledger`, and `deploy-logger` to `deploy-ledger`. Keep `logCid`, `LogCidError`, `publishAndLogSignedMessage`, and result fields describing the logging operation.
- 2026-09-14 / Codex: Prepare Ethereum/messages 0.2.0 together for the renamed public API, plus IPFS 0.1.2 for its updated Ledger documentation. Keep one Ethereum instance and all external dependency versions unchanged. Validate packed packages locally before any publication request. Publishing new versions is a separate final action requiring user authorization.
- 2026-09-14 / Codex: Update maintained docs and the Docker plan. Preserve historical execution records under their existing filenames; they describe earlier releases and tooling. Leave private operator configuration untouched and document the required key renames.
- 2026-09-14 / user: Publish the three prepared releases and finish registry adoption in the node.

## Outcomes & Retrospective

The source rename is implemented and validated under Node 24.21.0. Ledger's ABI is identical to the previous contract; all eight contract tests, seven unchanged deterministic gas checks, 207 kernel tests, both strict type checks, and the independent packed-consumer test pass. All 89 node tests pass against the packed releases. The full local operations test passed in 12.7 seconds, including deployment/reuse, exact IPFS retrieval, receipt/event checks, and restart. The separate smoke passed pending-transaction/busy handling and duplicate logging checks.

Ethereum/messages 0.2.0 and IPFS 0.1.2 are published on npm. Registry-mode release validation passed against the reviewed inventory, including exact archive integrity, package contents, clean metadata, dependency versions, imports, and TypeScript declarations. A fresh node installation from its existing registry lockfile succeeded, followed by all 89 host tests under Node 24. No runtime code or dependency pins needed further changes. The Ledger migration is complete; Docker implementation remains paused.

npm authentication was renewed locally; no credentials were included in release artifacts, and all contract broadcasts targeted disposable Anvil chains. The full local-flow and smoke evidence above used the same reviewed package bytes before publication.

## Context and Orientation

`contracts/src/Ledger.sol`, `contracts/test/Ledger.t.sol`, and `contracts/script/DeployLedger.s.sol` own the renamed onchain implementation, tests, and Foundry deployer. `packages/ethereum/src/ledger.ts` owns ABI helpers and CID submission; `packages/messages/src/handlers/publish-and-log.ts` composes publication and logging. Their package-root exports and tracked `dist/` output are consumed by `node/production/`.

The local node CLI owns configuration, checks, deployment/reuse, and lifecycle. The configured contract address appears as `ledgerContract` in JSON settings, health/publication responses, and deployment records. Deployment uses `LEDGER_CHAIN_ID` and `LEDGER_DEPLOYER_PK`. Node and agent signing-key variables remain unchanged.

## Plan of Work

Rename Solidity files/classes and contract-specific kernel source, fixtures, tests, exports, options, and documentation. Update node CLI actions, env templates, config fields, metadata, artifact directory prefixes, and status/error messages. Retain the existing ABI and console log callbacks. Update the ignore rule for deployment artifacts while retaining protection for already-created private artifacts.

Rebuild kernels, remove obsolete generated logger module files, and run existing behavior/type tests. Validate independent packed consumers and the renamed node against those packages. Before adopting registry pins, prepare the concrete release artifacts and request publication authorization; do not commit temporary installation paths or claim unpublished packages are available.

## Concrete Steps

From the repository root, using Node 24 for JavaScript validation:

```sh
forge fmt --root contracts
forge build --root contracts --sizes
forge test --root contracts --offline -vv
forge inspect --root contracts --offline Ledger abi --json
npm --prefix packages run build
node --test packages/utils/test/*.test.js packages/ethereum/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
node packages/node_modules/typescript/bin/tsc -p packages/ethereum/tsconfig.type-test.json
node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json
npm --prefix packages run test:release
npm --prefix node/production test
npm --prefix node/production run test:local -- --verbose
npm --prefix node/production run smoke:local
git diff --check
```

Run `forge snapshot --offline --no-match-test testFuzz --check` from `contracts/`, where the snapshot file lives. The node tests must use the renamed kernel packages, initially as reviewed archives in an isolated checkout with the same repository-relative layout. The full local flow generates its own keys, Anvil chain, offline Kubo repository, and temporary configuration. Its Ledger deployer uses only generated `LEDGER_DEPLOYER_PK` and chain 31337; no operator credentials or existing services are required.

## Validation and Acceptance

The Ledger ABI must equal the original ABI, including case-sensitive `log` and `Log` names. Existing contract behavior and gas checks, kernel runtime/type tests, and packed consumer checks must pass. Node tests must verify `ledgerContract` in configuration, health, publication, deployment metadata, and CLI output. The disposable full flow must deploy/reuse Ledger, publish and retrieve signed content, verify its event, and restart with the same identity. Search maintained sources for stale contract-specific naming while allowing historical records and ordinary logging callbacks.

## Idempotence and Recovery

This rename does not require redeploying an existing contract. Operators rename config and deployment-record fields from `loggerContract` to `ledgerContract`, deployer env keys from `LOGGER_*` to `LEDGER_*`, and CLI use from `deploy-logger` to `deploy-ledger`. Do not rewrite private files or delete old deployment artifacts automatically. Keep their ignore protection. Builds and isolated tests are repeatable; preserve existing published versions and obtain authorization before publishing new ones.

## Artifacts and Notes

Record only public validation results and package integrity hashes. Temporary archive/fixture locations stay outside tracked documentation. The original ABI contains only nonpayable `log(string cid)` and `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)`.

The retained archive and registry inventories both report validation passed. The published archives match the reviewed hashes below, and their public metadata contains no `_from` or `_resolved` fields:

| Package | Published archive integrity |
| --- | --- |
| `@oyaprotocol/ethereum@0.2.0` | `sha512-r6/1XiAL8Hsza7xxTrw8uP67Iv+Lktc+TCeABg6QTLnnL2twuA5RlBxTwEFQgXeQhGhKwt0OYm0SAXBDJuBxGw==` |
| `@oyaprotocol/ipfs@0.1.2` | `sha512-5eA3jrk7gkldw4A8k6zUw1gaRyUJl6hfzeXGUsewAljN9wpJwCzQzbQAErwzqxCDGkeNQgCdgGVVgkO0ih+OMw==` |
| `@oyaprotocol/messages@0.2.0` | `sha512-EulkYRoThH/BF3hbi+BU8c/Qw51aFRSWsyGV3Evrn945hRD6aQa/+miLS23o+hc6h2AyhhBlYJF2cvXRP5jJjQ==` |

Publication followed the existing release workflow in `packages/README.md`: publish from the prepared package directories, Ethereum and IPFS before messages, then run registry-mode `test:release` against the reviewed inventory. The registry check and a fresh `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund` passed, followed by `npm --prefix node/production test` (89 passing tests). No local paths were introduced into committed dependency metadata.

## Interfaces and Dependencies

New contract-specific names include `Ledger`, `DeployLedger`, `encodeLedgerCall`, `decodeLedgerEvent`, `hashLedgerCid`, `LedgerEvent`, `LedgerEventInput`, `ledgerContract`, and the `ledger` publication option. Preserve all logging operation names, signatures, returned logging data, package names, and external dependencies. Ethereum and messages must use matching versions to preserve error-class identity in the node.
