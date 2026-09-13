# Package and publish the Oya kernels

This ExecPlan follows `PLANS.md`. Status: complete on 2026-09-12. All four `0.1.1` releases are public with `latest`, clean metadata, matching archive hashes, and a passing fresh registry consumer under Node.js 24. All four `0.1.0` packages remain published and validated. The next separately reviewed implementation stage is the host dependency migration recorded in the node operations plan.

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
- [x] 2026-09-12: User accepted proceeding from stage 2 to the registry-verification change, with review before publication.
- [x] 2026-09-12: Stage 3a: Added registry mode using a retained passing inventory; archive validation and registry-mode fixture checks passed under Node.js 24.21.0.
- [x] 2026-09-12: User approved stage 3a and publication of the reviewed `0.1.0` archives under `@oyaprotocol`.
- [x] 2026-09-12: Confirmed npm identity `pemulis` and owner membership in `oyaprotocol`. Rechecked that all four versions were absent and all archive hashes/files matched the reviewed checkout; retained a release copy outside temporary storage.
- [x] 2026-09-12: Published `utils@0.1.0` and `ethereum@0.1.0`; registry versions and integrity match. Ethereum's exact-version endpoint returned the matching release while `npm view` still returned E404.
- [x] 2026-09-12: Published `ipfs@0.1.0` and `messages@0.1.0`; registry metadata matches the reviewed hashes. Initial registry-consumer runs stopped on E404 for the messages listing; normal npm lookups subsequently succeeded for every package.
- [x] 2026-09-12: Stage 3b: Fresh registry installation and all consumer checks passed under Node.js 24.21.0/npm 11.19.0. Confirmed all four `latest` tags point to `0.1.0`; retained the passing inventory and consumer lockfile.
- [x] 2026-09-12: Recorded a separate host-dependency migration stage in the node operations plan; no node implementation changes were made.
- [x] 2026-09-12: Investigated the user's metadata-correction request. Found no supported command/API for editing `_from` and `_resolved` on existing versions; prepared a support request below. No registry mutation or support message was sent during this investigation.
- [x] 2026-09-12: User selected a clean `0.1.1` release after discussing that the old local paths reveal no credentials or machine access. Support redaction is optional and is not required for this release.
- [x] 2026-09-12: Stage 4 preparation: four `0.1.1` versions/internal pins, lockfile refresh, and two registry assertions. Node 24 build, 205 tests, both type checks, and archive-consumer validation passed. All staged package directories reproduce the validated hashes; locally captured outgoing metadata contains neither path field nor local filesystem paths.
- [x] 2026-09-12: Stage 4 publication: all four `0.1.1` publish commands succeeded using Node 24/npm 11.19. The first registry run verified utils/messages metadata and hashes, then stopped while the IPFS version listing was unavailable.
- [x] 2026-09-12: Stage 4 verification: all four public `0.1.1` records omit `_from` and `_resolved`, match validated hashes, and have the `latest` tag. Fresh registry-consumer checks passed, evidence was retained, and the node handoff now targets `0.1.1`.

## Surprises & Discoveries

The packages started with exports, declarations, archive allowlists, and version `0.0.0`, but no license files. Initial package metadata used the checkout's origin; the user subsequently selected `https://github.com/oyaprotocol/oya-commitments` as the canonical repository. Registry checks first failed with sandbox DNS errors, then returned E404 with network access. This means no visible release was found, not that scope ownership was verified. Stage 1 used Node 23.10.0/npm 11.18.0; stage 2 used a verified temporary Node 24.21.0/npm 11.19.0 installation. Kernels retain their ECMAScript 2025 requirements.

The stage 2 file allowlist rejected `dist/.tsbuildinfo` in every archive. The earlier broad `dist` inclusion shipped TypeScript's incremental build metadata even though Git ignores it. Each manifest now limits `files` to JavaScript, declarations, source maps, README, and LICENSE. The release test validates archive contents through npm's inventory and an installed external consumer, without adding a tar parser or dependency. Registry installation required sandbox network approval. The declaration check caught a missing label argument in the new consumer fixture's `assertCanonicalCid` call; correcting that fixture made the full release test pass.

Stage 3a public lookups returned E404 for all four `0.1.0` packages. At that stage, `npm whoami --registry=https://registry.npmjs.org/` returned E401 with network access. The owner subsequently logged in; stage 3b confirmed identity `pemulis` and owner membership in `oyaprotocol`. npm required browser authentication for the first publication, which completed successfully. A real `npm view @noble/hashes@2.2.0 version dist.integrity --json` confirmed the metadata response shape used by the registry check. The new archive run produced the same four hashes recorded in stage 2.

