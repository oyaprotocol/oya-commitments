# Add an optional hourly cloud test agent

This ExecPlan is maintained according to `PLANS.md`.

## Purpose / Big Picture

An operator can enable the Compose `testing` profile when installing a Sepolia node on a Droplet. A small, independent agent signs a generated text message immediately after node health succeeds, then starts another message once per hour. Its signing key is generated on the server and its public address is added to the deployed node configuration. The operator supplies no local agent key or message file. The existing funded node account still pays Ledger gas.

## Progress

- [x] 2026-09-29 01:22Z: Read deployment, image packaging, Compose, and repository instructions. Selected a standalone test sender and an optional deployment flag.
- [x] 2026-09-29 01:27Z: Implemented the agent, private initialization, and module tests. Native arm64 Docker publication passed against Anvil/Kubo in 23 seconds.
- [x] 2026-09-29 01:28Z: Connected the optional profile to installation and release bundles; documented operation/recovery. All 33 deployment and release tests passed.
- [x] 2026-09-29 01:31Z: All 132 host tests passed. The final internal-network profile passed its module suite and real amd64 Docker publication under emulation in 28 seconds. Shell syntax and whitespace checks passed; the amd64 fixture was added to CI.

## Surprises & Discoveries

The published node image includes Node.js and ethers but excludes scripts. The agent can use that same pinned image with its reviewed source mounted read-only from the matching deployment bundle. This avoids a second image and changes to the node runtime. Repository locality rules place its source under `agent-library/agents/hourly-message-test/`. It is a test fixture, not a commitment or an existing agent-runner module; no commitment metadata, Safe, governor, LLM, or shared agent runner is involved. The key can be generated with Docker networking disabled. Module tests resolve ethers inside the node image instead of adding another dependency installation to the host agent library.

## Decision Log

- 2026-09-29 / Codex: Keep all behavior in one standalone agent module; use the node image's existing ethers dependency. Ship the public source in the release bundle and mount it read-only.
- 2026-09-29 / Codex: Use a separate internal `testing` Docker network shared only with the node, a separate persisted agent key, and no public agent port. Initialize only the deployed copy of node settings. Support Sepolia and disposable Anvil; reject mainnet setup.
- 2026-09-29 / Codex: Send immediately on explicit start and schedule subsequent starts an hour apart without overlap or catch-up bursts. Stop on unconfirmed publication; disable automatic restart. An explicit restart begins a new run and can send immediately.
- 2026-09-29 / Codex: Add `--with-test-agent` as the installer's optional first argument. Existing installation behavior stays opt-in; no live cloud deployment or registry publication is part of this work.

## Outcomes & Retrospective

The standalone agent, Compose overlay, deployment flag, packaging, and operator instructions are complete. The normal installation path still transfers no agent source or key. The optional path enrolls a server-generated agent without rewriting laptop inputs, mounts only that agent's key into its service, and uses the same pinned runtime image. All 132 host tests passed. The new `test:testing` command passed both its module suite and a complete signed publication on Linux amd64 under emulation, with the final network marked internal. An earlier native arm64 run also passed before that network restriction was added. The amd64 check is wired into the existing Docker CI job, but hosted CI has not been queried. Live Sepolia/cloud operation, public HTTPS checks, and release publication remain operator steps rather than validation performed here.

## Context and Orientation

`node/production/compose.yaml` runs the signing node and Kubo, while `docker/compose.http.yaml` adds Caddy. The node accepts `{text, signer, signature}` at `/v1/messages`, validates the signature and allowlist, publishes to IPFS, and spends its own gas logging the CID on Ledger. Repeated messages are intentionally valid. `scripts/deploy-droplet.sh` stages private settings over SSH; `scripts/deploy-droplet-remote.sh` validates and starts a new installation. `scripts/publish-image.sh` archives reviewed Git source and produces the pinned deployment bundle.

## Plan of Work

First create `agent-library/agents/hourly-message-test/agent.mjs` and its tests: private-key creation/reuse, allowlist enrollment, hourly scheduling, signed HTTP requests, bounded requests, sanitized results, and shutdown. Next add a Compose overlay with profile `testing`, readonly code/key mounts, and a network isolated from Kubo. Extend deployment and bundle packaging to carry the public code and perform initialization with the already-pulled image. Finally add deployment regression tests, run the agent unit tests inside the runtime image, and exercise the actual profile against disposable Anvil and Kubo.

## Concrete Steps

From repository root, run `npm --prefix node/production test` for host regressions. Run `bash -n` on the three changed deployment/publication scripts. Build the existing runtime image using Compose or the Docker integration harness. Run module tests inside that image with the module directory mounted at `/app/test-agent` and command `node --test /app/test-agent/test-agent.test.mjs`; ethers resolves from `/app/node_modules`. Run the Docker integration fixture with its new `--testing` option to initialize the agent, start the profile, and observe one real signed publication without waiting an hour. Use mocked clocks only in the module tests to prove the exact hourly interval.

## Validation and Acceptance

Disabled profiles neither create keys nor submit messages. Initialization reuses an existing key, preserves existing allowlisted addresses, adds the new address once, and refuses invalid settings/keys or unsupported chains. Key files remain mode 0600 and are not printed. The runtime signs valid messages, never overlaps requests, waits the remaining hour after a result, and stops after an unconfirmed outcome. SIGTERM interrupts idle waiting and allows an active request its bounded completion time. Release assets contain only reviewed agent source, never generated keys. The Docker check verifies a Ledger event and IPFS bytes for the agent's signature, plus private mounts and network isolation.

## Idempotence and Recovery

The first-install script still refuses existing deployments. Test-agent initialization is repeatable only while the node is stopped; it preserves the key and does not duplicate the allowlist entry. Failed initialization retains private files for inspection. After an uncertain message, inspect the node's sanitized result logs and chain before restarting. Do not delete the key during recovery. Stop the agent before stopping the proxy/node for backups or updates. Manual restart sends immediately and does not restore an old hourly schedule.

## Artifacts and Notes

Validation uses generated accounts and disposable Anvil only. No real private settings, cloud host, provider credentials, public image push, or Sepolia transaction is required. Record final commands and results here without machine-specific paths or sensitive values.

Completed commands, from repository root:

    node --test node/production/test/deploy-droplet.test.mjs node/production/test/publish-image.test.mjs
    npm --prefix node/production test
    npm --prefix node/production run test:docker -- --testing --verbose
    npm --prefix node/production run test:docker -- --testing --platform linux/amd64 --verbose
    bash -n node/production/scripts/deploy-droplet.sh node/production/scripts/deploy-droplet-remote.sh node/production/scripts/publish-image.sh
    git diff --check

The targeted host suite passed 33 tests; the full host suite passed 132. Both Docker runs checked exact signed IPFS bytes and the matching Ledger event, then stopped the agent with exit 0 while only one node transaction had been submitted. The module suite exercised the hourly schedule with a controlled clock and tested stalled response bodies, rejected responses, private key preservation, and signal draining. Fixtures cleaned up their containers, images, volumes, and generated settings.

## Interfaces and Dependencies

The installer gains `--with-test-agent`; the Compose service is `test-agent` in profile `testing`. The overlay takes an image pin, public source directory, private key directory, and request deadline from operator settings. The agent consumes only its own key, contacts `http://node:8787/v1/messages`, and emits public publication identifiers. Dependencies are Node.js 24 and ethers already present in the node image. Source and module tests remain local to `agent-library/agents/hourly-message-test/`.
