# Automate the first deployment to a Droplet

This ExecPlan follows `PLANS.md`. The user requested a deployment script after the DigitalOcean walkthrough on 2026-09-23.

## Purpose / Big Picture

Replace repetitive first-deployment commands with a small, reviewable SSH workflow. An operator supplies an existing Linux amd64 Droplet with Docker/Compose, a public hostname, and private node settings. The script builds the repository image locally, transfers only deployment files and the image, validates settings, and starts the existing HTTPS stack. No cloud provisioning, DNS changes, key generation, Ledger deployment, or paid transactions are part of this change.

## Progress

- [x] 2026-09-23: Read repository guidance, deployment files, runtime validation, and operator procedures.
- [x] 2026-09-23: Implemented local build/SSH transfer and remote validation/startup helpers with existing-state guards and unique image tags.
- [x] 2026-09-23: All 109 production tests passed, including 15 deployment checks. The Linux amd64 image built; real container configuration/key validation, merged Compose syntax, and restricted Caddy configuration validation passed.
- [x] 2026-09-23: Added the operator guide and README link, inspected the complete proposed change, and recorded validation limits.

## Surprises & Discoveries

- Restarting the signing node clears its in-memory uncertain-transaction guard. The first version must refuse existing stacks instead of silently replacing them or implementing automatic rollback.
- Compose already supports the required private mount, HTTPS routing, persistent volumes, and startup health dependencies. A generated image override avoids changing shared deployment defaults.
- Proxy response and stop deadlines need to follow `operationTimeoutMs`, including configurations above the default three minutes.
- Staging with a private umask also restricts copied public files. Caddy drops filesystem-override capabilities, so its public Caddyfile needs mode 0644; the private directory and node settings remain 0700/0600. The real restricted-container check passed with these permissions.

## Decision Log

- 2026-09-23 / Codex: Limit automation to first deployment on an existing Docker host. This keeps the change reviewable and avoids new cloud credentials or a provisioning framework.
- 2026-09-23 / Codex: Use the existing Compose project name `oya`, a private operator-owned deployment directory, and a unique image tag. Refuse existing deployment files, project containers, or Oya volumes; leave failures available for deliberate recovery.
- 2026-09-23 / Codex: Build locally for Linux amd64 and transfer over verified SSH, so a small Droplet does not perform npm/image builds. No public image registry or remote Git checkout is required.

## Outcomes & Retrospective

The first-deployment workflow and `node/production/deploy-droplet.md` are complete. Existing runtime, Compose defaults, and restart policy are unchanged. The test fixture executes the real shell scripts and configuration/key validator while replacing SSH/Docker commands; it verifies transferred files, secret permissions, shell-input rejection, existing-state guards, deadline calculation, and failure behavior.

The complete production test suite passed 109 checks. A real Linux amd64 image build succeeded; the exact validator ran inside that image without networking and returned `361` seconds for an operation timeout of `300001` milliseconds. The merged Compose model and Caddy configuration with 361/421-second response/stop deadlines also validated. No cloud server, public TLS certificate, real SSH transfer, independent IPFS retrieval, or live-chain publication was tested. Those remain operator deployment checks, not claims made by script completion.

## Context and Orientation

`node/production/compose.yaml` runs Node and Kubo; `docker/compose.http.yaml` adds Caddy. The Dockerfile installs locked dependencies and copies an explicit runtime source set. `src/config.mjs` and `src/signer.mjs` validate private settings. The signing node has `restart: "no"`. Initial deployment must retain that policy and all persistent volumes.

## Plan of Work

Add `scripts/deploy-droplet.sh` for local argument checks, staging, image build/transfer, and remote invocation. Add `scripts/deploy-droplet-remote.sh` for host checks, private configuration validation, deadline calculation, and startup. Document prerequisites, the single command, remaining external verification, and manual recovery in a focused deployment guide linked from the README. Add behavior tests in `test/deploy-droplet.test.mjs` using disposable directories and fake SSH/Docker executables; no live server or funded account is needed.

## Concrete Steps

From the repository root, run `bash -n` on both scripts and `node --test node/production/test/deploy-droplet.test.mjs`. Run the production test suite after focused checks. Validate the generated Compose model and runtime validation command with real Docker when available. Keep all fixture data outside the checkout and remove only resources created by the check.

## Validation and Acceptance

Require a successful simulated first deployment, matching transferred bytes and restrictive secret permissions, no secret values in output, correct deadlines above three minutes, and rejection of invalid arguments/settings or existing deployments. A failed build or transfer must not start services; a failed startup must not destroy volumes or retry the signing node. Distinguish container health from public TLS, independent IPFS retrieval, or successful signed publication. Inspect new and existing proposed documentation and run whitespace checks before handoff.

## Idempotence and Recovery

This is deliberately a first-install command, not an update/restart command. Repeated invocation refuses existing deployment state. Failures retain remote files and any created volumes for inspection. Operators use the existing drain, reconciliation, backup, and restart procedures; the script performs no automatic cleanup of remote state. Local staging is ephemeral and cleaned on exit.

## Artifacts and Notes

Only reusable scripts, tests with generated credentials, and placeholder-based documentation are intended for review. Prior resource-sizing documents remain in the working tree and must be preserved.

Commands that passed: `bash -n` for both deployment scripts, `node --test node/production/test/deploy-droplet.test.mjs`, `npm --prefix node/production test`, and `docker build --platform linux/amd64 --tag oya-node:deployment-check node/production`. Real validation used generated credentials, disposable bind-mounted files, and `docker run --rm --network none`; no daemon service was started by those checks. The temporary validation files were removed after inspection. The local validation image remains available.

## Interfaces and Dependencies

Local dependencies are Bash, Docker with amd64 build support, OpenSSH, and tar. Remote dependencies are a non-root Linux amd64 operator account with Docker access, Compose 2.30+, Bash, and tar. SSH host identity must already be verified. The operator supplies a valid node configuration/key, funded node account, verified Ledger, allowlist, DNS, and firewall rules. No second runtime may use the node signing account.
