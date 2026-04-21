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
- [x] 2026-04-20 23:18Z: Chose `@oyaprotocol/publishing` for the first concrete function and implemented `publishToIpfs(...)` as a package-local Kubo-compatible IPFS add primitive with normalized return data and transient-failure retries.
- [x] 2026-04-20 23:18Z: Added focused tests covering success, retryable HTTP failure, retryable network failure, non-retryable HTTP failure, and missing-CID responses for `publishToIpfs(...)`.
- [x] 2026-04-20 23:32Z: Tightened the publishing primitive into a strict low-level surface with no implicit defaults, added `createIpfsPublishConfig(...)` for explicit transport settings, and updated the tests to require explicit config, `fetch`, filename, and media type.
- [x] 2026-04-21 21:46Z: Consolidated tiny helper functions inside `publishToIpfs(...)` and `parseAddResponse(...)` so the file keeps only behavior-bearing top-level helpers while preserving the same external API and test coverage.
- [x] 2026-04-21 22:36Z: Applied a minimal fallback-timeout cleanup fix so the `createTimeoutSignal(...)` fallback no longer leaves successful-attempt timers running until `timeoutMs` elapses.
- [x] 2026-04-21 22:38Z: Added fallback-timeout regression coverage and re-ran `node --test packages/publishing/test/publish-to-ipfs.test.js`; all 7 tests passed.
- [x] 2026-04-21 22:42Z: Made retry backoff abort-aware so caller cancellation interrupts retry delays promptly, added regression coverage for abort-during-backoff, and re-ran `node --test packages/publishing/test/publish-to-ipfs.test.js`; all 8 tests passed.
- [ ] Decide the next publishing primitive after raw IPFS add, likely one of pinning, durable indexing, or publication-record recovery.

## Surprises & Discoveries

- Observation: The repository currently has multiple independent Node package manifests (`agent/`, `agent-library/`, `frontend/`, and `node/`) but no root Node workspace manifest.
  Evidence: `find . -maxdepth 2 -name package.json` returned package manifests only under those directories before the new `packages/` area was added.

- Observation: Creating package shells does not require committing yet to a repo-wide workspace manager or dependency-install flow.
  Evidence: Each new package can expose its own package root through `package.json` `exports`, while future consumers can add explicit dependencies when they are ready to adopt a hardened package.

- Observation: For the first publishing primitive, retry behavior matters even before indexing or pinning exists because IPFS add requests can fail transiently at the HTTP or network layer.
  Evidence: the package-local tests now cover both HTTP 503 retry and network `ECONNRESET` retry paths.

- Observation: Convenience defaults make the publishing primitive harder to audit because they hide transport and content assumptions from the caller.
  Evidence: the initial `publishToIpfs(...)` version included implicit API URL, retry, timeout, filename, media type, and clock behavior, all of which were removed in favor of explicit inputs plus validated config.

- Observation: The timeout fallback path also needs lifecycle cleanup, not just correct abort behavior.
  Evidence: in runtimes without native `AbortSignal.timeout`, the prior fallback timer was only cleared on abort and remained live after successful requests.

- Observation: Retry backoff is part of the cancellation contract, not just transport resilience.
  Evidence: before the latest change, a caller abort during `retryDelayMs` did not take effect until the full backoff completed.

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

- Decision: Make the first concrete package function `publishToIpfs(...)` in `@oyaprotocol/publishing`.
  Rationale: The user identified raw publication as the smallest publishing surface, and IPFS add with retries can be implemented and reviewed independently before adding pinning, indexing, or API layers.
  Date/Author: 2026-04-20 / Codex.

- Decision: Keep the first IPFS primitive package-local and transport-focused: a Kubo-compatible HTTP add function that accepts injected `fetch`, returns normalized publication details, and retries only transient failures.
  Rationale: This creates a useful primitive without prematurely introducing app wiring, config loaders, or broader publication-record abstractions.
  Date/Author: 2026-04-20 / Codex.

