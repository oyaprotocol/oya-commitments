# Automate the first deployment to a Droplet

This ExecPlan follows `PLANS.md`. The user requested a deployment script after the DigitalOcean walkthrough on 2026-09-23.

## Purpose / Big Picture

Replace repetitive first-deployment commands with a small, reviewable SSH workflow. An operator supplies an existing Linux amd64 Droplet with Docker/Compose, a public hostname, and private node settings. The original local build/transfer flow now uses a public image identified by its SHA-256 digest (an immutable identifier of the image contents). A maintainer publishes a tagged Git revision and a matching deployment bundle; operators transfer only deployment files and private settings, and the host pulls the pinned image. No cloud provisioning, DNS changes, key generation, Ledger deployment, or paid transactions are part of this change.

## Progress

- [x] 2026-09-23: Read repository guidance, deployment files, runtime validation, and operator procedures.
- [x] 2026-09-23: Implemented local build/SSH transfer and remote validation/startup helpers with existing-state guards and unique image tags.
- [x] 2026-09-23: All 109 production tests passed, including 15 deployment checks. The Linux amd64 image built; real container configuration/key validation, merged Compose syntax, and restricted Caddy configuration validation passed.
- [x] 2026-09-23: Added the operator guide and README link, inspected the complete proposed change, and recorded validation limits.
- [x] 2026-09-24: Added 128 random bits to deployment tags. The matching-timestamp/PID regression reproduced the old collision and now passes, alongside failed/short entropy checks. All 18 deployment tests and 112 production tests passed.
- [x] 2026-09-28: Read current scripts, release/build configuration, and official Docker/GHCR documentation for the registry follow-up.
- [x] 2026-09-28: Added the maintainer publisher using a clean tagged revision, Buildx's returned digest, and a matching deployment bundle.
- [x] 2026-09-28: Switched first deployment to a validated GHCR digest and remote pull, retaining existing safety checks and private-file permissions.
- [x] 2026-09-28: All 124 production tests passed, including 30 deployment/publication checks. Shell syntax, real Compose merging, real Buildx metadata, and a restricted non-root container source-load check passed. Documented releases, version control, and deliberate upgrades.

## Surprises & Discoveries

- Restarting the signing node clears its in-memory uncertain-transaction guard. The first version must refuse existing stacks instead of silently replacing them or implementing automatic rollback.
- Compose already supports the required private mount, HTTPS routing, persistent volumes, and startup health dependencies. A generated image override avoids changing shared deployment defaults.
- Proxy response and stop deadlines need to follow `operationTimeoutMs`, including configurations above the default three minutes.
- Staging with a private umask also restricts copied public files. Caddy drops filesystem-override capabilities, so its public Caddyfile needs mode 0644; the private directory and node settings remain 0700/0600. The real restricted-container check passed with these permissions.
- Timestamp/PID image tags can collide across laptops. Image loading happens before the directory claim, so a losing installer could replace the winning installer's tagged image; the directory guard alone does not protect image identity.
- Registry tags are mutable. Buildx's build-result metadata supplies the digest for the actual publication; looking up a tag afterward could capture another publisher's result. GHCR packages must explicitly be made public for anonymous operator pulls.
- A plain Git archive extraction under `umask 077` reproduced mode 0600 source files, which Docker would copy as root-owned files unreadable by the runtime user. The publisher sets archive modes with `tar.umask=0022` and preserves them during extraction. The staging parent remains private. A real image built this way loaded the source and dependencies as non-root with networking disabled and all capabilities dropped.

## Decision Log

- 2026-09-23 / Codex: Limit automation to first deployment on an existing Docker host. This keeps the change reviewable and avoids new cloud credentials or a provisioning framework.
- 2026-09-23 / Codex: Use the existing Compose project name `oya`, a private operator-owned deployment directory, and a unique image tag. Refuse existing deployment files, project containers, or Oya volumes; leave failures available for deliberate recovery.
- 2026-09-23 / Codex: Build locally for Linux amd64 and transfer over verified SSH, so a small Droplet does not perform npm/image builds. No public image registry or remote Git checkout is required.
- 2026-09-24 / Codex: Add 128 random bits from `/dev/urandom` to each image tag, generated once and reused for build, save, and Compose. Reject failed or short entropy reads before building. This closes the cross-host collision risk while retaining the atomic directory guard.
- 2026-09-28 / Codex: Replace local builds in the operator installer with digest-only GHCR pulls. Keep Linux amd64 support, first-install guards, and manual recovery. Publish with an explicit maintainer script, not an automatic workflow, to keep this review bounded.
- 2026-09-28 / Codex: Use `node-vMAJOR.MINOR.PATCH` Git tags independently of npm package versions. Require the tag at a clean HEAD and archive its committed runtime; package matching public deployment files and `image.txt` as release assets outside Git. Never publish private settings or invent a digest before a real push.

## Outcomes & Retrospective

The first-deployment workflow and `node/production/deploy-droplet.md` are complete. Existing runtime, Compose defaults, and restart policy are unchanged. The test fixture executes the real shell scripts and configuration/key validator while replacing SSH/Docker commands; it verifies transferred files, secret permissions, shell-input rejection, existing-state guards, deadline calculation, and failure behavior.

The complete production test suite passed 109 checks. A real Linux amd64 image build succeeded; the exact validator ran inside that image without networking and returned `361` seconds for an operation timeout of `300001` milliseconds. The merged Compose model and Caddy configuration with 361/421-second response/stop deadlines also validated. No cloud server, public TLS certificate, real SSH transfer, independent IPFS retrieval, or live-chain publication was tested. Those remain operator deployment checks, not claims made by script completion.