Publication exposed an npm metadata behavior that archive inspection cannot detect: npm adds `_from` and `_resolved` containing the publication archive's local path. The first two releases therefore expose the retained archive path, including the local username, in registry metadata. Their archive contents remain unchanged and contain no machine-specific paths. The remaining two archives were copied byte-for-byte to a neutral temporary directory before publication. Do not record authentication URLs or credentials in release evidence.

New package listings temporarily returned E404 after npm reported publication success. Exact-version endpoints exposed the matching releases before their general listings were available. Two registry-consumer runs stopped on the messages listing; normal npm lookup and the third consumer run subsequently succeeded. Do not republish accepted versions to resolve visibility delays.

The metadata follow-up checked current npm CLI/API documentation and the installed CLI's metadata-write implementation. No supported edit for these two fields was found. npm's historical [registry validation code](https://github.com/npm/npm-registry-couchapp/blob/master/registry/validate_doc_update.js#L434-L455) rejects modifications to existing version metadata except limited fields including `directories` and `deprecated`; this is historical source evidence, not a live rejection from today's registry. Current [publication documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/) prohibits reusing an already published name/version, even after unpublishing. A new version would leave the affected `0.1.0` metadata present. Support redaction was proposed for the old versions; the user instead chose a clean new release after discussing the limited privacy impact of those paths.

Stage 4's initial staging check used the system Node 23/npm 11.18 toolchain and produced a different compressed archive hash. Using Node 24.21.0/npm 11.19.0 for packing, staging checks, and publication reproduces every validated archive byte-for-byte. Publication must therefore use the same temporary Node 24 executable and npm CLI, not the system npm command. The outgoing-payload check intercepted npm's fetch function locally; it sent no network request and loaded no publishing credentials.

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
- 2026-09-12 / Codex: Require `OYA_RELEASE_INVENTORY` in registry mode so verification stays tied to retained, validated archives. Compare registry metadata and the installed lockfile's integrity/source before reusing the consumer checks; do not repack in this mode.
- 2026-09-12 / user review workflow: Implement and review stage 3a before publication. Validate the unavailable registry success path with an isolated npm CLI fixture; reserve the actual public-registry installation check for after release.
- 2026-09-12 / user: Publish the four approved `@oyaprotocol` packages at `0.1.0`, with public access and the `latest` tag. Preserve the validated archives and keep node implementation changes for the next review stage.
- 2026-09-12 / Codex: Use a neutral temporary publication path after observing npm's added path metadata; copy the approved IPFS/messages archives without repacking. Future publications should use neutral paths from the start.
- 2026-09-12 / Codex: Prepare a targeted support request for existing metadata instead of an undocumented registry write or unpublishing. Preserve the working releases and their hashes; sending the request requires explicit authorization to contact support.
- 2026-09-12 / user: Publish version `0.1.1` with clean metadata. Coordinate all four packages so their exact internal dependency pins also use `0.1.1`; preserve implementations and Noble versions. Reuse established npm access without redundant login, organization, or version-availability probes.

## Outcomes & Retrospective

Stage 1 prepared package metadata, licenses, documentation, and the package workspace lockfile. Subsequent adjustments selected the canonical repository and Node.js 24 for CI, while preserving the kernels' independence from Node.js. Stage 1's preliminary archives are superseded by the stage 2 artifacts below.

Stage 2 adds `packages/test/release.test.mjs`, the private workspace's `test:release` command, and README instructions. Its first run identified build caches in the archives; four small file-list changes exclude those caches. The external consumer passed runtime checks for all package roots, signed-message validation/rejection, injected IPFS publication, and Logger encoding/hashing. TypeScript compiled its declaration imports with `skipLibCheck: false` and no ambient Node types. Its lockfile contains exactly the four Oya packages and `@noble/curves`/`@noble/hashes` at `2.2.0`.

The build, 205 existing tests, both existing type checks, and the new release test passed under Node.js 24.21.0. Archive inspection and `git diff --check` passed. No dependencies, kernel implementations/build outputs, node code, or lockfiles changed in stage 2. Nothing was published during that stage; runtime-specific validation outside Node.js remains future work.

Stage 3a extends the existing test and README. Registry mode verifies retained archive bytes against their recorded hashes, checks each exact npm version and hash, installs by name/version, and checks installed integrity and registry origin. The same file, dependency, runtime, and declaration checks follow. Default archive validation passed; a temporary npm CLI fixture exercised success and rejection cases. The release archives were unchanged, and nothing was published during stage 3a.

Stage 3b published all four reviewed `0.1.0` archives publicly under `@oyaprotocol`, in dependency order, using the owner's authenticated npm session. Normal npm metadata and the independent registry installation match every retained hash. Runtime checks, signed-message validation/rejection, injected IPFS publication, Logger encoding/hashing, and strict declaration checks passed. The consumer contains exactly the four Oya packages and Noble curves/hashes at `2.2.0`. This stage changes only the private workspace README and the two plans; kernel files, dependencies, lockfiles, and node implementation remain unchanged. The node plan now defines the next small stage: pin released dependencies and remove kernel building from operator setup.

The initial metadata investigation made no changes to published versions or tags. The support draft was not sent. The user subsequently chose a clean `0.1.1` release; it will not redact the historical `0.1.0` metadata.

Stage 4 completed that release. The four manifests and workspace lockfile now use `0.1.1` and exact internal pins. Two registry assertions reject `_from` and `_resolved`; the README explains directory publication with the validated Node/npm toolchain. All package files other than version/dependency metadata are byte-identical to `0.1.0`. Build, 205 existing tests, both type checks, archive validation, and fresh npm installation passed under Node 24.21.0/npm 11.19.0. Each public registry record has the matching hash, omits both fields, and is tagged `latest`. The node handoff targets `0.1.1`; host implementation remains a subsequent review stage. Historical `0.1.0` metadata remains available.

## Context and Orientation

`packages/{utils,ethereum,ipfs,messages}` contain the packages; their private workspace root owns TypeScript tooling and stays private. `ethereum` and `ipfs` depend on `utils`; `messages` depends on all three. Only Noble libraries are external runtime dependencies. `packages/AGENTS.md` keeps host wiring outside kernels.

The node uses local `file:` dependencies. Resume `plans/local-log-node-operations-execplan.md` after release; setup exists, readiness and lifecycle commands remain pending.

## Plan of Work

**Stage 1 — Release metadata (complete).** Use MIT and the user-confirmed repository/copyright metadata. Check visible versions and record scope access as a pre-publication requirement. Update four manifests, internal versions, and `packages/package-lock.json`. Include the approved license, explicit public access, and usable documentation links. Retain built ESM exports, declarations, and dependency pins. Build, run existing tests, inspect package archives, and review the metadata diff.

**Stage 2 — Archive validation (complete).** `packages/test/release.test.mjs` uses Node built-ins and the existing TypeScript compiler. It packs compressed `.tgz` archives into a temporary directory, records file lists and SHA-512 integrity values, and installs all four together in an external temporary consumer. It clears `NODE_PATH`/`NODE_OPTIONS`, disables install scripts, rejects workspace symlinks, and verifies root imports, a known CID/Logger vector, signature validation, and declaration imports using existing fixtures. Shipped files are compared byte-for-byte with the checkout; source maps must reference package-local source without embedded contents. File allowlists and recognizable private-key/npm-token patterns supplement manual review. `packages/README.md` documents the command and retained artifacts. No blockchain, IPFS service, or real keys are needed.

**Stage 3a — Registry verification (complete).** Add `OYA_RELEASE_SOURCE=registry` and require `OYA_RELEASE_INVENTORY` to reference a passing archive inventory with its `.tgz` files alongside it. Verify local archive hashes, exact registry metadata, installed hashes/origins, and the existing consumer checks. Record a separate inventory that identifies its source and reference inventory. Test success and rejection paths with an npm CLI fixture while public packages are unavailable.

**Stage 3b — Publish and verify (complete).** Obtain approval of the exact versions, archives, integrity values, and test evidence before publishing. The owner refreshes npm authentication privately with `npm login --registry=https://registry.npmjs.org/`; confirm identity with `npm whoami` and organization membership with `npm org ls oyaprotocol <npm-username> --json`, using the public registry. No tokens enter source, arguments, or plans. Recheck package/version availability, then publish the same archives in order: `utils`, `ethereum`, `ipfs`, `messages`, verifying each registry version and integrity. Run registry-mode validation against the retained archive inventory. Record releases and update the node operations plan's handoff; node implementation remains a subsequent stage.

**Stage 4 — Clean metadata release (complete).** Keep the existing archive validation, then extract only the validated archive files into neutral temporary package directories. Publish these directories with `--ignore-scripts`; npm's directory publication reads the package manifest directly rather than adding the tarball input's `_from`/`_resolved` fields. Before publishing, verify that repacking those directories produces the exact validated archive hashes and inspect the outgoing manifest using the installed npm implementation. The registry test now rejects both unwanted fields. Build and run the existing kernel tests/type checks under Node 24, validate the archives, publish in dependency order, and run a fresh registry consumer against the retained `0.1.1` inventory. No new dependency or kernel implementation is needed. Historical `0.1.0` registry checks require that release's earlier test revision.

## Concrete Steps

Validation and release commands, from the repository root unless stated otherwise:

    npm --prefix packages ci --include=dev
    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ethereum/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    npm --prefix packages run test:release
    git diff --check

Use Node 24 for these build/test commands, matching CI, and record Node/npm versions. This is a validation baseline, not a kernel runtime requirement; keep kernel manifests free of a Node.js engine constraint. Check available versions with `npm view @oyaprotocol/utils versions --json --registry=https://registry.npmjs.org/`, repeating for all packages. Distinguish missing packages from access/network failures. Refresh the workspace lockfile without upgrading dependencies.

Stage 2's maintained test runs `npm pack --workspaces --ignore-scripts --json --pack-destination <absolute-artifact-directory>` from `packages/`, then `npm install --ignore-scripts --save-exact --no-audit --no-fund <four-absolute-archive-paths>` from its empty consumer. It supplies an isolated npm cache, the public registry URL, bounded fetch/command timeouts, and clears `NODE_PATH` and `NODE_OPTIONS`. Each run prints and retains the evidence directory. Neither command publishes anything.

The approved `0.1.0` release used the following publication command shape. Those versions are already published; do not republish them. Stage 4's directory publication supersedes this approach for subsequent releases:

    npm publish /absolute/artifacts/oyaprotocol-utils-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/

Repeat explicitly for `ethereum`, `ipfs`, and `messages` in that order. Check each with `npm view @oyaprotocol/utils@0.1.0 version dist.integrity --json --registry=https://registry.npmjs.org/`, substituting its name. From a new consumer directory, install:

    npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @oyaprotocol/utils@0.1.0 @oyaprotocol/ethereum@0.1.0 @oyaprotocol/ipfs@0.1.0 @oyaprotocol/messages@0.1.0

After publication, run the implemented registry mode from the same checkout:

    OYA_RELEASE_SOURCE=registry OYA_RELEASE_INVENTORY=/absolute/path/to/reviewed-artifacts/inventory.json npm --prefix packages run test:release

Replace the inventory path with the retained passing archive inventory; keep the four archives beside it. The current manifests must still describe those versions. The command creates separate evidence and does not publish or repack anything.

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

The final archive release run passed in about 3.6 seconds. Failed earlier runs remain separate temporary directories with a failed inventory status. The approved archives and `inventory.json` were copied to `/Users/johnshutt/Code/oya-kernel-releases/0.1.0` before publication. All hashes and archived files still matched the reviewed checkout at `67b3fd7`. If retained artifacts disappear or change, regenerate and revalidate them before publication.

Stage 3a began from `e8c006a` with a clean working tree. The archive-mode regression passed under Node.js 24.21.0/npm 11.19.0; its artifact directory is `oya-kernel-release-2LhD1o` alongside the retained stage 2 directory. All four archive hashes match the table above. Temporary fixture evidence is in `/private/tmp/oya-registry-check.S7R1Fz`: `npm-fixture.cjs`, case logs/call records, and `results.json`. Nine cases cover success, wrong registry version, wrong registry hash, wrong installed hash, file installation, invalid source selection, missing inventory, failed inventory, and missing archive list. These are simulated npm responses/installations; they do not establish successful publication or installation from npm. Syntax and diff checks passed. Read-only public version lookups returned E404; the authenticated identity endpoint returned E401. No package publication was attempted.

Stage 3b began from clean commit `67b3fd7414ace42490b36ef8f1a7e9394a856959`. npm reported successful publication of `@oyaprotocol/{utils,ethereum,ipfs,messages}@0.1.0`, each with public access and `latest`. Publishing used npm 11.18.0/Node 23.10.0; validation used the Node 24 baseline. The passing command was:

    PATH=/private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/bin:$PATH OYA_RELEASE_SOURCE=registry OYA_RELEASE_INVENTORY=/Users/johnshutt/Code/oya-kernel-releases/0.1.0/inventory.json npm --prefix packages run test:release

It passed in about 5.8 seconds with zero failures/skips, retaining `/private/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-release-E8Eey9`. The release directory also retains `registry-inventory.json` (`source: registry`, `validation: passed`) and `registry-consumer-lock.json`. The two preceding failed runs, `oya-kernel-release-d9MvRN` and `oya-kernel-release-ciNOt2` in the same temporary parent, stopped at the messages metadata lookup before installation. Registry validation added no code changes or workarounds. Final documentation review and `git diff --check` passed.

[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack) creates installable archives; [scoped publication](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) requires explicit public access. Packing needs no publication credentials; dependency installation needs registry connectivity.

Stage 4's passing archive consumer is `/private/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-release-EpKemV`. Its four archives and inventory are retained at `/Users/johnshutt/Code/oya-kernel-releases/0.1.1`, together with `publication-evidence.json` containing the locally captured outgoing version metadata. Neutral publication directories are `/private/tmp/oya-kernel-011-0mcbukjk/{utils,ethereum,ipfs,messages}`. Comparing every old/new archive file confirmed that only versions and internal dependency pins changed; all other package contents are byte-identical to `0.1.0`.

| Package | `0.1.1` archive bytes | SHA-512 integrity |
| --- | ---: | --- |
| utils | 10496 | `sha512-GITYSfQLXKJqWV0+PFFbm54BfozSNgG93BuecSl0mkCcLWaqlaKPlIqlQyBzxv6BmGcvB3o1t5ikU5+vhAKG8g==` |
| ethereum | 27500 | `sha512-a2u404JduKx1l9ya2rXxUsA5vwyzjwxf2/Pa1CsOLDovIO3gvzZELA52r/BfleDTbQb9aNGpc+hI/vfPCWuZHQ==` |
| ipfs | 12167 | `sha512-tkrvFX7k7EV+YiaAw+nOw1Iu5hFAJ6U6Jbq7uWp0k6bUwsZKYvHQCgTZZMhayUO9wuNbfmvR+MopfUajgL9xvQ==` |
| messages | 16170 | `sha512-dPwfCp5iKvtgQgg6jVGmxrfYSyfBIZXeL/SqaDOCA+whpG1OD/cpYnC4pZXP1MwbyiOwct/88crcP5rotIpXBw==` |

Publication ran from each prepared package directory in dependency order:

    /private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/bin/node /private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/lib/node_modules/npm/bin/npm-cli.js publish . --access public --tag latest --registry=https://registry.npmjs.org/ --ignore-scripts --cache=/private/tmp/oya-release-011-cache --fetch-retries=0 --fetch-timeout=20000

The final registry consumer passed in about 5.1 seconds with zero failures/skips at `/private/var/folders/l4/r069cwsn6gv75xdvj4r28gw40000gn/T/oya-kernel-release-Bwtm7O`. Its `registry-inventory.json` and `registry-consumer-lock.json` copies are retained in the `0.1.1` release directory. The consumer contains only four Oya packages at `0.1.1` and Noble curves/hashes at `2.2.0`. The earlier `oya-kernel-release-NklChi` run stopped on IPFS's pending version listing; no publication was retried. Final registry verification used:

    PATH=/private/tmp/oya-node24.n1cilS/node-v24.21.0-darwin-x64/bin:$PATH OYA_RELEASE_SOURCE=registry OYA_RELEASE_INVENTORY=/Users/johnshutt/Code/oya-kernel-releases/0.1.1/inventory.json npm --prefix packages run test:release

Optional draft for [npm support](https://www.npmjs.com/support), not sent; superseded as a required action by the user-selected `0.1.1` release:

    Subject: Remove local filesystem paths from two published versions' metadata

    I maintain @oyaprotocol/utils@0.1.0 and @oyaprotocol/ethereum@0.1.0
    (npm account pemulis). Publishing reviewed tarballs added my local
    filesystem path to the public _from and _resolved metadata fields.
    Can you redact these two fields on both existing versions, preserving
    the packages, tarballs, integrity hashes, dependencies, and tags?
    The paths are absent from the tarball contents. This request concerns
    registry metadata only; please do not unpublish either release.

## Interfaces and Dependencies

Edits: four manifests/license files, workspace manifest/lockfile, package READMEs, release test, and plans. Preserve kernel implementations; add no dependencies or release framework. Subsequent node work pins releases, removes kernel building from operator setup, and adjusts CI/tests for released dependencies.
