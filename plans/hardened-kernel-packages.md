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
- [x] 2026-04-20 21:58Z: Created `packages/` area documentation plus importable shells for `@oyaprotocol/utils`, `@oyaprotocol/messages`, `@oyaprotocol/ipfs`, `@oyaprotocol/transactions`, and `@oyaprotocol/verification`.
- [x] 2026-04-20 21:59Z: Validated that each package entrypoint imports with Node and confirmed the new `packages/*/src` files have no legacy repo imports.
- [x] 2026-04-20 23:18Z: Chose `@oyaprotocol/ipfs` for the first concrete function and implemented `publishToIpfs(...)` as a package-local Kubo-compatible IPFS add primitive with normalized return data and transient-failure retries.
- [x] 2026-04-20 23:18Z: Added focused tests covering success, retryable HTTP failure, retryable network failure, non-retryable HTTP failure, and missing-CID responses for `publishToIpfs(...)`.
- [x] 2026-04-20 23:32Z: Tightened the publishing primitive into a strict low-level surface with no implicit defaults, added explicit IPFS transport config, and updated the tests to require explicit config, `fetch`, filename, and media type.
- [x] 2026-04-21 21:46Z: Consolidated tiny helper functions inside `publishToIpfs(...)` and `parseAddResponse(...)` so the file keeps only behavior-bearing top-level helpers while preserving the same external API and test coverage.
- [x] 2026-04-21 22:36Z: Applied a minimal fallback-timeout cleanup fix so the `createTimeoutSignal(...)` fallback no longer leaves successful-attempt timers running until `timeoutMs` elapses.
- [x] 2026-04-21 22:38Z: Added fallback-timeout regression coverage and re-ran the focused publish test; all 7 tests passed.
- [x] 2026-04-21 22:42Z: Made retry backoff abort-aware so caller cancellation interrupts retry delays promptly, added regression coverage for abort-during-backoff, and re-ran the focused publish test; all 8 tests passed.
- [x] 2026-04-22 05:12Z: Converted the kernel packages to TypeScript source, added a `packages/`-local TypeScript workspace toolchain, switched package manifests to `dist/` exports with declaration files, rebuilt all five packages, and re-ran the publishing tests against built output.
- [x] 2026-04-22 05:18Z: Tightened the publishing TypeScript signatures so IPFS config creation and `publishToIpfs(...)` require full option objects in the emitted declaration files, then rebuilt and re-ran the publishing tests.
- [x] 2026-04-22 05:27Z: Updated the publishing retry classifier to inspect nested `error.cause` codes/messages so Node `fetch` network failures like `TypeError('fetch failed', { cause })` still retry when the nested cause is transient, and added regression coverage for that path.
- [x] 2026-04-23 00:14Z: Decoupled request timeout enforcement from injected fetch abort support by racing fetch and `response.text()` against a package-owned timeout signal, and added regression coverage for fetch adapters that ignore `options.signal`.
- [x] 2026-04-23 00:16Z: Updated the combined-abort fallback to return cleanup hooks that remove source-signal listeners after each attempt, and added regression coverage for listener cleanup when `AbortSignal.any` is unavailable.
- [x] 2026-04-23 00:21Z: Made the abort wrapper lazy so pre-aborted requests do not invoke `fetch(...)` or `response.text()` before cancellation is surfaced, and added regression coverage for the pre-cancelled request path.
- [x] 2026-04-29 23:12Z: Decided the next publishing phase should cover explicit pinning behavior, retrieval, and future indexing direction so published Oya data is easier to retrieve and eventually discover.
- [x] 2026-04-29 23:12Z: Created the follow-on ExecPlan at `plans/ipfs-publication-indexing-and-retrieval.md` and closed this plan's final open decision thread.
- [x] 2026-04-30 17:43Z: Amended the follow-on plan after user clarification: the standard kernel path should explicitly add-and-pin in one Kubo request, should not add a `pinOnAdd` boolean, and should not create a separate pinning track unless a future concrete need appears.
- [x] 2026-04-30 18:05Z: Simplified the follow-on plan after user clarification: the immediate package work is explicit add-and-pin plus low-level retrieval, while public indexing is deferred to a future onchain Logger design.
- [x] 2026-05-02 21:52Z: Renamed the initial IPFS work package from `@oyaprotocol/publishing` / `packages/publishing` to `@oyaprotocol/ipfs` / `packages/ipfs` after the package scope expanded from publication to general IPFS retrieval.
- [x] 2026-05-02 22:01Z: Simplified the IPFS package's internal filenames after the package rename; the follow-on plan now owns the current `config.ts`, `publish.ts`, read helpers, and focused test filenames.
- [x] 2026-05-03 21:25Z: Removed the placeholder `@oyaprotocol/verification` TypeScript package because future verification work is likely to live in a lower-level language package, while TypeScript kernel packages focus on network interactions.

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

