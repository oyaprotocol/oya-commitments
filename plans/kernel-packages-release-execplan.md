# Package and publish the Oya kernels

This ExecPlan follows `PLANS.md`. Status: stage 1 reviewed; stage 2 implementation and validation are complete for review. Continue one small stage at a time, stopping for the user's line-by-line review. Publication awaits review of the final artifacts and confirmation of npm access. Node changes follow publication.

## Purpose / Big Picture

Publish the four existing `@oyaprotocol` kernels so independent nodes can install reviewed versions without building kernel source. Preserve their APIs and Noble dependencies. Prove the released packages work in a clean external project.

## Progress

- [x] 2026-09-12: Inspected package manifests, exports, build configuration, tests, and repository guidance at `a4421f7`; drafted this plan.
- [x] 2026-09-12: User authorized packaging with MIT, specified John Shutt as copyright holder, and selected the existing repository URL. Prepared version `0.1.0`; npm returned E404 for all four package lookups.
- [x] 2026-09-12: Stage 1: Updated metadata, added four MIT license files, refreshed the workspace lockfile, and fixed three README links for external readers. Build, 205 tests, both type checks, and four root imports passed; created and inspected four archives.
- [x] 2026-09-12: Set CI's Node.js baseline to 24 and documented that kernels have no Node.js runtime or engine-version requirement.
- [x] 2026-09-12: Updated all four package repository URLs and package documentation links to the user-selected canonical repository, `oyaprotocol/oya-commitments`.
- [x] 2026-09-12: User accepted moving on from stage 1 and authorized stage 2.
- [x] 2026-09-12: Under temporary Node.js 24.21.0, the build, all 205 existing kernel tests, and both type checks passed.
- [x] 2026-09-12: Stage 2: Added the maintained release test and instructions, excluded build caches, and validated all four archives in an independent consumer under Node.js 24.21.0/npm 11.19.0.
- [ ] User reviews stage 2 code and the exact archives before publication.
- [ ] Confirm npm scope/publishing access before release; public lookups do not establish access rights.
- [ ] Stage 3: Publish and verify registry installation.
- [ ] Record the handoff to the node operations plan.

## Surprises & Discoveries

The packages started with exports, declarations, archive allowlists, and version `0.0.0`, but no license files. Initial package metadata used the checkout's origin; the user subsequently selected `https://github.com/oyaprotocol/oya-commitments` as the canonical repository. Registry checks first failed with sandbox DNS errors, then returned E404 with network access. This means no visible release was found, not that scope ownership was verified. Stage 1 used Node 23.10.0/npm 11.18.0; stage 2 used a verified temporary Node 24.21.0/npm 11.19.0 installation. Kernels retain their ECMAScript 2025 requirements.

The stage 2 file allowlist rejected `dist/.tsbuildinfo` in every archive. The earlier broad `dist` inclusion shipped TypeScript's incremental build metadata even though Git ignores it. Each manifest now limits `files` to JavaScript, declarations, source maps, README, and LICENSE. The release test validates archive contents through npm's inventory and an installed external consumer, without adding a tar parser or dependency. Registry installation required sandbox network approval. The declaration check caught a missing label argument in the new consumer fixture's `assertCanonicalCid` call; correcting that fixture made the full release test pass.

## Decision Log

- 2026-09-12 / Codex: Keep four packages with exact internal versions and existing dependencies; avoid unnecessary restructuring.
- 2026-09-12 / Codex: Prepare coordinated `0.1.0` metadata and exact internal dependencies after no visible registry releases were found; reconfirm availability when publishing.
- 2026-09-12 / user: Use MIT, copyright 2026 John Shutt. Each manifest identifies its package directory within the repository.
- 2026-09-12 / Codex: Publish reviewed archives through an owner-operated npm session; keep the first release process small.
- 2026-09-12 / user requirement: Finish packaging/publication before changing the node; preserve small review stages.
- 2026-09-12 / user: Use Node.js 24 as the CI build/test baseline, without requiring Node.js or a particular Node.js version for the kernels, since they do not depend on that runtime.
- 2026-09-12 / user: Use `https://github.com/oyaprotocol/oya-commitments` for package metadata and documentation links so they identify the upstream project. This supersedes the initial choice of the checkout's origin.
- 2026-09-12 / Codex: Exclude incremental build caches with explicit file globs after archive validation exposed them. Preserve kernel implementation and dependency versions.
- 2026-09-12 / Codex: Launch the release test through `npm run test:release`; invoke the npm CLI supplied by `npm_execpath` with the current Node executable, avoiding platform-specific shell wrappers. Keep registry verification for stage 3.

