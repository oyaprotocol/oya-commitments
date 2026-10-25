# Publish the node v0.3.1 image and deployment bundle

This ExecPlan follows `PLANS.md` and records the authorized release through publication and anonymous verification.

## Purpose / Big Picture

Publish a new deployment release containing the improved onboarding guides and macOS Keychain worker helper. A new operator should download one version's image and bundle and follow instructions that refer to that same version. Existing installations retain their recorded image digest until deliberately upgraded.

## Progress

- [x] 2026-10-25 20:43Z: Confirmed onboarding PR #123 is merged, selected patch version `node-v0.3.1`, and created an isolated release branch from merged main commit `41172e7e774e14f0a60dcffbfe7c6f39304cd1dc`.
- [x] 2026-10-25 20:48Z: Prepared version-consistent guides in commit `d19864cacd919b643a99d7063b5cf8de2808c5eb` and opened release-preparation PR #124. All 14 focused packaging/Keychain checks and 103 local links passed; source review found no sensitive material.
- [x] 2026-10-25 21:00Z: Both preparation CI runs passed all seven jobs. Merged PR #124 using the organization-admin path explicitly allowed by the main-branch ruleset. Verified the merged source tree matches the tested preparation commit.
- [x] 2026-10-25 21:00Z: Created and pushed annotated tag `node-v0.3.1` at `00c0d841a5244bdf76701575186396f4e846822e`.
- [x] 2026-10-25 21:02Z: Published the matching image, inspected all 27 bundle files and public permissions, and verified an anonymous pull of the exact image digest and its release labels.
- [x] 2026-10-25 21:03Z: Published the GitHub Release and verified anonymous downloads of all three assets byte-for-byte, including the archive checksum and release-note identities. GitHub reports v0.3.1 as the latest public release.

## Surprises & Discoveries

The source was already committed and merged when this task began. Node runtime source, dependency manifests, and Dockerfile are unchanged since v0.3.0. Changes concern guides, host helpers, packaging, and test infrastructure. The publisher still builds and publishes a matched image/bundle and labels the image with the release commit.

At the start, the guides downloaded v0.3.0 and described its missing Keychain helper. Publishing them unchanged would have directed new operators back to the older bundle, so release preparation updated those references. The root README itself is a repository directory; the operator guides shipped under `node/production/` provide the bundle's setup path.

The installed GitHub CLI does not support `gh release create --verify-tag` or `--latest`. The first invocation failed at argument parsing without creating a release. The remote annotated tag object was then compared with the local tag, its source commit was verified, and publication used supported flags with an explicit `--target` commit. The releases/latest endpoint confirmed the resulting release selection.

## Decision Log

- Decision: Publish `node-v0.3.1` through the existing image-and-bundle workflow.
  Rationale: These are compatible operator improvements; the user authorized a new bundle release following the matching-image proposal.
  Date/Author: 2026-10-25 / Codex.
- Decision: Prepare release-specific documentation in an isolated branch, keeping this living record in the original checkout.
  Rationale: The publisher requires a clean tagged checkout. The plan can continue recording publication results without modifying the immutable release source.
  Date/Author: 2026-10-25 / Codex.
- Decision: Record the newly generated image digest and archive checksum in GitHub release notes and assets rather than predict them in tagged source.
  Rationale: Build output does not exist until after the source commit is tagged. The bundle's `image.txt` and release's `release.txt` are authoritative records; documentation links to the exact release for checksum verification.
  Date/Author: 2026-10-25 / Codex.

## Outcomes & Retrospective

Published node-v0.3.1 with a matching Linux amd64 image, deployment archive, image pin, and source record. The preparation updates all download instructions to v0.3.1, moves checksum verification before extraction, and explains the included Keychain helper and v0.3.0 compatibility. Both push and PR CI passed all seven jobs, and all 14 focused local checks passed. PR #124 is merged and the matching annotated tag is published.

The archive contains exactly the 27 expected public files, with readable files and traversable directories. Anonymous GitHub downloads matched all three local artifacts byte-for-byte; the release notes and GitHub asset metadata agree with the computed archive SHA-256. An exact-digest image pull with an empty Docker credential configuration succeeded, and image inspection confirmed Linux amd64 plus the expected source, version, and revision labels. No running node, inbox database, credentials, or persistent volumes were changed. Publication is complete; installing an update is a separate operator action.

## Context and Orientation

`node/production/scripts/publish-image.sh` requires a clean HEAD matching an annotated `node-vMAJOR.MINOR.PATCH` tag. It builds committed source for Linux amd64, pushes `ghcr.io/oyaprotocol/oya-node:vMAJOR.MINOR.PATCH`, and writes `image.txt`, `release.txt`, and `oya-node-vMAJOR.MINOR.PATCH.tar.gz` outside the checkout. The bundle includes the local worker/inbox Compose files, guides, and Keychain helper. It contains public deployment assets, never operator credentials or state.

`node/production/release-image.md` specifies validation and release policy. `.github/workflows/test.yml` runs production unit tests, PostgreSQL recovery, both packaged inbox modes, direct publication/lifecycle, HTTPS deadlines, hourly-agent and IPFS-only flows on Linux amd64, plus an arm64 cross-build. A successful cross-build is not a tested arm64 release image.