- Observation: Keeping the kernel in TypeScript does not require a repo-wide workspace migration.
  Evidence: `packages/package.json` now provides a local TypeScript toolchain and workspace links for the five kernel packages without changing the rest of the monorepo package layout.

- Observation: A TypeScript migration only helps if the public declarations are at least as strict as the runtime contract.
  Evidence: the initial TS conversion still emitted `Partial<...>` option types for the publishing functions, which allowed incomplete calls at compile time until the latest signature fix.

- Observation: Native Node `fetch` can hide transient network failure details inside `error.cause` rather than top-level `error.code`.
  Evidence: the latest publishing regression test uses `TypeError('fetch failed', { cause: Error & { code: 'ECONNREFUSED' } })`, which did not retry until the classifier started reading nested cause fields.

- Observation: Timeout behavior should not depend on third-party `fetch` adapters correctly wiring abort signals through to the underlying request.
  Evidence: a regression test with a fetch-like wrapper that ignores `options.signal` only times out correctly after the explicit race was added around both `fetch(...)` and `response.text()`.

- Observation: The `AbortSignal.any` fallback needs its own listener cleanup because `{ once: true }` only detaches listeners on abort, not on successful completion.
  Evidence: a regression test with `AbortSignal.any` disabled and a reused caller signal now verifies listener count returns to zero after a successful publish.

- Observation: Abort-aware wrapping must be lazy to preserve cancellation semantics; checking `signal.aborted` after constructing the promise is too late for side-effecting operations.
  Evidence: the pre-cancelled request regression only stopped invoking the injected `fetch` after the helper changed from accepting an already-created promise to accepting a promise factory.

- Observation: Pinning and indexing solve different post-publication problems, but indexing does not need to be a local package primitive in the immediate next phase.
  Evidence: pinning protects locally added IPFS blocks from garbage collection, while a future onchain Logger contract can provide a public append-only CID index keyed by node address and block history.

- Observation: The current hardened `publishToIpfs(...)` URL does not make pin behavior explicit, even though the desired standard behavior is add-and-pin.
  Evidence: before the follow-on plan's Milestone 1, `packages/ipfs/src/publish.ts` called `/api/v0/add?cid-version=1&progress=false`. The follow-on plan now requires making the existing default explicit with `/api/v0/add?cid-version=1&pin=true&progress=false`.

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

- Decision: Make the first concrete package function `publishToIpfs(...)` in `@oyaprotocol/ipfs`.
  Rationale: The user identified raw publication as the smallest publishing surface, and IPFS add with retries can be implemented and reviewed independently before adding pinning, indexing, or API layers.
  Date/Author: 2026-04-20 / Codex.

- Decision: Keep the first IPFS primitive package-local and transport-focused: a Kubo-compatible HTTP add function that accepts injected `fetch`, returns normalized publication details, and retries only transient failures.
  Rationale: This creates a useful primitive without prematurely introducing app wiring, config loaders, or broader publication-record abstractions.
  Date/Author: 2026-04-20 / Codex.