## Outcomes & Retrospective

Stage 1 prepared package metadata, licenses, documentation, and the package workspace lockfile. Subsequent adjustments selected the canonical repository and Node.js 24 for CI, while preserving the kernels' independence from Node.js. Stage 1's preliminary archives are superseded by the stage 2 artifacts below.

Stage 2 adds `packages/test/release.test.mjs`, the private workspace's `test:release` command, and README instructions. Its first run identified build caches in the archives; four small file-list changes exclude those caches. The external consumer passed runtime checks for all package roots, signed-message validation/rejection, injected IPFS publication, and Logger encoding/hashing. TypeScript compiled its declaration imports with `skipLibCheck: false` and no ambient Node types. Its lockfile contains exactly the four Oya packages and `@noble/curves`/`@noble/hashes` at `2.2.0`.

The build, 205 existing tests, both existing type checks, and the new release test passed under Node.js 24.21.0. Archive inspection and `git diff --check` passed. No dependencies, kernel implementations/build outputs, node code, or lockfiles changed in stage 2. Nothing was published. User review and npm publishing access remain pending; runtime-specific validation outside Node.js remains future work.

## Context and Orientation

`packages/{utils,ethereum,ipfs,messages}` contain the packages; their private workspace root owns TypeScript tooling and stays private. `ethereum` and `ipfs` depend on `utils`; `messages` depends on all three. Only Noble libraries are external runtime dependencies. `packages/AGENTS.md` keeps host wiring outside kernels.

The node uses local `file:` dependencies. Resume `plans/local-log-node-operations-execplan.md` after release; setup exists, readiness and lifecycle commands remain pending.

## Plan of Work

**Stage 1 — Release metadata (complete).** Use MIT and the user-confirmed repository/copyright metadata. Check visible versions and record scope access as a pre-publication requirement. Update four manifests, internal versions, and `packages/package-lock.json`. Include the approved license, explicit public access, and usable documentation links. Retain built ESM exports, declarations, and dependency pins. Build, run existing tests, inspect package archives, and review the metadata diff.

**Stage 2 — Archive validation (complete for review).** `packages/test/release.test.mjs` uses Node built-ins and the existing TypeScript compiler. It packs compressed `.tgz` archives into a temporary directory, records file lists and SHA-512 integrity values, and installs all four together in an external temporary consumer. It clears `NODE_PATH`/`NODE_OPTIONS`, disables install scripts, rejects workspace symlinks, and verifies root imports, a known CID/Logger vector, signature validation, and declaration imports using existing fixtures. Shipped files are compared byte-for-byte with the checkout; source maps must reference package-local source without embedded contents. File allowlists and recognizable private-key/npm-token patterns supplement manual review. `packages/README.md` documents the command and retained artifacts. No blockchain, IPFS service, or real keys are needed.

**Stage 3 — Publish and verify.** Obtain approval of the exact versions, archives, integrity values, and test evidence before publishing. The owner authenticates privately; no tokens enter source, arguments, or plans. Publish the same archives in order: `utils`, `ethereum`, `ipfs`, `messages`, verifying each registry version and integrity. Install exact registry versions into a new consumer and repeat stage 2 checks. Record releases and update the node operations plan's handoff; node implementation remains a subsequent stage.

## Concrete Steps

Future commands, from the repository root unless stated otherwise:

    npm --prefix packages ci --include=dev
    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ethereum/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    npm --prefix packages run test:release
    git diff --check

Use Node 24 for these build/test commands, matching CI, and record Node/npm versions. This is a validation baseline, not a kernel runtime requirement; keep kernel manifests free of a Node.js engine constraint. Check available versions with `npm view @oyaprotocol/utils versions --json --registry=https://registry.npmjs.org/`, repeating for all packages. Distinguish missing packages from access/network failures. Refresh the workspace lockfile without upgrading dependencies.

Stage 2's maintained test runs `npm pack --workspaces --ignore-scripts --json --pack-destination <absolute-artifact-directory>` from `packages/`, then `npm install --ignore-scripts --save-exact --no-audit --no-fund <four-absolute-archive-paths>` from its empty consumer. It supplies an isolated npm cache, the public registry URL, bounded fetch/command timeouts, and clears `NODE_PATH` and `NODE_OPTIONS`. Each run prints and retains the evidence directory. Neither command publishes anything.

For the proposed version, the publication command is:

    npm publish /absolute/artifacts/oyaprotocol-utils-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/

