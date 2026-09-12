# Package and publish the Oya kernels

This ExecPlan follows `PLANS.md`. Status: packaging authorized with MIT licensing; stage 1 is complete for review. Continue one small stage at a time, stopping for the user's line-by-line review. Publication awaits review of the final artifacts and confirmation of npm access. Node changes follow publication.

## Purpose / Big Picture

Publish the four existing `@oyaprotocol` kernels so independent nodes can install reviewed versions without building kernel source. Preserve their APIs and Noble dependencies. Prove the released packages work in a clean external project.

## Progress

- [x] 2026-09-12: Inspected package manifests, exports, build configuration, tests, and repository guidance at `a4421f7`; drafted this plan.
- [x] 2026-09-12: User authorized packaging with MIT, specified John Shutt as copyright holder, and selected the existing repository URL. Prepared version `0.1.0`; npm returned E404 for all four package lookups.
- [x] 2026-09-12: Stage 1: Updated metadata, added four MIT license files, refreshed the workspace lockfile, and fixed three README links for external readers. Build, 205 tests, both type checks, and four root imports passed; created and inspected four archives.
- [ ] User reviews stage 1 before implementation continues.
- [ ] Stage 2: Validate and review the exact package archives.
- [ ] Confirm npm scope/publishing access before release; public lookups do not establish access rights.
- [ ] Stage 3: Publish and verify registry installation.
- [ ] Record the handoff to the node operations plan.

## Surprises & Discoveries

The packages started with exports, declarations, archive allowlists, and version `0.0.0`, but no license files. The repository origin is `https://github.com/pemulis/ethonline-2026`, with `origin/HEAD` pointing to `main`; the user confirmed using it for package metadata. Registry checks first failed with sandbox DNS errors, then returned E404 with network access. This means no visible release was found, not that scope ownership was verified. Local validation used Node 23.10.0/npm 11.18.0; repeat the consumer checks under CI's Node 22 before publication. Kernels retain their ECMAScript 2025 requirements.

## Decision Log

- 2026-09-12 / Codex: Keep four packages with exact internal versions and existing dependencies; avoid unnecessary restructuring.
- 2026-09-12 / Codex: Prepare coordinated `0.1.0` metadata and exact internal dependencies after no visible registry releases were found; reconfirm availability when publishing.
- 2026-09-12 / user: Use MIT, copyright 2026 John Shutt, and the existing repository. Each manifest identifies its package directory within that repo.
- 2026-09-12 / Codex: Publish reviewed archives through an owner-operated npm session; keep the first release process small.
- 2026-09-12 / user requirement: Finish packaging/publication before changing the node; preserve small review stages.

## Outcomes & Retrospective

Stage 1 changed only manifests, license files, documentation, the package workspace lockfile, and this plan. Existing tests and archive inspection passed. No kernel implementations, dependencies, node files, or release scripts changed, and nothing was published. Stage 2 still needs the maintained external consumer test; stage 1's temporary archives are review artifacts, not an approved release.

## Context and Orientation

`packages/{utils,ethereum,ipfs,messages}` contain the packages; their private workspace root owns TypeScript tooling and stays private. `ethereum` and `ipfs` depend on `utils`; `messages` depends on all three. Only Noble libraries are external runtime dependencies. `packages/AGENTS.md` keeps host wiring outside kernels.

The node uses local `file:` dependencies. Resume `plans/local-log-node-operations-execplan.md` after release; setup exists, readiness and lifecycle commands remain pending.

## Plan of Work

**Stage 1 — Release metadata (complete for review).** Use MIT and the user-confirmed repository/copyright metadata. Check visible versions and record scope access as a pre-publication requirement. Update four manifests, internal versions, and `packages/package-lock.json`. Include the approved license, explicit public access, and usable documentation links. Retain built ESM exports, declarations, and dependency pins. Build, run existing tests, inspect package archives, and review the metadata diff.

**Stage 2 — Archive validation.** Add `packages/test/release.test.mjs` using Node built-ins and the existing TypeScript compiler. Pack compressed `.tgz` archives into a temporary directory, record file lists and SHA-512 integrity values, and install all four together in an external temporary consumer. Clear `NODE_PATH`; disable install scripts and reject workspace symlinks. Verify root imports, a known CID/Logger vector, signature validation, and declaration imports using existing fixtures. Audit shipped code/types/docs/license, including source maps, for unintended files or secrets. Add release instructions to `packages/README.md`; retain reviewed archives and evidence outside the checkout. No blockchain, IPFS service, or real keys are needed.