- Decision: The first concrete primitives in `@oyaprotocol/ipfs` should be strict low-level surfaces with no implicit defaults.
  Rationale: The user wants audited primitives where all important transport and content assumptions are passed in explicitly by the caller.
  Date/Author: 2026-04-20 / Codex.

- Decision: The kernel packages should be authored in TypeScript and published through compiled `dist/` entrypoints plus declaration files.
  Rationale: The user wants durable, reviewable package interfaces, and TypeScript makes those boundaries explicit without requiring the rest of the monorepo to convert at the same time.
  Date/Author: 2026-04-21 / Codex.

- Decision: Close this plan by moving the next publishing work into a dedicated follow-on ExecPlan.
  Rationale: The package shell and raw IPFS add milestones are complete, and the next work is no longer just a primitive-selection question. It is a coherent post-publication feature area spanning explicit add-and-pin behavior, retrieval, and future public indexing direction.
  Date/Author: 2026-04-29 / Codex.

- Decision: The standard hardened-kernel publication path should add and pin in the same Kubo request, without a `pinOnAdd` option or separate pinning track.
  Rationale: Oya publication artifacts are expected to be small and recoverable from canonical local bytes. Re-adding on failure is simpler than supporting a second pinning state machine, and explicit `pin=true` avoids relying on Kubo's implicit default.
  Date/Author: 2026-04-30 / Codex.

- Decision: Defer package-level durable indexing in favor of a future onchain Logger index.
  Rationale: The user identified a simpler public index direction: nodes can publish to IPFS and log CIDs onchain, letting contract events match node addresses to CIDs and block timestamps. The immediate package milestone should not build a local index abstraction before that design is settled.
  Date/Author: 2026-04-30 / Codex.

## Outcomes & Retrospective

The first milestone is complete. The repo now has a dedicated `packages/` area, five named package shells, local area guidance, and a matching ExecPlan. The resulting surface started intentionally small: package manifests, package-root entrypoints, and placeholder exports only.

Historical validation evidence for this milestone:

- `npm --prefix packages run build`
- direct Node imports returned the package names from the built `dist/index.js` entrypoints
- a source-only import scan over `packages/*/src` found no imports from legacy repo areas

The second milestone establishes the first real package primitives in `@oyaprotocol/ipfs`: explicit IPFS config creation and `publishToIpfs(...)`. Together they define a strict low-level IPFS add surface: the caller must provide explicit transport settings, explicit content metadata, and an explicit `fetch` implementation. The primitive then publishes text or bytes to a Kubo-compatible `/api/v0/add` endpoint, normalizes the returned publication details, and retries transient failures without adding pinning, indexing, or API-serving behavior yet.

Validation evidence for this milestone:

- `node --test packages/ipfs/test/publish.test.js`
- `node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => { console.log(typeof m.createIpfsConfig, typeof m.publishToIpfs); })"`

The third milestone converts the kernel area to TypeScript while keeping the change local to `packages/`. Package source now lives in `src/*.ts`, package manifests export built `dist/*.js` entrypoints with `.d.ts` declarations, and `packages/package.json` provides a workspace-local TypeScript toolchain that does not change `agent/`, `node/`, or `frontend/`.

Validation evidence for this milestone:

- `npm --prefix packages install`
- `npm --prefix packages run build`
- `node --input-type=module -e "Promise.all(['./packages/utils/dist/index.js','./packages/messages/dist/index.js','./packages/ipfs/dist/index.js','./packages/ethereum/dist/index.js'].map((path) => import(path))).then(([utils, messages, ipfs, ethereum]) => { console.log(typeof utils.assertNonEmptyString, typeof messages.packageInfo, typeof ipfs.publishToIpfs, typeof ethereum.createHttpConfig); })"`
- `node --test packages/ipfs/test/publish.test.js`

The final open thread in this plan is now closed. The next publishing primitive has been selected as explicit add-and-pin publication, followed by low-level retrieval. Public indexing is deferred to a future onchain Logger design. Implementation should continue from `plans/ipfs-publication-indexing-and-retrieval.md` rather than extending this package-shell plan.

