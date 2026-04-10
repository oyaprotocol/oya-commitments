# Extract Standalone Oya Node Into `node/`

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Move the standalone Oya node startup surfaces out of `agent/` and into a dedicated top-level `node/` workspace so operators, reviewers, and future contributors can distinguish clearly between:

- the commitment-serving agent runtime under `agent/`
- the separate node daemons that archive signed messages, archive signed proposals, and optionally submit proposals onchain

After this refactor, a contributor should be able to:

1. find node-owned startup code, runtime helpers, node-focused tests, and node docs under `node/`
2. start the message publication node from `node/` without hunting through `agent/scripts/`
3. start the proposal publication / proposal submission node from `node/` the same way
4. see a documented compatibility path for older `agent/scripts/start-...node.mjs` commands during the migration window
5. verify that the node still behaves the same way on the wire: same endpoints, same signatures, same IPFS publication semantics, same duplicate handling

This plan is about directory ownership and process boundaries, not about changing the node protocols. The signed request schemas, endpoints, and publication behavior should remain stable unless the user explicitly asks for protocol changes later.

## Progress

- [x] 2026-04-10 01:42Z: Audited `AGENTS.md`, `agent/AGENTS.md`, and `PLANS.md` for instruction hierarchy and ExecPlan requirements.
- [x] 2026-04-10 01:43Z: Inventoried the current standalone node surfaces: `agent/scripts/start-message-publish-node.mjs`, `agent/scripts/start-proposal-publish-node.mjs`, `agent/scripts/lib/message-publish-runtime.mjs`, `agent/scripts/lib/proposal-publish-runtime.mjs`, node-focused tests under `agent/scripts/`, and node docs in `agent/README.md`.
- [x] 2026-04-10 01:45Z: Wrote this dedicated extraction ExecPlan instead of overloading the Polymarket agent plan, because the refactor affects both node types and their shared operator-facing surfaces.
- [x] 2026-04-10 02:00Z: Created the new `node/` workspace with `node/package.json`, `node/README.md`, primary startup scripts under `node/scripts/`, and node-path runtime/test entrypoints under `node/scripts/lib/` and `node/scripts/test-*.mjs`.
- [x] 2026-04-10 02:01Z: Converted `agent/scripts/start-message-publish-node.mjs` and `agent/scripts/start-proposal-publish-node.mjs` into thin compatibility wrappers that delegate to the new `node/scripts/` entrypoints.
- [x] 2026-04-10 02:03Z: Updated repo docs and living plans so `node/` is the documented primary home for standalone node daemons.
- [x] 2026-04-10 02:09Z: Validated the new paths with direct `node/scripts` help/runtime/store/API checks plus compatibility-wrapper help checks under `agent/scripts`.
- [x] 2026-04-10 02:12Z: Confirmed real proposal-node runtime resolution from both the new primary path and the old wrapper with `--module=signed-proposal-publish-smoke --dry-run`; both paths report the same resolved host, port, mode, chain, state file, and node name.
- [x] 2026-04-10 02:21Z: Hardened the extracted `node/` package boundary so startup scripts and runtime/test wrappers now prefer local repo imports but can fall back to an installed `og-commitment-agent` package when `node/package.json` is installed on its own.

## Surprises & Discoveries

- Observation: There is currently no top-level `node/` workspace in the repo.
  Evidence: `find . -maxdepth 2 -type d` shows `agent/`, `agent-library/`, `frontend/`, `plans/`, and Solidity paths, but no `node/`.

- Observation: The current standalone node surface is split across two layers inside `agent/`: startup/runtime scripts in `agent/scripts/` and reusable HTTP/publication logic in `agent/src/lib/`.
  Evidence: `agent/scripts/start-message-publish-node.mjs`, `agent/scripts/start-proposal-publish-node.mjs`, `agent/scripts/lib/message-publish-runtime.mjs`, and `agent/scripts/lib/proposal-publish-runtime.mjs` start the processes, while `agent/src/lib/message-publication-api.js` and `agent/src/lib/proposal-publication-api.js` own the HTTP behavior.

- Observation: The repo does not currently use a root Node workspace; `agent/`, `agent-library/`, and `frontend/` each have their own `package.json`.
  Evidence: `rg --files -g 'package.json'` returns package manifests for `agent/`, `agent-library/`, and `frontend/`, but none at the repository root.

