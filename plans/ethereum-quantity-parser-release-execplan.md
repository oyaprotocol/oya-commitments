# Export the Ethereum quantity parser and adopt it in local checks

This ExecPlan follows `PLANS.md`. **Status: completed on 2026-09-13.** The user authorized exporting the parser, publishing `@oyaprotocol/ethereum@0.1.2`, and updating the node, then explicitly authorized the companion `@oyaprotocol/messages@0.1.2` release. Config/signer hardening and node lifecycle work remain separate.

## Purpose / Big Picture

The local node should use the kernel's existing bounded quantity parser for RPC chain IDs and balances. Expose `parseTransactionQuantity(value: unknown, name: string): bigint` through the Ethereum package root, preserve its implementation, and remove the duplicate host helper.

## Progress

- [x] 2026-09-13: Reviewed instructions, parser behavior, package metadata, release tooling, and host dependency boundaries from a clean working tree.
- [x] 2026-09-13: Added the public export, documentation, runtime/type tests, and archive-consumer checks; updated local check to call the parser.
- [x] 2026-09-13: Prepared Ethereum `0.1.2` metadata and a companion messages `0.1.2` manifest with only its version and Ethereum dependency changed. Build and two parser tests passed.
- [x] 2026-09-13: All 207 kernel tests, both type checks, and the archive consumer passed. An isolated host installed the reviewed archives and passed all 40 tests.
- [x] 2026-09-13: Both publication directories repack byte-for-byte to their reviewed archives. Captured npm metadata contains neither local paths nor `_from`/`_resolved`. Messages changes only `package.json`.
- [x] 2026-09-13: User explicitly authorized publishing messages `0.1.2` alongside Ethereum.
- [x] 2026-09-13: Published Ethereum and then messages `0.1.2`, completing npm browser authentication for each. Both public releases use `latest` and match the reviewed archive hashes.
- [x] 2026-09-13: Fresh registry-consumer validation passed, including runtime and declaration imports, dependency alignment, exact content/hashes, and absence of `_from`/`_resolved` metadata.
- [x] 2026-09-13: Updated the host's exact pins and lockfile, completed a fresh locked installation, and passed all 40 host tests against registry packages. Only the Ethereum/messages entries changed; all external dependencies remain identical.
- [x] 2026-09-13: Updated operating documentation and both active plans; whitespace checks passed.

## Surprises & Discoveries

`messages@0.1.1` pins `ethereum@0.1.1`. Installing Ethereum `0.1.2` directly would introduce a second copy. The host classifies failures using `instanceof LogCidError` and `EthereumTransactionReceiptTimeoutError`, so those classes must come from the same Ethereum instance used by messages. The release validator also requires aligned internal pins. A companion messages release changes only two manifest fields and preserves implementation and other dependency versions.

npm required browser authentication for each package publication despite the existing login. Each command completed successfully after authentication; no publication was retried and no authentication material entered source or documentation.

## Decision Log

- 2026-09-13 / user: Publish Ethereum `0.1.2` and use its public quantity parser in the node.
- 2026-09-13 / Codex: Reuse the bounded parser unchanged; the existing check catch handles its exceptions and prints sanitized failures.
- 2026-09-13 / Codex: Prepare a messages manifest update for review before publishing that additional package. Prefer one Ethereum dependency instance and retain exact pins.
- 2026-09-13 / user: Publish the prepared messages `0.1.2` companion release as well.
- 2026-09-13 / Codex: Use the existing release validator and Node 24/npm toolchain. Publish directories extracted from validated archives to avoid npm adding local archive paths to public metadata. Use generic paths in documentation.

## Outcomes & Retrospective

Both `0.1.2` releases are published and verified. The node imports the kernel parser directly and installs the exact registry versions with one Ethereum instance. All 207 kernel tests, both strict type checks, archive and registry consumers, and 40 host tests passed under Node 24.21.0. The parser implementation, messages implementation, other dependencies, contracts, and signing behavior are unchanged. The completed release removes duplicate host parsing without expanding the kernel's runtime requirements.

## Context and Orientation

The parser lives in `packages/ethereum/src/request-utils.ts`; its public exports live in `src/index.ts`. The production host consumes published kernels in `node/production/package.json`. `packages/test/release.test.mjs` packs all four kernels, verifies their contents, installs an isolated consumer, and checks runtime exports and TypeScript declarations. Packing all four does not imply publishing all four; utils and IPFS remain at `0.1.1`.