Follow-on cleanup renamed redundant IPFS package filenames after the package moved to `packages/ipfs`: the current source files are `config.ts`, `publish.ts`, `request-utils.ts`, and the read helpers under `packages/ipfs/src/`; the focused tests are `packages/ipfs/test/publish.test.js` and `packages/ipfs/test/retrieval.test.js`.

Later package export cleanup removed `packageInfo` from non-placeholder packages. `@oyaprotocol/ipfs`, `@oyaprotocol/ethereum`, and `@oyaprotocol/utils` now use real public functions for smoke imports, while `@oyaprotocol/messages` keeps `packageInfo` because it is still a placeholder.

Shared validation cleanup moved duplicated IPFS/Ethereum helpers into `@oyaprotocol/utils`: `assertHeadersObject(...)`, `assertNonEmptyString(...)`, `assertNonNegativeInteger(...)`, `assertPositiveInteger(...)`, and `isPlainObject(...)`. IPFS and Ethereum now declare workspace dependencies on `@oyaprotocol/utils` and import through the package root.

Placeholder package cleanup removed `@oyaprotocol/verification` from the TypeScript workspace. Future verification packages can be reintroduced deliberately when the target language/runtime is decided.

HTTP config cleanup moved package config interfaces into `@oyaprotocol/utils` as `HttpConfig` and `CreateHttpConfigOptions`. IPFS and Ethereum creator functions still own their package-specific URL normalization, but both expose the same generic `url`-based config shape.

## Context and Orientation

The current repository mixes Solidity contracts, deployment scripts, app/runtime code, agent modules, and the newer standalone node area. The new `packages/` area is intended to become the hardened production kernel written from scratch. At this stage the existing runtime code remains in place and acts only as reference material for future package work.

The new package shells introduced in this phase are:

- `packages/utils` for `@oyaprotocol/utils`
- `packages/messages` for `@oyaprotocol/messages`
- `packages/ipfs` for `@oyaprotocol/ipfs`
- `packages/ethereum` for `@oyaprotocol/ethereum`

Each package currently contains:

- `package.json`
- `README.md`
- `src/index.ts`
- `tsconfig.json`
- `dist/`

The new area also has:

- `packages/README.md`
- `packages/AGENTS.md`
- `packages/package.json`
- `packages/package-lock.json`
- `packages/tsconfig.base.json`
- `packages/tsconfig.json`

The first implemented function now lives at:

- `packages/ipfs/src/config.ts`
- `packages/ipfs/src/publish.ts`

The first focused tests now live at:

- `packages/ipfs/test/publish.test.js`

## Plan of Work

The first phase is structural only. Create the `packages/` directory, add area-level docs, and give each package a minimal importable surface through `package.json` and `src/index.ts`. Do not implement domain logic yet. Do not define final package ownership yet. Do not wire existing app code to these packages yet.

After the shells exist, future phases proceed function by function. Each function should be assigned to one package deliberately, implemented from scratch, reviewed, and validated before the next function is added.

The first concrete function is now complete in `@oyaprotocol/ipfs`. The open decision at the end of this plan has been resolved. The follow-on implementation should make add-and-pin behavior explicit in the same package, add low-level retrieval, and leave public indexing to a future onchain Logger plan.

## Concrete Steps

From the repository root:

1. Create package directories under `packages/` for `utils`, `messages`, `ipfs`, and `ethereum`.

2. Add `package.json` to each package with:

   - a stable package name under the `@oyaprotocol/` scope
   - `type: "module"`
   - a package-root `exports` entrypoint

3. Add `src/index.ts` to each package that exports only minimal placeholder metadata.

4. Add local documentation:

   - `packages/README.md`
   - `packages/AGENTS.md`
   - package-level `README.md` files

5. Record the work in this ExecPlan before moving on to functional implementation.

