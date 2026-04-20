# Create Hardened Kernel Package Shells

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Create the initial package shells for the new hardened Oya production kernel under `packages/`. The goal of this phase is not to implement functionality or finalize package ownership. The goal is to create a clean, reviewable starting point: distinct packages with explicit package names, explicit public entrypoints, and local documentation that future work can extend one function at a time.

After this phase, a contributor should be able to:

1. find the new production-kernel area under `packages/`
2. see the initial package list and public package names
3. import each package through its package root entrypoint rather than a deep file path
4. continue future package work without importing legacy runtime code into the new kernel

## Progress

- [x] 2026-04-20 21:58Z: Reviewed root `AGENTS.md` and `PLANS.md` and confirmed this rewrite warrants an ExecPlan because it is the start of a multi-step, cross-area production-kernel effort.
- [x] 2026-04-20 21:58Z: Audited the current repo layout and existing Node package manifests to keep the first package-shell step minimal and non-disruptive.
- [x] 2026-04-20 21:58Z: Created `packages/` area documentation plus importable shells for `@oyaprotocol/utils`, `@oyaprotocol/messages`, `@oyaprotocol/publishing`, `@oyaprotocol/transactions`, and `@oyaprotocol/verification`.
- [x] 2026-04-20 21:59Z: Validated that each package entrypoint imports with Node and confirmed the new `packages/*/src` files have no legacy repo imports.
- [ ] Decide the first concrete function to implement in one hardened package and document the approved ownership for that function.

## Surprises & Discoveries

- Observation: The repository currently has multiple independent Node package manifests (`agent/`, `agent-library/`, `frontend/`, and `node/`) but no root Node workspace manifest.
  Evidence: `find . -maxdepth 2 -name package.json` returned package manifests only under those directories before the new `packages/` area was added.

- Observation: Creating package shells does not require committing yet to a repo-wide workspace manager or dependency-install flow.
  Evidence: Each new package can expose its own package root through `package.json` `exports`, while future consumers can add explicit dependencies when they are ready to adopt a hardened package.

## Decision Log

- Decision: Start the hardened-kernel rewrite by creating package shells only.
  Rationale: The user explicitly wants to move one step at a time and avoid assigning detailed functionality before scaffolding exists.
  Date/Author: 2026-04-20 / Codex.

- Decision: Use `packages/` as the top-level home for the new hardened production-kernel packages.
  Rationale: A dedicated top-level area makes the new from-scratch codebase visibly separate from the current application and experimental surfaces.
  Date/Author: 2026-04-20 / Codex.

- Decision: Avoid introducing a root Node workspace manifest in this first step.
  Rationale: Package shells and package-root imports are enough for the current milestone, while a repo-wide workspace decision would broaden the change unnecessarily.
  Date/Author: 2026-04-20 / Codex.

## Outcomes & Retrospective

The first milestone is complete. The repo now has a dedicated `packages/` area, five named package shells, local area guidance, and a matching ExecPlan. The resulting surface is intentionally small: package manifests, package-root entrypoints, and placeholder exports only.

Validation evidence for this milestone:

- direct Node imports returned `@oyaprotocol/utils`, `@oyaprotocol/messages`, `@oyaprotocol/publishing`, `@oyaprotocol/transactions`, and `@oyaprotocol/verification` from the new `src/index.js` entrypoints
- a source-only import scan over `packages/*/src` found no imports from legacy repo areas

Remaining work starts with choosing the first concrete function and assigning it deliberately to one package.

## Context and Orientation

The current repository mixes Solidity contracts, deployment scripts, app/runtime code, agent modules, and the newer standalone node area. The new `packages/` area is intended to become the hardened production kernel written from scratch. At this stage the existing runtime code remains in place and acts only as reference material for future package work.

The new package shells introduced in this phase are:

- `packages/utils` for `@oyaprotocol/utils`
- `packages/messages` for `@oyaprotocol/messages`
- `packages/publishing` for `@oyaprotocol/publishing`
- `packages/transactions` for `@oyaprotocol/transactions`
- `packages/verification` for `@oyaprotocol/verification`

Each package currently contains:

- `package.json`
- `README.md`
- `src/index.js`

The new area also has:

- `packages/README.md`
- `packages/AGENTS.md`

## Plan of Work

The first phase is structural only. Create the `packages/` directory, add area-level docs, and give each package a minimal importable surface through `package.json` and `src/index.js`. Do not implement domain logic yet. Do not define final package ownership yet. Do not wire existing app code to these packages yet.

After the shells exist, future phases will proceed function by function. Each function should be assigned to one package deliberately, implemented from scratch, reviewed, and validated before the next function is added.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Create package directories under `packages/` for `utils`, `messages`, `publishing`, `transactions`, and `verification`.

2. Add `package.json` to each package with:

   - a stable package name under the `@oyaprotocol/` scope
   - `type: "module"`
   - a package-root `exports` entrypoint

3. Add `src/index.js` to each package that exports only minimal placeholder metadata.

4. Add local documentation:

   - `packages/README.md`
   - `packages/AGENTS.md`
   - package-level `README.md` files

5. Record the work in this ExecPlan before moving on to functional implementation.

## Validation and Acceptance

This milestone is accepted when:

- each new package has a package manifest and package-root `exports` entrypoint
- each new package can be imported directly from its own `src/index.js` entrypoint with Node
- the repo contains clear local documentation explaining that the new package area is shell-only for now
- no legacy runtime code is imported into the new package area

Validation commands from `/Users/johnshutt/Code/oya-commitments`:

- `node --input-type=module -e "import('./packages/utils/src/index.js').then((m) => console.log(m.packageInfo.name))"`
- `node --input-type=module -e "import('./packages/messages/src/index.js').then((m) => console.log(m.packageInfo.name))"`
- `node --input-type=module -e "import('./packages/publishing/src/index.js').then((m) => console.log(m.packageInfo.name))"`
- `node --input-type=module -e "import('./packages/transactions/src/index.js').then((m) => console.log(m.packageInfo.name))"`
- `node --input-type=module -e "import('./packages/verification/src/index.js').then((m) => console.log(m.packageInfo.name))"`

## Idempotence and Recovery

Creating package shells is safe to retry. If a future step needs to rename a package before functional code is added, the change is localized to the new `packages/` area and its documentation. No existing app/runtime code should depend on these shells yet, which keeps rollback straightforward at this stage.

## Artifacts and Notes

Initial package names:

- `@oyaprotocol/utils`
- `@oyaprotocol/messages`
- `@oyaprotocol/publishing`
- `@oyaprotocol/transactions`
- `@oyaprotocol/verification`

Initial public surface for each package:

- `src/index.js` exporting `packageInfo`

## Interfaces and Dependencies

Interfaces introduced in this phase:

- package-root `exports` for each new `@oyaprotocol/*` package
- `packageInfo` placeholder export from each package entrypoint

Dependencies introduced in this phase:

- none between the new packages
- no imports from legacy repo areas into `packages/`