## Plan of Work

Validate the public parser's canonical syntax, uint256 boundaries, error redaction, and declarations. Extend the existing release consumer to exercise that export. Validate the complete dependency set and the host against the reviewed archives before publication. Publish Ethereum first and publish messages only with authorization. Verify exact hashes and absence of `_from`/`_resolved` metadata; use a fresh registry consumer and the normal host locked installation afterward.

## Concrete Steps

From the repository root with Node 24 and npm on `PATH`:

    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ethereum/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
    node packages/node_modules/typescript/bin/tsc -p packages/ethereum/tsconfig.type-test.json
    node packages/node_modules/typescript/bin/tsc -p packages/messages/tsconfig.type-test.json
    npm --prefix packages run test:release

Extract only the approved archive files to temporary publication directories. Confirm repacking produces the validated integrity hashes. From each authorized package directory use the same Node/npm versions:

    npm publish . --access public --tag latest --registry=https://registry.npmjs.org/ --ignore-scripts

Then run registry validation with `OYA_RELEASE_SOURCE=registry` and `OYA_RELEASE_INVENTORY=/path/to/reviewed-artifacts/inventory.json`, update the host's exact dependency pins and lockfile, and run `npm --prefix node/production test` and `git diff --check`. Temporary paths are placeholders; retain validation artifacts outside source control. Never print credentials or store them in a plan.

## Validation and Acceptance

The public import returns `bigint` and rejects malformed or oversized quantities. Kernel tests, strict declaration checks, packed and registry consumers, and host checks pass. Host failure classification continues to pass with one installed Ethereum version. Only authorized versions are published, with canonical repository/license metadata and verified archive hashes.

## Idempotence and Recovery

Builds and tests may be repeated as needed. npm versions cannot be overwritten: after an ambiguous publish result, inspect the exact registry version and hash before retrying. Do not unpublish or modify existing releases. Keep unapproved package publication pending; existing credentials and local node configuration must remain untouched.

## Artifacts and Notes

Validation used Node 24.21.0 and npm 11.19.0. Build, 207 kernel tests, both strict type checks, and archive runtime/declaration validation passed. An isolated host copy installed all four reviewed archives with existing dependencies from the local cache and passed all 40 tests, including failure classification and oversized balances. No operator configuration or credentials were used for tests.

The Ethereum archive changes only its manifest, README, and the three compiled public entrypoint files. The messages archive changes only its manifest. Repacking prepared directories reproduces both reviewed archives exactly. Local interception of npm's outgoing publication metadata (without credentials or network calls) confirmed the expected hashes, `latest` tag, and absence of local paths and `_from`/`_resolved` fields.

| Package | Archive bytes | SHA-512 integrity |
| --- | --- | --- |
| `@oyaprotocol/ethereum@0.1.2` | 27,790 | `sha512-g4ujYZX3+2pSA+U28a92C07Rb9AcHr5vY7CavorIhu6fthfx1P0ATrVfuByc3kFoPOHaYskzTV3Br97lcvCViA==` |
| `@oyaprotocol/messages@0.1.2` | 16,173 | `sha512-GBzUiW+evoU2ihnnigr9kW+oe7idV3FrKn3lHiUIBjFmaZy8LCVzydBcnr6fKNpSqdWM1zrWFq72ZDD+HOn3uA==` |

Both registry records match the table, carry `latest: 0.1.2`, and omit `_from`/`_resolved`. Registry-mode `test:release` passed against the retained inventory in about six seconds. The host update installed two changed packages; `npm --prefix node/production ci --ignore-scripts --offline --no-audit --no-fund --cache=/path/to/populated-npm-cache` then installed the locked 16 packages successfully. `npm --prefix node/production test` passed all 40 tests with zero failures or skips. Comparing both lockfiles to the starting commit confirmed that no dependency paths were added and only the expected Ethereum/messages metadata and direct host pins changed. `git diff --check` passed. Validation used temporary local fixtures, with no Ethereum broadcasts or IPFS uploads.

## Interfaces and Dependencies

Add only `parseTransactionQuantity` to the Ethereum public API. Preserve utils/IPFS `0.1.1`, Noble `2.2.0`, ethers `6.17.0`, and the kernel's independence from Node.js. The host uses the exported parser directly and retains its existing timeout and failure handling.