6. Implement `packages/ipfs/src/publish.ts` as a package-local primitive that:

   - accepts bytes or text content
   - targets a Kubo-compatible `/api/v0/add` HTTP endpoint
   - returns normalized publication details including `cid` and `ipfs://` URI
   - retries transient failures only

7. Add `packages/ipfs/src/config.ts` so transport settings are explicit and validated instead of implicitly defaulted.

8. Add a `packages/`-local TypeScript toolchain and convert package source files to `src/*.ts`, with package manifests exporting built `dist/` entrypoints.

9. Add focused tests for the new publishing primitive.

## Validation and Acceptance

This milestone is accepted when:

- each new package has a package manifest and package-root `exports` entrypoint
- each new package can be imported directly from its own built `dist/index.js` entrypoint with Node
- the repo contains clear local documentation explaining that the new package area is shell-only for now
- no legacy runtime code is imported into the new package area

Validation commands from the repository root:

- `npm --prefix packages run build`
- `node --input-type=module -e "import('./packages/utils/dist/index.js').then((m) => console.log(typeof m.assertNonEmptyString, typeof m.assertHeadersObject, Object.hasOwn(m, 'packageInfo')))"`
- `node --input-type=module -e "import('./packages/messages/dist/index.js').then((m) => console.log(m.packageInfo.name))"`
- `node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => console.log(typeof m.publishToIpfs, typeof m.readIpfsPublicGatewayText, Object.hasOwn(m, 'packageInfo')))"`
- `node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(typeof m.createHttpConfig, typeof m.requestEthereumJsonRpc, Object.hasOwn(m, 'packageInfo')))"`
- `node --test packages/utils/test/validation.test.js`
- `node --test packages/ipfs/test/publish.test.js`
- `node --test packages/ipfs/test/retrieval.test.js`

## Idempotence and Recovery

Creating package shells is safe to retry. If a future step needs to rename a package before functional code is added, the change is localized to the new `packages/` area and its documentation. No existing app/runtime code should depend on these shells yet, which keeps rollback straightforward at this stage.

## Artifacts and Notes

Current package names:

- `@oyaprotocol/utils`
- `@oyaprotocol/messages`
- `@oyaprotocol/ipfs`
- `@oyaprotocol/ethereum`

Placeholder public surface:

- `src/index.ts` exporting `packageInfo` for packages without real public functions yet
- compiled `dist/index.js` entrypoint with `dist/index.d.ts`

Current public surface in `@oyaprotocol/utils`:

- `CreateHttpConfigOptions`
- `HttpConfig`
- `assertHeadersObject(value, label, options)`
- `assertNonEmptyString(value, label)`
- `assertNonNegativeInteger(value, label)`
- `assertPositiveInteger(value, label)`
- `isPlainObject(value)`

Current additional public surface in `@oyaprotocol/ipfs`:

- `createIpfsConfig(options)`
- `publishToIpfs(options)`
- `readIpfsBytes(options)`
- `readIpfsText(options)`
- `readIpfsPublicGatewayBytes(options)`
- `readIpfsPublicGatewayText(options)`

Current public surface in `@oyaprotocol/ethereum`:

- `createHttpConfig(options)`
- `requestEthereumJsonRpc(options)`
- `EthereumJsonRpcError`
- `HttpStatusError`

## Interfaces and Dependencies

Interfaces introduced in this phase:

- package-root `exports` for each new `@oyaprotocol/*` package
- `packageInfo` placeholder export from package entrypoints that do not yet have real public functions

Interfaces introduced after the initial shell milestone:

- validation helpers from `@oyaprotocol/utils`
- `createIpfsConfig(options)` from `@oyaprotocol/ipfs`
- `publishToIpfs(options)` from `@oyaprotocol/ipfs`

Dependencies introduced in this phase:

- `@oyaprotocol/ipfs` and `@oyaprotocol/ethereum` depend on `@oyaprotocol/utils`
- no imports from legacy repo areas into `packages/`
