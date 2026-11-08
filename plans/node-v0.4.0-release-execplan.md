# Publish node v0.4.0

This ExecPlan follows `PLANS.md` and records release preparation, publication, and verification.

## Purpose / Big Picture

Publish the latest merged code as `node-v0.4.0`, with a matching Linux amd64 container image and deployment bundle. Operators can download the release, verify its checksum and immutable image reference, and use guides that describe the included Sepolia defaults and reliability fixes.

## Progress

- [x] 2026-11-08: Confirmed a clean release branch at main commit `f63f4004b26a02d7909415b48cf34b8682614d7c`, the previous release `node-v0.3.1`, and absence of a v0.4.0 image/release.
- [x] 2026-11-08: Inspected successful source CI run `42423133080`, including every required Docker, HTTPS, IPFS-only, hourly-agent, PostgreSQL recovery, and packaged-worker step.
- [x] 2026-11-08: Updated and reviewed ten release-facing guides/skill references, checked 142 local links, and committed preparation as `4046118`.
- [x] 2026-11-08: Local production suite passed all 278 tests with no failures or skips.
- [x] 2026-11-08: Opened preparation PR #144; push CI `42497492653` and PR CI `42497535863` are running.
- [x] 2026-11-08: Both preparation CI runs passed all seven jobs. Merged PR #144 as `d166c6603d41e19627d41922e7c87fe1a0d988a0` and verified its tree matches the tested preparation commit.
- [x] 2026-11-08: Published annotated tag `node-v0.4.0`; verified the remote tag object matches the local annotation and resolves to the merged source.
- [x] 2026-11-08: Published the Linux amd64 image and matching 28-file deployment bundle, and created the public GitHub Release with all three assets.
- [x] 2026-11-08: Pulled the exact image digest using an empty Docker credential configuration and verified its source/revision/version labels and platform. Anonymous downloads of all three assets matched the generated files byte-for-byte; archive SHA-256 and GitHub asset metadata agree. GitHub identifies node-v0.4.0 as the latest release.

## Surprises & Discoveries

The release version identifies the complete Docker deployment, independently of private npm package versions. The runtime still depends on published kernel packages; its direct API and inbox enforce the new NUL restriction locally, so this release does not require a separate npm publication. At the start, guides pointed to v0.3.1 and warned that Sepolia defaults were unreleased; preparation aligned those statements with v0.4.0 before packaging.

The first local test run passed 277 tests and failed one assertion expecting empty npm stderr because the installed npm prints startup notices. Running with `npm_config_loglevel=error` suppresses those notices while retaining test failures; the completed run passed all 278 tests. Local HTTP fixtures require loopback socket access outside the sandbox. A skill-validator dependency installation was abandoned after the user questioned the unnecessary Python tooling; the one-paragraph documentation edit was reviewed directly and its links checked.

## Decision Log

- Decision: Publish `node-v0.4.0` using the existing maintainer workflow and preserve private npm package versions. Rationale: The user explicitly requested 0.4.0, and `node/production/release-image.md` defines the repository's deployment release convention. Date/Author: 2026-11-08 / Codex.
- Decision: Use successful source and preparation CI for container integration coverage, plus local production tests. Rationale: CI exercises disposable Linux services and all mandatory publication paths without changing installed nodes. Date/Author: 2026-11-08 / Codex.
- Decision: Keep publication records in this checkout and publish from an isolated clean checkout. Rationale: The publisher requires a clean tagged source; this living document must remain editable after tagging. Date/Author: 2026-11-08 / Codex.

## Outcomes & Retrospective

Published node-v0.4.0 with its matching Linux amd64 image, deployment archive, image pin, and source record. All 278 local production tests and both seven-job preparation CI runs passed. PR #144 is merged, the annotated tag points to its resulting commit, and the release source tree matches the tested preparation commit.

All 28 bundle files match tagged source or the generated image pin and have public read permissions. Anonymous GitHub downloads matched the three generated assets byte-for-byte, and the exact GHCR image was pulled without credentials. Its labels identify v0.4.0 and the correct source commit. Publication is complete; installed-node upgrades remain separate operator actions.

## Context and Orientation

`node/production/scripts/publish-image.sh` builds a Git archive of tagged production source, pushes a Linux amd64 image to `ghcr.io/oyaprotocol/oya-node`, and writes three public assets: `image.txt`, `release.txt`, and `oya-node-v0.4.0.tar.gz`. The archive includes Compose files, configuration examples, operator guides, the Keychain helper, and the hourly test agent. Docker's build metadata supplies the immutable digest. `node/production/release-image.md` defines release policy; `.github/workflows/test.yml` supplies required checks. The canonical GitHub repository is `oyaprotocol/oya-commitments`.