- Observation: The existing docs and active ExecPlans already point at `agent/scripts/start-message-publish-node.mjs` and `agent/scripts/start-proposal-publish-node.mjs`, so a hard cutover would leave multiple living documents stale at once.
  Evidence: `agent/README.md`, `plans/polymarket-deferred-settlement-agent.md`, `plans/oya-node-signed-proposal-publication.md`, and `plans/oya-node-publish-and-propose.md` all reference the old paths directly.

- Observation: Moving the primary entrypoints into `node/` does not automatically make `node/` an independent dependency root, because the repo currently installs `dotenv` and `viem` under `agent/node_modules` rather than a root workspace.
  Evidence: the new `node/scripts/` entrypoints work by importing shared modules under `agent/`, which continue to resolve those dependencies from the existing `agent` package installation.

- Observation: package-boundary hardening requires startup scripts themselves to avoid direct `../../agent/...` static imports, not just the runtime helper wrappers.
  Evidence: `node/scripts/start-message-publish-node.mjs` and `node/scripts/start-proposal-publish-node.mjs` originally imported `agent/src/lib/*` directly at module load, which would fail before CLI processing if only the `node/` manifest had been installed.

## Decision Log

- Decision: Create a dedicated top-level `node/` workspace for node-owned process entrypoints, runtime helpers, docs, and node-focused tests.
  Rationale: The user explicitly wants the node-running scripts to live outside `agent/`, and a top-level workspace makes the agent-versus-node process split obvious to operators and contributors.
  Date/Author: 2026-04-10 / Codex.

- Decision: Keep genuinely shared protocol and utility code in `agent/src/lib/` for this refactor unless the move is clearly about node-only ownership.
  Rationale: `signed-request-auth.js`, `ipfs.js`, canonical JSON helpers, config resolution, and some publication libraries are used by both agent-side tooling and node daemons. Moving all of that in the same pass would turn a directory extraction into a broader architecture rewrite.
  Date/Author: 2026-04-10 / Codex.

- Decision: Preserve backward compatibility by keeping thin wrappers at the old startup paths during the migration.
  Rationale: Existing plans, docs, local scripts, and operator habits already use the `agent/scripts/start-...node.mjs` paths. Wrappers reduce breakage while the repo is updated.
  Date/Author: 2026-04-10 / Codex.

- Decision: Prefer moving node-focused tests alongside the new `node/` runtime helpers, but leave agent-side sender helpers such as `send-signed-message.mjs` and `send-signed-proposal.mjs` in `agent/`.
  Rationale: Sender scripts are still agent/operator tooling, not node daemons. The refactor request is about where the node runs, not about relocating every tool that can talk to a node.
  Date/Author: 2026-04-10 / Codex.

- Decision: Implement the extraction as a compatibility-first first pass: `node/` now owns the primary startup and test entrypoints, while some runtime/test implementation still delegates into shared `agent/` modules.
  Rationale: This achieves the requested directory split immediately without forcing a larger dependency/workspace migration in the same change.
  Date/Author: 2026-04-10 / Codex.

- Decision: Make the `node/` startup/runtime/test entrypoints resolve shared agent modules through a local-path-first, package-fallback helper, and depend on `og-commitment-agent` from `node/package.json`.
  Rationale: This keeps the extracted `node/` workspace usable from the repository checkout while also letting a node-specific install bootstrap from its own manifest without assuming `agent/node_modules` is already present.
  Date/Author: 2026-04-10 / Codex.

## Outcomes & Retrospective

This plan is implemented as a first extraction pass. The resulting outcome is:

- `node/` becomes the primary home for starting and testing standalone Oya node daemons
- `agent/` remains the primary home for commitment-serving agent code and agent-side sender helpers
- old startup paths under `agent/scripts/` continue to function as documented compatibility shims until the repo has fully switched over
- protocol behavior stays unchanged: same signed payloads, same endpoints, same IPFS publication and retry semantics

The main success criterion is not “files moved.” It is that a new contributor can infer the architecture correctly from the directory structure: the node is a separate process surface from the agent.

Validation completed during this pass:

- `node node/scripts/start-message-publish-node.mjs --help`
- `node node/scripts/start-proposal-publish-node.mjs --help`
- `node node/scripts/test-message-publication-store.mjs`
- `node node/scripts/test-proposal-publication-store.mjs`
- `node node/scripts/test-message-publish-runtime.mjs`
- `node node/scripts/test-message-publication-api.mjs`
- `node node/scripts/test-proposal-publication-api.mjs`
- `node node/scripts/start-proposal-publish-node.mjs --module=signed-proposal-publish-smoke --dry-run`
- `node agent/scripts/start-message-publish-node.mjs --help`
- `node agent/scripts/start-proposal-publish-node.mjs --help`
- `node agent/scripts/start-proposal-publish-node.mjs --module=signed-proposal-publish-smoke --dry-run`

Follow-up validation after package-boundary hardening:

- `node node/scripts/start-message-publish-node.mjs --help`
- `node node/scripts/start-proposal-publish-node.mjs --help`
- `node node/scripts/test-message-publish-runtime.mjs`
- `node node/scripts/test-message-publication-store.mjs`
- `node node/scripts/test-message-publication-api.mjs`
- `node node/scripts/test-proposal-publication-store.mjs`
- `node node/scripts/test-proposal-publication-api.mjs`

Residual follow-up that may still be worthwhile later:

- physically move more node-specific runtime/test implementation out of `agent/` once the repo has a cleaner shared dependency/workspace strategy
- decide whether default node state files should eventually migrate from `agent/.state/` to `node/.state/`

## Context and Orientation

The current standalone node-related files fall into three groups:

1. Process entrypoints and runtime resolution under `agent/scripts/`

- `agent/scripts/start-message-publish-node.mjs`
- `agent/scripts/start-proposal-publish-node.mjs`
- `agent/scripts/lib/message-publish-runtime.mjs`
- `agent/scripts/lib/proposal-publish-runtime.mjs`

2. Node-focused tests under `agent/scripts/`

- `agent/scripts/test-message-publication-api.mjs`
- `agent/scripts/test-message-publication-store.mjs`
- `agent/scripts/test-message-publish-runtime.mjs`
- `agent/scripts/test-proposal-publication-api.mjs`
- `agent/scripts/test-proposal-publication-store.mjs`
- parts of `agent/scripts/test-send-signed-proposal-config.mjs` also cover proposal-node startup/runtime resolution

3. Shared libraries under `agent/src/lib/`

- `agent/src/lib/message-publication-api.js`
- `agent/src/lib/message-publication-store.js`
- `agent/src/lib/proposal-publication-api.js`
- `agent/src/lib/proposal-publication-store.js`
- `agent/src/lib/signed-published-message.js`
- `agent/src/lib/signed-proposal.js`
- `agent/src/lib/signed-request-auth.js`
- `agent/src/lib/ipfs.js`
- `agent/src/lib/config.js`
- `agent/src/lib/agent-config.js`

The crucial distinction for this refactor is ownership:

- startup wrappers, node-specific runtime resolution, node docs, and node-focused tests are node-owned and should move to `node/`
- shared request/auth/IPFS/config code may remain under `agent/src/lib/` for now because agent-side tooling still uses it

The repo currently has no root Node workspace, so the refactor must also decide whether `node/` gets its own `package.json`. The practical, lowest-risk answer is “yes”: create a minimal `node/package.json` that declares the dependencies required by the startup scripts and test scripts, rather than asking operators to infer that node daemons depend on `agent/package.json`.

## Plan of Work

First, establish the boundary of the new `node/` workspace. The target is a process-oriented workspace, not a full fork of the agent runtime. That means `node/` should own:

- its own `README.md`
- its own `package.json`
- node startup scripts
- node runtime-resolution helpers
- node-focused tests

At this stage it should not duplicate shared publication/auth/IPFS code that already lives in `agent/src/lib/`. Those modules can still be imported from `node/` until a later refactor proves they deserve a neutral shared package.

Second, create the new directory layout and move the startup surfaces. In the implemented first pass, the target layout looks like:

- `node/package.json`
- `node/README.md`
- `node/scripts/start-message-publish-node.mjs`
- `node/scripts/start-proposal-publish-node.mjs`
- `node/scripts/lib/message-publish-runtime.mjs`
- `node/scripts/lib/proposal-publish-runtime.mjs`

The new primary files keep the same CLI behavior and help text, except for path references that now point at `node/`.

Third, move node-focused tests to the new workspace. The goal is that a contributor looking for node regressions does not have to search under `agent/scripts/`. In the implemented first pass, node-path wrapper entrypoints are acceptable if they preserve the new node-owned test surface while deeper implementation remains shared.