**Stage 3 — Publish and verify.** Obtain approval of the exact versions, archives, integrity values, and test evidence before publishing. The owner authenticates privately; no tokens enter source, arguments, or plans. Publish the same archives in order: `utils`, `ethereum`, `ipfs`, `messages`, verifying each registry version and integrity. Install exact registry versions into a new consumer and repeat stage 2 checks. Record releases and update the node operations plan's handoff; node implementation remains a subsequent stage.

## Concrete Steps

Future commands, from the repository root unless stated otherwise:

    npm --prefix packages ci --include=dev
    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ethereum/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    node --test packages/test/release.test.mjs
    git diff --check

Use Node 22, matching CI, and record Node/npm versions. Check available versions with `npm view @oyaprotocol/utils versions --json --registry=https://registry.npmjs.org/`, repeating for all packages. Distinguish missing packages from access/network failures. Refresh the workspace lockfile without upgrading dependencies.

Stage 2 runs `npm pack --workspaces --json --pack-destination <absolute-artifact-directory>` from `packages/`, then `npm install --ignore-scripts --save-exact <four-absolute-archive-paths>` from its empty consumer. Replace placeholders with actual paths; print the retained evidence location.

For the proposed version, the publication command is:

    npm publish /absolute/artifacts/oyaprotocol-utils-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/

Repeat explicitly for `ethereum`, `ipfs`, and `messages` in that order. Check each with `npm view @oyaprotocol/utils@0.1.0 version dist.integrity --json --registry=https://registry.npmjs.org/`, substituting its name. From a new consumer directory, install:

    npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @oyaprotocol/utils@0.1.0 @oyaprotocol/ethereum@0.1.0 @oyaprotocol/ipfs@0.1.0 @oyaprotocol/messages@0.1.0

Give `release.test.mjs` a registry-validation mode selected by `OYA_RELEASE_SOURCE=registry`; it uses the finalized manifest versions and repeats the same consumer checks. Run `OYA_RELEASE_SOURCE=registry node --test packages/test/release.test.mjs` after publishing.

## Validation and Acceptance

Existing tests and external consumer checks pass. Registry integrity matches reviewed archives; installed runtime dependencies are only Oya and Noble. Consumers need no build or install hook. Missing license/access blocks publication, but local archive testing can proceed.

## Idempotence and Recovery

Clean up only test-owned resources. Publication is not atomic across packages: after failure, inspect registry state and resume only missing identical artifacts. Published versions cannot be replaced; corrections require a new version. Do not automatically unpublish or move tags. Changed archives require renewed validation and review.

## Artifacts and Notes

Stage 1 began from `73c0734885fb9387d08e4553f0b44f635f30d0c0`. `npm --prefix packages install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` refreshed only Oya versions/license fields. The build, existing JavaScript test command above (205 passes), both type-check commands, and imports of all four package roots passed. A dry run of `npm --prefix node/production ci --ignore-scripts --dry-run --offline --no-audit --no-fund` also passed without node changes. Final diff review and `git diff --check` passed; kernel source/build outputs and external dependency versions are unchanged.

From `packages/`, `npm pack --workspaces --ignore-scripts --json --pack-destination /private/tmp/oya-kernel-release.D8kvra --cache /private/tmp/oya-kernel-release.D8kvra/npm-cache` created four `0.1.0` archives. `inventory.json` in that directory records full file lists, integrity values, and tool versions. Inspection verified each archived MIT license credits John Shutt, the archived manifest matches its source, dependencies retain their pins, only `dist/`, README, LICENSE, and package metadata ship, and archive hashes match npm's report. Node 22 validation and npm publishing access remain pending.

[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack) creates installable archives; [scoped publication](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) requires explicit public access. Packing needs no publication credentials; dependency installation needs registry connectivity.

## Interfaces and Dependencies

Edits: four manifests/license files, workspace lockfile, package READMEs, release test, and plans. Preserve kernel implementations; add no dependencies or release framework. Subsequent node work pins releases, removes kernel building from operator setup, and adjusts CI/tests for released dependencies.