Repeat explicitly for `ethereum`, `ipfs`, and `messages` in that order. Check each with `npm view @oyaprotocol/utils@0.1.0 version dist.integrity --json --registry=https://registry.npmjs.org/`, substituting its name. From a new consumer directory, install:

    npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @oyaprotocol/utils@0.1.0 @oyaprotocol/ethereum@0.1.0 @oyaprotocol/ipfs@0.1.0 @oyaprotocol/messages@0.1.0

In stage 3, add a registry-validation mode to `release.test.mjs` selected by `OYA_RELEASE_SOURCE=registry`; it uses the finalized manifest versions and repeats the same consumer checks. Run `OYA_RELEASE_SOURCE=registry npm --prefix packages run test:release` after publishing. Stage 2 implements archive validation only.

## Validation and Acceptance

Existing tests and external consumer checks pass. Registry integrity matches reviewed archives; installed runtime dependencies are only Oya and Noble. Consumers need no build or install hook. Missing license/access blocks publication, but local archive testing can proceed.

## Idempotence and Recovery

Clean up only test-owned resources. Publication is not atomic across packages: after failure, inspect registry state and resume only missing identical artifacts. Published versions cannot be replaced; corrections require a new version. Do not automatically unpublish or move tags. Changed archives require renewed validation and review.

## Artifacts and Notes

Stage 1 began from `73c0734885fb9387d08e4553f0b44f635f30d0c0`. `npm --prefix packages install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` refreshed only Oya versions/license fields. The build, existing JavaScript test command above (205 passes), both type-check commands, and imports of all four package roots passed. A dry run of `npm --prefix node/production ci --ignore-scripts --dry-run --offline --no-audit --no-fund` also passed without node changes. Final diff review and `git diff --check` passed; kernel source/build outputs and external dependency versions are unchanged.

Stage 1's archives at `/private/tmp/oya-kernel-release.D8kvra` are obsolete: they predate corrected repository metadata and the exclusion of build caches. Use the stage 2 artifacts below for review.

Stage 2 validation used Node.js `v24.21.0`, npm `11.19.0`, and TypeScript `6.0.3`, starting from `da38002caf5dd39d083a96b87a4e3865c8a34c70` plus this stage's changes. The temporary Node runtime is `/private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/bin/node`; its official archive's SHA-256 matched `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` from Node's checksum list. It did not replace the operator's installed Node. Prefix npm validation commands with `PATH=/private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/bin:$PATH` to reproduce this session while that temporary runtime exists.

The passing release run retained `/private/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-release-EidKzJ`. Its `inventory.json` records `validation: passed`, full file lists, tool versions, source commit/changed paths, and dependency versions. `consumer/` contains the installed archives, lockfile, reused fixture values, and runtime/type checks. All artifacts have version `0.1.0`:

| Package | Archive bytes | Files | SHA-512 integrity |
| --- | ---: | ---: | --- |
| utils | 10496 | 18 | `sha512-xug3ns0jq/4zrRtQUca3cVno8lh+IRJLC+M+cNQKcJKQWQOlcseuOKYwomNAR4xARXW8SzNpb9MWsTchivLcXw==` |
| ethereum | 27502 | 24 | `sha512-XPV5XqLXotX4Syy9Rw89aBkXsLozPiY4atXHK3JusITEOI6A1XjesEFozka0NMuJTn6FVNKwj6UAp1lG5dbrUw==` |
| ipfs | 12167 | 30 | `sha512-FT0vmpdOh3CNN2rf8FL5BxsWisrhZYAvBkPrt7drwZgUMtfoQ+Z9grXNdRdJ3FmeudpH/lwLwfmXJs/EftYbqw==` |
| messages | 16170 | 24 | `sha512-fvU+uSZK8rI/eSQWz0d9NBE6uwNNSQGi2mpCa9q9SleLDMRSWxaZ9GrcDHxf4S9cEf/oKLwu903I9v/VDQIjFA==` |

The final release run passed in about 3.6 seconds. Failed earlier runs remain separate temporary directories with a failed inventory status. Retain approved artifacts outside OS-managed temporary storage before publication; if they disappear or change, regenerate and revalidate them. Registry publication/installation verification and npm publishing access remain pending.

[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack) creates installable archives; [scoped publication](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) requires explicit public access. Packing needs no publication credentials; dependency installation needs registry connectivity.

## Interfaces and Dependencies

Edits: four manifests/license files, workspace manifest/lockfile, package READMEs, release test, and plans. Preserve kernel implementations; add no dependencies or release framework. Subsequent node work pins releases, removes kernel building from operator setup, and adjusts CI/tests for released dependencies.