- move `test-message-publication-api.mjs`
- move `test-message-publication-store.mjs`
- move `test-message-publish-runtime.mjs`
- move `test-proposal-publication-api.mjs`
- move `test-proposal-publication-store.mjs`

For mixed-responsibility tests such as `test-send-signed-proposal-config.mjs`, decide whether to:

- keep them in `agent/` because they primarily validate sender behavior, or
- split out the server-config portions into a dedicated `node/` test

Fourth, add compatibility wrappers at the old startup paths. `agent/scripts/start-message-publish-node.mjs` and `agent/scripts/start-proposal-publish-node.mjs` should remain as thin delegating entrypoints that import and run the new `node/` equivalents. This preserves existing commands, existing approved test prefixes, and existing operator documentation during the transition.

Fifth, update the documentation. The new primary documentation should live in `node/README.md`, while `agent/README.md` should keep shorter references that explain:

- the agent can talk to the node
- the node now lives under `node/`
- old startup paths still exist only as compatibility wrappers if that remains true after implementation

Update active living plans that currently name the old startup paths so future work does not reintroduce the `agent/` placement by accident.

Sixth, validate behavior from the new paths. The node must still:

- start with the same config semantics
- serve the same endpoints
- verify the same signed payloads
- dedupe the same duplicate requests
- preserve the same CID and retry semantics across partial failures

The refactor is only complete when those behaviors are proven from `node/`, not just when imports compile.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Create the new workspace and package manifest.

   Files:

   - `node/package.json` (new)
   - `node/README.md` (new)
   - optional `node/.gitignore` if the workspace needs local build/test artifacts ignored

   Expected behavior:

   - `node/` is visible as a first-class workspace in the repo layout
   - contributors can see immediately which package owns node daemon startup

2. Move node startup and runtime helper files.

   Files:

   - create `node/scripts/start-message-publish-node.mjs` as the new primary entrypoint
   - create `node/scripts/start-proposal-publish-node.mjs` as the new primary entrypoint
   - expose node-path runtime helpers at `node/scripts/lib/message-publish-runtime.mjs`
   - expose node-path runtime helpers at `node/scripts/lib/proposal-publish-runtime.mjs`

   Follow-up compatibility files:

   - `agent/scripts/start-message-publish-node.mjs` (thin wrapper)
   - `agent/scripts/start-proposal-publish-node.mjs` (thin wrapper)

   Commands:

   - `node node/scripts/start-message-publish-node.mjs --module=polymarket-staked-external-settlement --dry-run`
   - `node node/scripts/start-proposal-publish-node.mjs --module=signed-proposal-publish-smoke --dry-run`

   Expected behavior:

   - new commands succeed and print the same resolved host, port, chain, state file, and mode details as before
   - old commands still work through wrappers during the migration window

3. Move node-focused tests.

   Candidate files:

   - expose `node/scripts/test-message-publication-api.mjs`
   - expose `node/scripts/test-message-publication-store.mjs`
   - expose `node/scripts/test-message-publish-runtime.mjs`
   - expose `node/scripts/test-proposal-publication-api.mjs`
   - expose `node/scripts/test-proposal-publication-store.mjs`

   Possible split:

   - keep sender-oriented config tests under `agent/scripts/`
   - add node-oriented config tests under `node/scripts/` if a single test currently covers both concerns

   Commands:

   - `node node/scripts/test-message-publication-api.mjs`
   - `node node/scripts/test-message-publication-store.mjs`
   - `node node/scripts/test-message-publish-runtime.mjs`
   - `node node/scripts/test-proposal-publication-api.mjs`
   - `node node/scripts/test-proposal-publication-store.mjs`

4. Update docs and active plans.

   Files:

   - `node/README.md`
   - `agent/README.md`
   - `README.md`
   - `agent-library/README.md` if command examples point at old startup paths
   - `plans/polymarket-deferred-settlement-agent.md`
   - `plans/oya-node-signed-proposal-publication.md`
   - `plans/oya-node-publish-and-propose.md`

   Expected behavior:

   - primary node docs point at `node/scripts/...`
   - agent docs explain the boundary instead of making `agent/` look like the node's home
   - living plans reflect the new primary paths

