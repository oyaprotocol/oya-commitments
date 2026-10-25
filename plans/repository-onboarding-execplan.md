# Make repository onboarding task-oriented

This ExecPlan is maintained according to `PLANS.md`.

## Purpose / Big Picture

A new reader should be able to choose between deploying a commitment, running a publication node, building a commitment-serving agent, using the frontend, and contributing code from the root README. A node operator should reach one recommended setup path without first installing contract development tools. An agent assisting that operator should find the same current instructions.

## Progress

- [x] 2026-10-25 20:29Z: Read repository instructions, entry points, deployment guides, package manifests, and release packaging. Identified competing setup paths and stale agent configuration guidance.
- [x] 2026-10-25 20:31Z: Rewrote root navigation and aligned node entry points and the agent-assisted onboarding guide.
- [x] 2026-10-25 20:31Z: Clarified commitment prerequisites and updated supporting agent/testing/contribution navigation.
- [x] 2026-10-25 20:32Z: Checked 132 local links, verified commands against existing scripts, passed all 13 packaging tests and whitespace checks, and reviewed the complete proposed change.

## Surprises & Discoveries

Before this change, the root README's only Quick Start deployed a Safe and Optimistic Governor, although running an IPFS-only publication node needs neither contract deployment nor Foundry. `node/README.md` introduced the production runtime but then continued into experimental daemons without a strong section boundary.

The previous `docs/agent.md` asked readers to configure commitment addresses through environment variables. Both that guide and `agent/README.md` now direct non-secret behavior and chain-specific commitment addresses to the selected module's `config.json`. The config loader explicitly rejects the obsolete environment fields.

The published v0.3.0 archive predates the current deployment guides and Keychain helper. The current publisher already includes `deploy-with-agent.md`, `keychain-worker.py`, and its Compose overlay. Updating these existing guides preserves that packaging coverage without adding another setup document or claiming a new release exists.

## Decision Log

- Decision: Use the root README as a task directory, with short explanations and links to detailed workflows.
  Rationale: Readers need to select the correct subsystem before following commands; duplicating full procedures would increase drift.
  Date/Author: 2026-10-25 / Codex.
- Decision: Improve the beginning of the existing agent-assisted deployment guide rather than create another node quick-start file.
  Rationale: It is already linked by the deployment skill and included in future release bundles.
  Date/Author: 2026-10-25 / Codex.
- Decision: Preserve the current published version and operational behavior.
  Rationale: This task authorizes documentation changes. Image publication, deployment, and automated setup tooling remain separate work.
  Date/Author: 2026-10-25 / Codex.

## Outcomes & Retrospective

The root README now provides six task entry points, component definitions, separate node and commitment workflows, and a linked repository map. Node entry points distinguish production operation from development and experimental daemons. The agent-assisted guide has a short onboarding sequence, a task prompt that handles missing hosting/access, and completion criteria. Commitment, agent, testing, and contributor guides agree on prerequisites and configuration placement.

All 132 local Markdown links and anchors across the nine changed/new documents resolve. All 13 tests in `node/production/test/publish-image.test.mjs` passed, including bundle contents and extraction permissions. `git diff --check` passed. Commands were checked against the repository's scripts and package manifests; live deployment commands were not executed. No runtime files or packaging rules needed changes. Publication of a new image/bundle remains a separate task, and references still describe the existing v0.3.0 release accurately.

## Context and Orientation

An Oya commitment is a Safe account controlled through an Optimistic Governor module under written rules. Its deployment tools live in the root Foundry project (`src/`, `script/`, and `test/`). A commitment-serving agent uses the shared runner in `agent/` and behavior from `agent-library/agents/<name>/`.

A production publication node lives in `node/production/`. Its local worker publishes signed messages through Kubo, the IPFS service. A separately reachable HTTPS inbox stores accepted work in PostgreSQL while the worker is offline. Optional Ledger mode records the content identifier (CID) onchain. Ledger is in the separate Foundry project under `contracts/`; reusable offchain libraries are under `packages/`. The older daemons in `node/scripts/` have separate integration APIs.

The relevant human entry points are `README.md`, `node/README.md`, `node/production/README.md`, `node/production/deploy-with-agent.md`, `docs/deployment.md`, `docs/agent.md`, `docs/testing.md`, and `CONTRIBUTING.md`. The deployment skill remains the machine workflow, and root `AGENTS.md` already routes deployment tasks to it. No runtime or credential access is necessary.

## Plan of Work

First, replace the generic root Quick Start with task-based navigation, a brief explanation of the components, distinct node and commitment workflows, and a repository map. Keep detailed agent scaffolding instructions in their existing authoritative guide and link to them.

Second, put production node setup ahead of experimental daemon material. Add clear operator/developer navigation to the production README. Give the agent-assisted guide a short onboarding sequence, a usable task prompt, and a concrete explanation of successful setup before the detailed credential and operations reference. Preserve all existing security and recovery requirements.

Third, make commitment deployment prerequisites explicit before its broadcast command, replace stale agent setup directions with links and current configuration placement, and expand the testing index to distinguish the two Foundry projects and Node.js areas. Align contributor navigation without introducing new contributor policy.

Finally, inspect every changed document, validate relative file links and heading anchors, and run the existing release-bundle tests because the edited operator guides ship in that bundle. Fix findings before handoff.

## Concrete Steps

All commands run from the repository root. Use `git diff --check` for whitespace and `git diff --stat` to inspect scope. Check Markdown links against the local tree and GitHub-style heading anchors with a disposable script; allow intentional external links without fetching private state.

Run `node --test node/production/test/publish-image.test.mjs`. The fixture uses a fake Docker command and a temporary Git repository to verify release contents and extraction permissions; it does not publish an image or change the operator installation.

Read the complete `git diff` plus this new plan before handing off. Check commands against their target scripts/manifests, and inspect all proposed files for credentials, private endpoints, operator identifiers, and dependencies on local-only paths.

## Validation and Acceptance

Starting at the root README, a reader must be able to identify a guide and prerequisites for each major task. The node path must state the recommended IPFS-only architecture, sender authorization, optional Ledger requirements, and the distinction between a source checkout and a released image/bundle. The commitment path must state the deployer-owner default and that deployment sends transactions. The agent path must use module configuration rather than the obsolete environment fields.

All added or changed local links and anchors must resolve, the release-bundle tests must pass, and `git diff --check` must pass. Documentation-only changes do not require contract, network, or full runtime integration tests. Record any validation limitation without claiming it passed.

## Idempotence and Recovery

These edits affect documentation only and are safe to reread or revise. Validation uses disposable fixtures. Do not run deployment examples, modify private installation records, create cloud resources, change published tags, or publish release assets. Preserve unrelated working-tree changes if any appear while editing.

## Artifacts and Notes

The initial working tree was clean. Eight existing documentation files were updated, plus this plan. Existing publication tests already copy the operator guides into their fixture, so no additional onboarding file, packaging change, or new test was required. The focused test command reported 13 passes and zero failures.

## Interfaces and Dependencies

Document existing scripts, configuration formats, and release behavior without changing them. Relative links should work from each document's directory. Keep deployment-guide links compatible with the public bundle where possible, and link repository-only material explicitly. Node.js is required for the focused packaging tests; no secrets, Docker daemon, provider account, or blockchain access is needed.
