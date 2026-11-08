# Automate node releases

This ExecPlan follows `PLANS.md` and records implementation and validation of a single release workflow.

## Purpose / Big Picture

A maintainer can start the GitHub Actions **Release node** workflow with a version such as `0.4.1`. It validates the selected source using existing CI, creates the annotated tag, publishes the Linux amd64 image and deployment bundle, generates release notes and a checksum, and verifies public access. A dry run exercises building and packaging without publishing. Existing node installations are upgraded separately by their operators.

## Progress

- [x] 2026-11-08: Inspected the existing publisher, packaging tests, release policy, CI, and version-specific deployment guides; created a branch from released main.
- [x] 2026-11-08: Implemented workflow coordination, API/registry preflight, immutable tag/publication flow, draft asset verification, anonymous checks, and retained recovery metadata using Node.js/Docker.
- [x] 2026-11-08: Removed routine documentation version edits; generated bundles pin download commands and links to their own tag.
- [x] 2026-11-08: All 293 production tests passed locally. After adding exact-source CI reuse and final documentation edits, all 29 release tests passed with no failures or skips, including success, rejection, and partial-failure paths. YAML and Bash syntax checks passed and 137 local documentation links resolved.
- [x] 2026-11-08: Reviewed the implementation and left all changes unstaged for the maintainer, as requested. No automation PR, commit, or remote workflow run was created.
- [ ] After the maintainer lands the changes: complete GitHub CI and run the new workflow in preview mode without publishing a version.

## Surprises & Discoveries

The image publisher already builds only clean tagged Git source and records the build digest. It deliberately leaves tagging, release creation, notes, checksums, and verification to callers. Existing CI can be exposed through `workflow_call` and reused without copying its seven jobs. GitHub's built-in workflow token can publish packages when the repository has write access to the existing GHCR package; package access is a one-time prerequisite.

The local GitHub CLI token cannot inspect GHCR package permissions: the package API returns HTTP 403 requiring `read:packages`. Public image access is already established. Actual workflow write access remains an installation prerequisite to document rather than testing by publishing an unrequested release.

## Decision Log

- Decision: Add an explicitly dispatched release workflow and reuse the current CI and publisher. Rationale: One operator action replaces routine coordination while retaining tested release gates. Date/Author: 2026-11-08 / Codex.
- Decision: Use Node.js built-ins for release logic and tests, with no new Python dependencies. Rationale: Node.js is already part of the release toolchain, and the user specifically questioned unnecessary tooling. Date/Author: 2026-11-08 / Codex.
- Decision: Serialize releases and refuse existing versions, preserving partial output as workflow artifacts. Rationale: A retry must never overwrite an image or tag after a partially successful publication. Date/Author: 2026-11-08 / Codex.
- Decision: Keep source guides linked to the latest release and resolve a download tag once; render exact tag references into the generated bundle. Rationale: Future releases need no version-only documentation PR, while old bundles remain internally consistent. Date/Author: 2026-11-08 / Codex.
- Decision: Reuse a successful completed push run of the existing CI workflow only when its full source SHA matches. Otherwise call the full reusable workflow. Rationale: Avoid redundant tests while preserving source-specific validation; failed, skipped, incomplete, and PR-only runs do not satisfy this check. Date/Author: 2026-11-08 / Codex.
- Decision: Leave staging, committing, and landing the changes to the maintainer. Rationale: The user explicitly requested this during final review. Date/Author: 2026-11-08 / Codex.

## Outcomes & Retrospective

Implementation and local validation are complete, and the changes remain unstaged for the maintainer. GitHub CI and a hosted preview remain after the changes land; workflow token access to the existing GHCR package must also be confirmed. No new deployment release is authorized or needed to test this change.

## Context and Orientation

`.github/workflows/test.yml` holds the existing CI jobs. `node/production/scripts/publish-image.sh` builds a Linux amd64 container from tagged source and emits `image.txt`, `release.txt`, and a versioned archive. Its focused tests use a real temporary Git repository and a simulated Docker command. `node/production/release-image.md` documents the current manual process. Operator download instructions live in `run-locally.md` and `host-inbox.md`; other entry points and the deployment skill currently name a fixed current version. The untracked v0.4.0 release record from the preceding task must be preserved separately.

## Plan of Work

Add `workflow_call` to existing CI and a `release-node.yml` workflow with version/dry-run inputs, read-only preflight and CI jobs, and a narrowly permissioned publication job. Pin every job to the dispatch source. Add a Node.js coordinator for validation, tag/release APIs, artifact identities, generated notes, and anonymous verification. Extend the existing publisher with a local-only dry run and preserve build metadata on failure. Keep source guides version-independent and render bundled guide links and download variables to the selected tag.

Add tests using controlled GitHub/registry responses and disposable Git/filesystem fixtures. Verify rejection of invalid or reused versions, unexpected authorization/network failures, source mismatches, artifact mismatches, and partial-publication failures. Validate YAML with available tooling. Review all changed source, tests, docs, and plans, then hand off the unstaged changes. The maintainer will land them and run CI and a hosted preview.

## Concrete Steps

From the repository root, run the focused release tests with `node --test node/production/test/publish-image.test.mjs node/production/test/release-node.test.mjs`, then the production suite with `npm --prefix node/production test`. Use `git diff --check` and review the complete diff. Existing npm startup notices may require `npm_config_loglevel=error` for the CLI test that asserts empty stderr; this preserves test failures. Test servers need loopback socket access.

Use a new output directory outside Git for any preview build. After merge, a maintainer runs `gh workflow run release-node.yml --ref main -f version=NEXT_VERSION -f dry_run=true` for a preview or omits `dry_run` to publish. Replace `NEXT_VERSION` with an unused stable semantic version. Do not create a real release merely to validate automation.

## Validation and Acceptance

Success means the release workflow reuses all existing CI, builds the exact tested source, publishes only on explicit dispatch from main, refuses existing version state, and exposes matching public assets and digest records. Dry runs must have no remote writes. Generated archives must retain public permissions, preserve historical compatibility text, and use their own release in download commands. A failed push/upload must retain evidence and must never trigger automatic rebuilding or overwriting of that version.

Local tests must exercise observable command/API effects and failures. CI must pass on the proposed changes. Document any package permission that cannot be established without an actual publication. Check all intended review content for secrets and developer-specific paths before handoff.

## Idempotence and Recovery

Never move existing release tags or replace a published version. Concurrency prevents this workflow from publishing two releases simultaneously. Preflight treats only explicit HTTP 404 responses as absent state; authorization and transport failures stop publication. Failed jobs retain public artifacts/build metadata for inspection. Reuse those original artifacts for exceptional recovery rather than rebuilding an already-pushed version. Public verification can be rerun without mutations.

## Artifacts and Notes

Reference implementation starts from release commit `d166c6603d41e19627d41922e7c87fe1a0d988a0`. Record validation results and the automation PR here as work progresses.

## Interfaces and Dependencies

Use GitHub Actions, its repository token, Node.js 24, Docker Buildx, Git, Bash, and tar. CI retains its existing Foundry/PostgreSQL/Kubo dependencies. GitHub API calls use the repository token only for GitHub hosts; registry/download verification uses anonymous access. Publication needs `contents: write` and `packages: write`; validation needs only read access. No new personal token, Python package, cloud resource, or blockchain transaction is required.