5. Re-run focused validation after the path migration.

   Commands:

   - `node node/scripts/start-message-publish-node.mjs --help`
   - `node node/scripts/start-proposal-publish-node.mjs --help`
   - `node node/scripts/test-message-publication-api.mjs`
   - `node node/scripts/test-proposal-publication-api.mjs`
   - `node agent/scripts/start-message-publish-node.mjs --help`
   - `node agent/scripts/start-proposal-publish-node.mjs --help`

   Expected behavior:

   - new paths are the primary working paths
   - compatibility wrappers still function
   - no request/response behavior changed unintentionally

## Validation and Acceptance

This refactor pass is accepted when all of the following are true:

- `node/` exists with its own documentation and startup surfaces
- the message publication node starts from `node/scripts/start-message-publish-node.mjs`
- the proposal publication / submission node starts from `node/scripts/start-proposal-publish-node.mjs`
- focused node tests pass from the new workspace paths
- old startup paths under `agent/scripts/` either still work as wrappers or have been intentionally removed with every doc and plan updated in the same change
- the HTTP protocols are unchanged: same routes, same signed request shapes, same status codes for success, duplicate, conflict, and partial-failure cases

If a validation step cannot be run in the current environment, the plan must record exactly what is missing. The most likely environmental constraint is local HTTP listener permission in this Codex environment for the API tests.

## Idempotence and Recovery

This refactor should be performed in a compatibility-preserving sequence:

1. add `node/`
2. move startup/runtime/test ownership to `node/`
3. leave compatibility wrappers at the old `agent/scripts/` entrypoints
4. update docs and plans
5. only later, if desired, remove the wrappers in a separate cleanup change

That sequence is important because many existing plans and local workflows still reference the old paths. Wrappers make the refactor retry-safe and reduce the risk of half-migrated docs or broken local scripts.

Avoid moving shared publication/auth/IPFS code and startup entrypoints in the same conceptual step unless the ownership is obvious. If an attempted move causes import loops or surprising package-boundary issues, keep the shared library where it is and continue with the process-surface extraction first.

## Artifacts and Notes

Current path mapping to preserve during review:

- message node startup: `agent/scripts/start-message-publish-node.mjs`
- proposal node startup: `agent/scripts/start-proposal-publish-node.mjs`
- message node runtime helper: `agent/scripts/lib/message-publish-runtime.mjs`
- proposal node runtime helper: `agent/scripts/lib/proposal-publish-runtime.mjs`
- node docs: sections inside `agent/README.md`

Target primary path mapping:

- message node startup: `node/scripts/start-message-publish-node.mjs`
- proposal node startup: `node/scripts/start-proposal-publish-node.mjs`
- message node runtime helper: `node/scripts/lib/message-publish-runtime.mjs`
- proposal node runtime helper: `node/scripts/lib/proposal-publish-runtime.mjs`
- node docs: `node/README.md`

Likely commands after the refactor:

- `node node/scripts/start-message-publish-node.mjs --module=<agent-name>`
- `node node/scripts/start-proposal-publish-node.mjs --module=<agent-name>`

## Interfaces and Dependencies

This refactor must account for the following existing interfaces and dependencies:

- `agent/src/lib/message-publication-api.js`
- `agent/src/lib/message-publication-store.js`
- `agent/src/lib/proposal-publication-api.js`
- `agent/src/lib/proposal-publication-store.js`
- `agent/src/lib/signed-published-message.js`
- `agent/src/lib/signed-proposal.js`
- `agent/src/lib/signed-request-auth.js`
- `agent/src/lib/ipfs.js`
- `agent/src/lib/config.js`
- `agent/src/lib/agent-config.js`
- `agent/scripts/send-signed-message.mjs`
- `agent/scripts/send-signed-proposal.mjs`
- existing docs in `agent/README.md`
- active plans in `plans/`

Environment/config dependencies that must continue to work unchanged:

- `MESSAGE_PUBLISH_API_KEYS_JSON`
- `MESSAGE_PUBLISH_API_SIGNER_PRIVATE_KEY`
- `PROPOSAL_PUBLISH_API_KEYS_JSON`
- signer selection via `SIGNER_TYPE`, `PRIVATE_KEY`, `SIGNER_RPC_URL`, `SIGNER_ADDRESS`, and related shared signer settings
- `IPFS_HEADERS_JSON`
- agent module config fields under `messagePublishApi` and `proposalPublishApi`