The release repository is `oyaprotocol/oya-commitments`. The original checkout's origin URL uses a historical organization redirect, so remote writes for this task use the canonical repository explicitly. `skills/deploy-node/SKILL.md` governs live node deployment; this task publishes artifacts and does not modify the running installation or its cloud resources.

## Plan of Work

Update release-facing guides to v0.3.1, retain accurate v0.3.0 compatibility notes, and make the included Keychain helper discoverable from an extracted bundle. Use the exact GitHub Release for the generated checksum, leaving the old release and its assets untouched. Review source and packaging for private material and verify bundled links and modes.

Run the existing focused packaging/Keychain tests locally. Use successful CI on the release source for the mandatory Docker/HTTPS/PostgreSQL checks; inspect step results, not just an aggregate badge. Commit and merge the preparation after review and checks. Tag the resulting reviewed source without force updates.

Run the publisher once into a new protected output directory. If a failure occurs, inspect registry and output before retrying. Inspect the generated archive inventory, image metadata, and release records. Calculate the archive SHA-256 and prepare concise release notes with scope, verification, and compatibility information. Upload the three public assets to a GitHub Release for the same tag, then verify anonymous downloads and image access.

## Concrete Steps

From the isolated release checkout, run `node --test node/production/test/publish-image.test.mjs node/production/test/keychain-worker.test.mjs` and `git diff --check`. Read the complete preparation diff. GitHub check results are available through `gh api repos/oyaprotocol/oya-commitments/commits/COMMIT/check-runs`; inspect relevant run/job steps for the source commit.

After merge and validation, create and push the annotated `node-v0.3.1` tag. From its clean checkout, with the release output parent already present:

    bash node/production/scripts/publish-image.sh ghcr.io/oyaprotocol/oya-node node-v0.3.1 "$RELEASE_OUTPUT"

`RELEASE_OUTPUT` must be a new directory outside the checkout. Read only the generated public records, list and inspect the archive, and compute `shasum -a 256 "$RELEASE_OUTPUT/oya-node-v0.3.1.tar.gz"`. Verify the remote annotated tag object and source commit before publication. Store exact notes in a file and use `gh release create --repo oyaprotocol/oya-commitments node-v0.3.1 --target 00c0d841a5244bdf76701575186396f4e846822e --notes-file NOTES_FILE` with the three reviewed assets and a release title. Do not put credentials in commands or notes. This release now exists; these commands document the completed workflow, not an instruction to republish it.

## Validation and Acceptance

Require passing production tests, packaging and Keychain lifecycle tests, PostgreSQL persistence/recovery and packaged worker tests, Linux amd64 direct/HTTPS/IPFS-only/hourly checks, and the existing arm64 build check. CI can establish these without re-running identical tests against a live installation.

Before publication, inspect committed release changes, archive inventory and contents, and generated notes for secrets, private endpoints, developer-specific paths, and local-only dependencies. Confirm the build output digest is the one in both public records and bundle. Verify OCI source/revision/version labels and Linux amd64 platform.

After publication, download all assets without GitHub credentials, compare their bytes and archive checksum with the originals, and verify the exact GHCR digest with anonymous access. Confirm the new helper and current guides are present. The final handoff must include the release link and distinguish publication from an installed-node upgrade.

## Idempotence and Recovery

Never reuse a published version for different contents, move a tag, overwrite old assets, or delete an image in use. Query for partial success after any publication failure. Keep the output directory and original build digest. Preserve the running node, PostgreSQL state, local IPFS volume, and credential stores. If required credentials are unavailable, retain prepared artifacts and report the specific blocked action without exposing secrets.

## Artifacts and Notes

Published release: https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.1. Public assets are `image.txt`, `release.txt`, and `oya-node-v0.3.1.tar.gz` (66,494 bytes). The archive contains public deployment assets, without operator credentials or private runtime configuration.

Image: `ghcr.io/oyaprotocol/oya-node@sha256:90ffeae9d2b1231e5ffb12020d5589159e18716b2a823bb077a6073c590557be`.

Archive SHA-256: `0187e24f84e9fce14dc3392b50d47a77506ab40becaf23e62ec7044de0ed1efa`.

Preparation PR: https://github.com/oyaprotocol/oya-commitments/pull/124. Preparation push CI: https://github.com/oyaprotocol/oya-commitments/actions/runs/40232292246. PR CI: https://github.com/oyaprotocol/oya-commitments/actions/runs/40232382848. The image version was absent from GHCR before this publication attempt.

Release source: `00c0d841a5244bdf76701575186396f4e846822e`, with the same tree as tested preparation commit `d19864cacd919b643a99d7063b5cf8de2808c5eb`. The normal merge was rejected because the main ruleset restricts updates to organization administrators; its configured bypass explicitly allows that role, and the authenticated account's active administrator membership was verified. No test or review requirement was skipped, and no branch rule was changed.

## Interfaces and Dependencies

Use Git, Node.js 24, Python 3 for the host-helper tests, Docker Buildx with Linux amd64 support, and authenticated GitHub/GHCR access already available to the operator. Credentials are consumed through their existing tooling and never printed. Release preparation changes documentation only unless validation identifies a concrete packaging defect. No cloud-provider or blockchain credentials are needed.