- Decision: The first concrete primitives in `@oyaprotocol/publishing` should be strict low-level surfaces with no implicit defaults.
  Rationale: The user wants audited primitives where all important transport and content assumptions are passed in explicitly by the caller.
  Date/Author: 2026-04-20 / Codex.

## Outcomes & Retrospective

The first milestone is complete. The repo now has a dedicated `packages/` area, five named package shells, local area guidance, and a matching ExecPlan. The resulting surface started intentionally small: package manifests, package-root entrypoints, and placeholder exports only.

Validation evidence for this milestone:

- direct Node imports returned `@oyaprotocol/utils`, `@oyaprotocol/messages`, `@oyaprotocol/publishing`, `@oyaprotocol/transactions`, and `@oyaprotocol/verification` from the new `src/index.js` entrypoints
- a source-only import scan over `packages/*/src` found no imports from legacy repo areas

The second milestone establishes the first real package primitives in `@oyaprotocol/publishing`: `createIpfsPublishConfig(...)` and `publishToIpfs(...)`. Together they define a strict low-level IPFS add surface: the caller must provide explicit transport settings, explicit content metadata, and an explicit `fetch` implementation. The primitive then publishes text or bytes to a Kubo-compatible `/api/v0/add` endpoint, normalizes the returned publication details, and retries transient failures without adding pinning, indexing, or API-serving behavior yet.

Validation evidence for this milestone:

- `node --test packages/publishing/test/publish-to-ipfs.test.js`
- `node --input-type=module -e "import('./packages/publishing/src/index.js').then((m) => { console.log(typeof m.createIpfsPublishConfig, typeof m.publishToIpfs, m.packageInfo.status); })"`

Remaining work stays intentionally narrow: choose the next publishing primitive, then implement and validate it before moving on.

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

The first implemented function now lives at:

- `packages/publishing/src/ipfs-publish-config.js`
- `packages/publishing/src/publish-to-ipfs.js`

The first focused tests now live at:

- `packages/publishing/test/publish-to-ipfs.test.js`

## Plan of Work

The first phase is structural only. Create the `packages/` directory, add area-level docs, and give each package a minimal importable surface through `package.json` and `src/index.js`. Do not implement domain logic yet. Do not define final package ownership yet. Do not wire existing app code to these packages yet.

After the shells exist, future phases proceed function by function. Each function should be assigned to one package deliberately, implemented from scratch, reviewed, and validated before the next function is added.

The first concrete function is now complete in `@oyaprotocol/publishing`. The next phase should stay inside the same package unless a stronger reason appears to change packages.

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

6. Implement `packages/publishing/src/publish-to-ipfs.js` as a package-local primitive that:

   - accepts bytes or text content
   - targets a Kubo-compatible `/api/v0/add` HTTP endpoint
   - returns normalized publication details including `cid` and `ipfs://` URI
   - retries transient failures only

7. Add `packages/publishing/src/ipfs-publish-config.js` so transport settings are explicit and validated instead of implicitly defaulted.

8. Add focused tests for the new publishing primitive.

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
- `node --test packages/publishing/test/publish-to-ipfs.test.js`
- `node --input-type=module -e "import('./packages/publishing/src/index.js').then((m) => { console.log(typeof m.createIpfsPublishConfig, typeof m.publishToIpfs, m.packageInfo.status); })"`

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

Current additional public surface in `@oyaprotocol/publishing`:

- `createIpfsPublishConfig(options)`
- `publishToIpfs(options)`

## Interfaces and Dependencies

Interfaces introduced in this phase:

- package-root `exports` for each new `@oyaprotocol/*` package
- `packageInfo` placeholder export from each package entrypoint

Interfaces introduced after the initial shell milestone:

- `createIpfsPublishConfig(options)` from `@oyaprotocol/publishing`
- `publishToIpfs(options)` from `@oyaprotocol/publishing`

Dependencies introduced in this phase:

- none between the new packages
- no imports from legacy repo areas into `packages/`