Since v0.3.1, merged changes add Sepolia defaults, durable receipt identity verification, stricter message/request/response validation, bounded client reads and waits, monotonic request budgets, logger isolation, and frontend dependency fixes. The peer-node network document is a future implementation plan, not a shipped networking feature.

## Plan of Work

Update current download links and descriptions in the root and production guides to v0.4.0. Preserve historical compatibility instructions where useful. Explain default changes, explicit IPFS mode, stricter input validation, and preservation of existing execution identities. Review and test these changes, then commit, push, and merge preparation through a PR. Tag the merged source without moving existing tags. Publish once into a fresh external output directory, inspect all artifacts, and create a GitHub Release with exact source/image identities and archive checksum. Verify public access before declaring success.

## Concrete Steps

From the repository root, run `npm --prefix node/production test` and `git diff --check`. Review changes since `node-v0.3.1` and the preparation diff. Inspect GitHub Actions jobs and step conclusions for the release source with `gh api repos/oyaprotocol/oya-commitments/actions/runs/RUN_ID/jobs`, replacing `RUN_ID` with the relevant run.

After preparation is merged, create an annotated `node-v0.4.0` tag on that commit and push it to the canonical repository. From an isolated clean checkout of that tag, with `RELEASE_OUTPUT` pointing to a new external directory whose parent exists, run:

    bash node/production/scripts/publish-image.sh ghcr.io/oyaprotocol/oya-node node-v0.4.0 "$RELEASE_OUTPUT"
    shasum -a 256 "$RELEASE_OUTPUT/oya-node-v0.4.0.tar.gz"

Inspect archive contents, permissions, and image labels. Write reviewed release notes to an external file and create the GitHub Release using `gh release create --repo oyaprotocol/oya-commitments node-v0.4.0 --target RELEASE_COMMIT --notes-file NOTES_FILE` with the three generated assets, replacing the named placeholders with actual values. Check installed CLI flags before use. Download public assets without credentials and compare exact bytes. Verify the exact image digest anonymously.

## Validation and Acceptance

Require production unit tests and the repository CI jobs, including PostgreSQL recovery, both packaged worker modes, direct publication/lifecycle, HTTPS deadlines, hourly-agent and IPFS-only checks, and arm64 cross-build. Publish only Linux amd64; cross-building alone does not establish arm64 runtime support. Inspect all source changes, release notes, and bundle files for sensitive material and local-only references before publication.

Success means the public GitHub release has all three matching assets, notes identify the reviewed source and checksum, the annotated tag resolves to that source, and anonymous consumers can retrieve identical assets and the exact GHCR image. Confirm its OCI source/revision/version labels and platform. Publishing this release does not upgrade an installed node.

## Idempotence and Recovery

Never move an existing release tag, reuse a published image version for different contents, or overwrite old release assets. Inspect registry and output after failure because the push may already have succeeded. Preserve original digest records and partial output. Keep existing installations, credentials, databases, and volumes intact. A missing credential or publication permission is a blocker to report without exposing sensitive values.

## Artifacts and Notes

Baseline CI: https://github.com/oyaprotocol/oya-commitments/actions/runs/42423133080. All seven jobs and mandatory integration steps passed.

Preparation PR: https://github.com/oyaprotocol/oya-commitments/pull/144. Preparation commit: `4046118788ebc5b787fcc54c94b52339f7825394`. Push CI: https://github.com/oyaprotocol/oya-commitments/actions/runs/42497492653. PR CI: https://github.com/oyaprotocol/oya-commitments/actions/runs/42497535863.

Published release: https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.4.0.

Release source: `d166c6603d41e19627d41922e7c87fe1a0d988a0`. Annotated tag object: `aeb8eba58c39fd1e82994616abec0468e86e45cf`.

Image: `ghcr.io/oyaprotocol/oya-node@sha256:e4b110bffb994c5fe6af013d4d10e9d2962696b415bfdfec7f63f0c359e3fe17`.

Archive: `oya-node-v0.4.0.tar.gz`, 73,289 bytes. SHA-256: `06d96488285dbf92c85a0c2bfe420a9f08b355a78fc43a5e5a431a259872cba9`. Companion assets are `image.txt` (101 bytes) and `release.txt` (182 bytes). These immutable assets are published; the commands above document the completed workflow and must not be used to republish this version.

## Interfaces and Dependencies

Use Git, Node.js 24, npm, Python 3 for Keychain tests, Docker Buildx with Linux amd64 support, GitHub CLI, and existing GitHub/GHCR authentication. Credentials stay in their existing stores. This task publishes release artifacts and requires no cloud provisioning, contract deployment, or live-chain transactions.