The 2026-09-24 review fix makes image tags collision-resistant across laptops. Its regression fixes the clock and uses two sourced subshells sharing `$$`; it failed against the original tag and now verifies distinct random suffixes with consistent build/save/Compose references. Failed and short random reads stop before building. Shell syntax, whitespace checks, all 18 deployment checks, and the full 112-test production suite passed. No live deployment was performed for this fix.

The 2026-09-28 registry follow-up replaces per-operator builds and random deployment tags with digest-only remote pulls. `publish-image.sh` builds a clean tagged source archive and emits the matching installer bundle, image pin, and Git revision record. Publishing and registry failures are simulated in tests with real Git archives; operators still supply private settings and an existing Docker host. New guidance explains manual GHCR publication/visibility, Git tags, release assets outside source control, and controlled image upgrades.

All 124 production tests passed after the source-permission fix. Real Compose 2.31 merged the override with the exact digest and no build section; a real Linux amd64 Buildx build returned valid digest metadata, and its non-root runtime read/imported the source in a read-only, network-disabled, capability-restricted container. No registry push, Git tag/push, GitHub Release, cloud deployment, or live transaction was performed. The first public release and anonymous digest pull remain maintainer operations described in `node/production/release-image.md`.

## Context and Orientation

`node/production/compose.yaml` runs Node and Kubo; `docker/compose.http.yaml` adds Caddy. The Dockerfile installs locked dependencies and copies an explicit runtime source set. `src/config.mjs` and `src/signer.mjs` validate private settings. The signing node has `restart: "no"`. Initial deployment must retain that policy and all persistent volumes.

## Plan of Work

The original two deployment scripts and tests already exist. Add `node/production/scripts/publish-image.sh IMAGE_REPOSITORY RELEASE_TAG OUTPUT_DIRECTORY` to publish an archived, committed runtime with source/revision/version labels and produce `image.txt`, a release record, and a small deployment archive. Use `docker buildx build --push --metadata-file` and read the returned digest with Node.js. The output directory must be new, outside the checkout, and its parent must exist.

Modify `scripts/deploy-droplet.sh` to accept an optional fifth digest reference, otherwise read `image.txt` from the bundle. Reject unpinned or unsafe references before SSH. Generate an override removing the local Compose build, and have `scripts/deploy-droplet-remote.sh` pull the node before offline settings validation. Update deployment tests and add `test/publish-image.test.mjs` with a disposable real Git repository and a fake Docker executable. Document maintainer releases in `release-image.md`, update the installer guide, and link both from the README.

## Concrete Steps

From the repository root, run `bash -n` on all three scripts and `node --test node/production/test/deploy-droplet.test.mjs node/production/test/publish-image.test.mjs`, then `npm --prefix node/production test`. Validate that real Compose merges the digest override with no build section. Publishing later requires a reviewed/tagged commit, Docker registry login, and `bash node/production/scripts/publish-image.sh ghcr.io/oyachat/oya-node node-v0.1.0 "$HOME/oya-releases/node-v0.1.0"` (example first version; the parent directory must exist). Do not run a public push or live deployment as a test.

## Validation and Acceptance

Require a successful simulated publication and deployment from its bundle, matching digest and Git revision, exclusion of ignored/private files, restrictive secret permissions, no secret values in output, correct deadlines above three minutes, and rejection of invalid arguments/settings or existing deployments. A failed publication must not produce a deployable bundle; a failed pull or transfer must not start services. Dirty/untagged publication inputs and mutable deployment tags must fail. Failed startup must not destroy volumes or retry the signing node. Distinguish mocked registry tests and real Compose validation from actual public publication, anonymous pulls, public TLS, and signed-message operation.

## Idempotence and Recovery

This is deliberately a first-install command, not an update/restart command. Repeated invocation refuses existing deployment state. Failures retain remote files and any created volumes for inspection. Operators use the existing drain, reconciliation, backup, and restart procedures; the script performs no automatic cleanup of remote state. Local staging is ephemeral and cleaned on exit.

Publishing is an explicit public operation. Serialize releases, never move an existing Git/image version tag, and retain old digests for deliberate rollback. A failure after pushing can leave an image in GHCR without a completed local bundle; inspect that state before proceeding and use a fresh version for another build. Upgrades must stop public admission, drain/reconcile the signing node, and retain all volumes and private settings.

## Artifacts and Notes

Only reusable scripts, tests with generated credentials, and placeholder-based documentation are intended for review. Resource-sizing guidance is unchanged.

Commands that passed: `bash -n` for both deployment scripts, `node --test node/production/test/deploy-droplet.test.mjs`, `npm --prefix node/production test`, and `docker build --platform linux/amd64 --tag oya-node:deployment-check node/production`. Real validation used generated credentials, disposable bind-mounted files, and `docker run --rm --network none`; no daemon service was started by those checks. The temporary validation files were removed after inspection. The local validation image remains available.

Registry follow-up validation additionally covered `bash -n node/production/scripts/publish-image.sh`, the publisher test file, a local Buildx build with `--load --metadata-file` instead of `--push`, and a real Compose JSON model inspected without printing environment values. Disposable archive/metadata files were removed. The local image `oya-node:registry-permissions-check` remains available; it is a validation artifact, not a published release pin.

## Interfaces and Dependencies

Operator laptop dependencies become Bash, OpenSSH, and tar. Maintainer publishing needs Git, Node.js 24, Docker/Buildx with Linux amd64 build support, and GHCR publishing credentials. Remote dependencies remain a non-root Linux amd64 operator account with Docker access, Compose 2.30+, Bash, and tar, plus outbound registry access. SSH host identity must already be verified. The operator supplies a valid node configuration/key, funded node account, verified Ledger, allowlist, DNS, and firewall rules. No second runtime may use the node signing account.
