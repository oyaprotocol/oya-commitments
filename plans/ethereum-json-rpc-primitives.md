# Add Hardened Ethereum JSON-RPC Primitives

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Build the first hardened smart-contract interaction primitives for the Oya node by implementing a dependency-light Ethereum JSON-RPC surface in `@oyaprotocol/ethereum`.

After this work, Oya runtime code should be able to submit and observe Ethereum-compatible chain interactions through a small package that does not load environment variables, does not own private keys, does not assume a specific app runtime, and does not import legacy code from `agent/`, `agent-library/`, `node/`, or `frontend/`. The package should be useful for future node flows such as token transfers, proposing transactions to Optimistic Governor modules, disputing through Optimistic Oracle contracts, and logging IPFS CIDs to a future Oya Logger contract.

This plan intentionally does not define the Oya Logger contract. The future Logger design remains a separate contract/API task. This work should still support that intended use case by providing raw primitives for sending prepared calldata, waiting for receipts, and scanning logs.

Definitions used in this plan:

- Ethereum JSON-RPC: the standard HTTP-compatible request interface exposed by Ethereum execution nodes. Common methods include `eth_call`, `eth_estimateGas`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`, and `eth_getLogs`.
- Raw transaction: a fully signed transaction encoded as hex data. Submitting a raw transaction does not require this package to know about private keys.
- Calldata: hex-encoded contract call data. This package should validate and submit calldata but should not initially provide generic ABI encoding.
- Receipt: the chain record returned after a transaction is mined. A receipt includes status, gas usage, block location, and logs.
- Log: an event record emitted by a contract. Future Oya Logger discovery can be built by scanning logs for a Logger event once that contract is designed.

## Progress

- [x] 2026-05-02 23:17Z: Created this ExecPlan after reviewing `PLANS.md`, `packages/AGENTS.md`, the completed IPFS kernel package, the placeholder Ethereum package, and reference-only legacy transaction code.
- [x] 2026-05-03 00:11Z: Updated command instructions to use the repository root rather than a machine-specific absolute clone path.
- [x] 2026-05-03 00:18Z: Renamed the package shell from `@oyaprotocol/transactions` in `packages/transactions` to `@oyaprotocol/ethereum` in `packages/ethereum`, and updated this ExecPlan to match.
- [x] 2026-05-03 02:01Z: Implemented the package-local Ethereum RPC transport config and raw JSON-RPC request primitive.
- [ ] Add Ethereum method wrappers for calls, gas estimation, raw transaction submission, receipts, receipt waiting, chain/block metadata, and logs.
- [x] 2026-05-03 02:01Z: Added focused Milestone 1 tests against fake `fetch` implementations with no external RPC calls.
- [ ] Add focused method-wrapper tests after Milestone 2 exists.
- [x] 2026-05-03 02:01Z: Documented the current Milestone 1 package surface in `packages/ethereum/README.md`.
- [ ] Document the public package surface and future Logger compatibility boundaries.
- [x] 2026-05-03 02:01Z: Validated the Milestone 1 package build, package-root import, package-name import, focused tests, and diff hygiene.
- [x] 2026-05-03 20:48Z: Removed `packageInfo` from the non-placeholder Ethereum package export and updated smoke imports to check real package functions instead.
- [x] 2026-05-03 21:15Z: Moved validation helpers shared with IPFS into `@oyaprotocol/utils` and made Ethereum import them through the package root.
- [x] 2026-05-03 21:35Z: Replaced the package-branded `EthereumRpcConfig` type with shared `HttpConfig` / `CreateHttpConfigOptions` from `@oyaprotocol/utils`; `createEthereumRpcConfig(...)` now accepts and returns the generic `url`-based HTTP config shape.
- [x] 2026-05-03 21:42Z: Gated JSON-RPC retries to read-only Ethereum methods and `eth_sendRawTransaction`, preventing retry replays for arbitrary state-changing methods.
- [x] 2026-05-03 21:51Z: Moved shared HTTP config validation/freezing into `@oyaprotocol/utils` as `createHttpConfig(...)`; Ethereum and IPFS now keep only their public creator names and package-specific URL normalization.

## Surprises & Discoveries

- Observation: The Ethereum kernel package started as a placeholder and now has its first partial surface.
  Evidence: before Milestone 1, `packages/ethereum/src/index.ts` exported only `packageInfo`; after Milestone 1, it exports `createEthereumRpcConfig(...)`, `requestEthereumJsonRpc(...)`, and JSON-RPC error classes.

- Observation: The hardened package area must treat existing runtime code as reference material only.
  Evidence: `packages/AGENTS.md` says production-kernel code must not import from `agent/`, `agent-library/`, `node/`, or `frontend/`.

- Observation: The legacy agent already has app-layer generic contract-call encoding through `viem`.
  Evidence: `agent/src/lib/tx.js` has a `contract_call` action that parses a function signature string and uses `encodeFunctionData(...)`. This is useful reference material but should not be imported into `packages/ethereum`.

- Observation: The completed IPFS package is the best local model for this work.
  Evidence: `packages/ipfs` uses explicit config, injected `fetch`, timeout/retry handling, package-root exports, built TypeScript declarations, and focused tests against fake transports.

- Observation: The raw JSON-RPC primitive should reject `bigint` params before calling `fetch`.
  Evidence: JSON cannot encode `bigint`, and `packages/ethereum/test/rpc.test.js` now verifies callers get a clear error instructing them to convert bigint values to Ethereum quantity hex first.

## Decision Log

- Decision: Implement the first smart-contract interaction primitives in `packages/ethereum`.
  Rationale: The work is about chain transaction and call mechanics, and `@oyaprotocol/ethereum` already exists as the intended hardened package shell.
  Date/Author: 2026-05-02 / Codex.

- Decision: Keep the first package version free of external runtime dependencies.
  Rationale: Raw Ethereum JSON-RPC can be implemented with injected `fetch`, JSON, `AbortController`, and local validation. Avoiding `viem`, `ethers`, or ABI packages keeps the kernel surface smaller and easier to audit. A small internal dependency on `@oyaprotocol/utils` is acceptable for shared package validation helpers.
  Date/Author: 2026-05-02 / Codex.

- Decision: Do not implement private-key signing in the hardened package yet.
  Rationale: Signing expands the security surface and dependency pressure. The first kernel should submit already signed raw transactions or use caller-injected signing/submission at the node layer.
  Date/Author: 2026-05-02 / Codex.

- Decision: Do not implement generic ABI encoding in the first milestone.
  Rationale: ABI encoding is useful, but it is not required for raw JSON-RPC primitives. Initial callers can provide prepared calldata from existing app-layer code, and future package work can add narrow, reviewed encoders once concrete contract interfaces settle.
  Date/Author: 2026-05-02 / Codex.

- Decision: Include `eth_getLogs` and receipt helpers even though the Logger contract is deferred.
  Rationale: Any future onchain CID index needs event discovery, and other Oya flows need transaction confirmation. Supporting logs and receipts now keeps the primitives aligned with the future Logger use case without designing the contract.
  Date/Author: 2026-05-02 / Codex.

- Decision: Rename the package shell to `@oyaprotocol/ethereum` under `packages/ethereum`.
  Rationale: The package is intended to hold Ethereum JSON-RPC primitives rather than all transaction-domain behavior, and this follows the package naming convention used by `@oyaprotocol/ipfs`.
  Date/Author: 2026-05-03 / Codex.

- Decision: Keep Ethereum validation and request helpers package-local for Milestone 1, even where they resemble IPFS helpers.
  Rationale: The second package should prove the common shape before `@oyaprotocol/utils` gains public utility APIs. This keeps the first Ethereum diff local and avoids premature cross-package coupling.
  Date/Author: 2026-05-03 / Codex.

- Decision: Move shared validation helpers into `@oyaprotocol/utils`.
  Rationale: `assertHeadersObject(...)`, `assertNonEmptyString(...)`, `assertNonNegativeInteger(...)`, `assertPositiveInteger(...)`, and `isPlainObject(...)` were identical across IPFS and Ethereum after the second package proved the common shape. A package-root `@oyaprotocol/utils` import now removes duplication without importing from legacy runtime areas.
  Date/Author: 2026-05-03 / Codex.

- Decision: Move shared HTTP config creation into `@oyaprotocol/utils`.
  Rationale: After both IPFS and Ethereum adopted the same `HttpConfig` / `CreateHttpConfigOptions` shape, their creator functions duplicated all validation and freezing behavior. A small `createHttpConfig(...)` helper centralizes the common policy while preserving `createIpfsConfig(...)` and `createEthereumRpcConfig(...)` as package-root APIs with package-specific URL normalization.
  Date/Author: 2026-05-03 / Codex.

## Outcomes & Retrospective

This section starts empty except for the initial planning outcome. Update it after each milestone with what changed, which commands were run, and what evidence proves the package works.

Initial planning outcome: the scope is limited to dependency-light Ethereum JSON-RPC primitives in `@oyaprotocol/ethereum`. Future Oya Logger contract design, generic ABI encoding, private-key signing, node runtime wiring, and agent-specific behavior are explicitly out of scope for the first implementation pass.

Rename outcome: the package now lives at `packages/ethereum`, and its package root is `@oyaprotocol/ethereum`. The workspace manifest, TypeScript project references, package lockfile, package README, source entrypoint, generated `dist/` files, and local npm workspace link were updated to match.

Current validation evidence for the package set after the rename:

- `npm --prefix packages run build`
- `node --input-type=module -e "Promise.all(['./packages/utils/dist/index.js','./packages/messages/dist/index.js','./packages/ipfs/dist/index.js','./packages/ethereum/dist/index.js'].map((path) => import(path))).then(([utils, messages, ipfs, ethereum]) => { console.log(typeof utils.assertNonEmptyString, typeof messages.packageInfo, typeof ipfs.publishToIpfs, typeof ethereum.createEthereumRpcConfig); })"` printed `function object function function`.
- From `packages/`, `node --input-type=module -e "import('@oyaprotocol/ethereum').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.requestEthereumJsonRpc))"` printed `function function`.
- `git diff --check`

Milestone 1 is complete. `@oyaprotocol/ethereum` now exposes `createEthereumRpcConfig(...)`, `requestEthereumJsonRpc(...)`, `EthereumJsonRpcError`, and `EthereumJsonRpcHttpError` through the package root. The implementation lives in `packages/ethereum/src/config.ts` and `packages/ethereum/src/request-utils.ts`, with shared validation imported from `@oyaprotocol/utils`. The package remains dependency-light and does not import from legacy runtime areas.

The request primitive sends one JSON-RPC POST with explicit config and injected `fetch`, owns the `content-type: application/json` header, enforces timeouts even when fetch ignores abort signals, retries transient HTTP/network failures only for read-only Ethereum methods and `eth_sendRawTransaction`, surfaces JSON-RPC error payloads as inspectable non-retryable errors, and returns the raw `result` plus attempt metadata. It expects callers to pass JSON-serializable params; future wrappers should convert bigint values to Ethereum quantity hex before calling it.

Validation evidence for Milestone 1:

- `npm --prefix packages run build`
- `node --test packages/ethereum/test/rpc.test.js` passed 11 tests.
- `node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.requestEthereumJsonRpc, typeof m.EthereumJsonRpcError))"` printed `function function function`.
- From `packages/`, `node --input-type=module -e "import('@oyaprotocol/ethereum').then((m) => console.log(typeof m.requestEthereumJsonRpc))"` printed `function`.
- `git diff --check`

Package export cleanup removed the old placeholder-style `packageInfo` object from `@oyaprotocol/ethereum` now that the package has real public functions. Smoke imports now check `createEthereumRpcConfig(...)`, `requestEthereumJsonRpc(...)`, and related real exports rather than package metadata.

Validation evidence for package export cleanup:

- `npm --prefix packages run build`
- `node --test packages/ethereum/test/rpc.test.js` passed 11 tests.
- `node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.requestEthereumJsonRpc, Object.hasOwn(m, 'packageInfo')))"` printed `function function false`.
- From `packages/`, `node --input-type=module -e "import('@oyaprotocol/ethereum').then((m) => console.log(typeof m.requestEthereumJsonRpc, Object.hasOwn(m, 'packageInfo')))"` printed `function false`.
- `node --input-type=module -e "Promise.all(['./packages/utils/dist/index.js','./packages/messages/dist/index.js','./packages/ipfs/dist/index.js','./packages/ethereum/dist/index.js'].map((path) => import(path))).then(([utils, messages, ipfs, ethereum]) => { console.log(typeof utils.assertNonEmptyString, typeof messages.packageInfo, typeof ipfs.publishToIpfs, typeof ethereum.createEthereumRpcConfig); })"` printed `function object function function`.
- `git diff --check`

Shared validation cleanup moved the helpers duplicated between Ethereum and IPFS into `@oyaprotocol/utils`. Ethereum now depends on `@oyaprotocol/utils` through the workspace package graph, imports validation helpers from the package root, and no longer has `packages/ethereum/src/validation-utils.ts`.

Validation evidence for shared validation cleanup:

- `npm --prefix packages run build`
- `node --test packages/utils/test/validation.test.js` passed 3 tests.
- `node --test packages/ethereum/test/rpc.test.js` passed 11 tests.
- From `packages/`, `node --input-type=module -e "import('@oyaprotocol/ethereum').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.requestEthereumJsonRpc, Object.hasOwn(m, 'packageInfo')))"` printed `function function false`.
- `node --input-type=module -e "Promise.all(['./packages/utils/dist/index.js','./packages/messages/dist/index.js','./packages/ipfs/dist/index.js','./packages/ethereum/dist/index.js'].map((path) => import(path))).then(([utils, messages, ipfs, ethereum]) => { console.log(typeof utils.assertNonEmptyString, typeof messages.packageInfo, typeof ipfs.publishToIpfs, typeof ethereum.createEthereumRpcConfig); })"` printed `function object function function`.
- `git diff --check`

HTTP config cleanup moved the public config interfaces to `@oyaprotocol/utils` as `HttpConfig` and `CreateHttpConfigOptions`. Ethereum now uses the generic `url` field, while `createEthereumRpcConfig(...)` still owns Ethereum-specific normalization by trimming trailing slashes before JSON-RPC requests are sent.

Retry safety cleanup added a fixed method allowlist to the raw JSON-RPC request primitive. The helper retries read-only Ethereum JSON-RPC methods and `eth_sendRawTransaction`, but it does not retry arbitrary methods such as `evm_*`, `anvil_*`, `personal_*`, `admin_*`, `miner_*`, or `eth_sendTransaction`.

Shared HTTP config creator cleanup added `createHttpConfig(...)` to `@oyaprotocol/utils`. `createEthereumRpcConfig(...)` now delegates directly to it, while `createIpfsConfig(...)` delegates with its Kubo `/api/v0` base URL normalizer. The public package creators remain unchanged.

Validation evidence for shared HTTP config creator cleanup:

- `npm run build` from `packages/`
- `node --test packages/utils/test/validation.test.js` passed 4 tests.
- `node --test packages/ipfs/test/publish.test.js packages/ipfs/test/retrieval.test.js` passed 44 tests.
- `node --test packages/ethereum/test/rpc.test.js` passed 14 tests.
- From `packages/`, package-root smoke imports for `@oyaprotocol/utils`, `@oyaprotocol/ipfs`, and `@oyaprotocol/ethereum` printed `function function false`.
- `git diff --check`

## Context and Orientation

The repository has a newer hardened-kernel area under `packages/`. Local instructions for this area live in `packages/AGENTS.md`. Those instructions require package-root public exports, small reviewable package shells, no imports from legacy runtime areas, and validation with `npm run build` from `packages/`.

The current package layout relevant to this work is:

- `packages/package.json`: workspace manifest and TypeScript build scripts for kernel packages.
- `packages/tsconfig.json` and `packages/tsconfig.base.json`: TypeScript project configuration for all kernel packages.
- `packages/ethereum/package.json`: package manifest for `@oyaprotocol/ethereum`, exporting `./dist/index.js`.
- `packages/ethereum/src/index.ts`: exports the current config/request public surface.
- `packages/ethereum/src/config.ts`: validates explicit Ethereum JSON-RPC transport settings.
- `packages/ethereum/src/request-utils.ts`: contains the raw JSON-RPC request primitive, JSON-RPC error classes, timeout/abort/retry handling, and fetch-like types.
- `packages/utils/src/validation-utils.ts`: contains shared validation helpers used by Ethereum and IPFS.
- `packages/ethereum/test/rpc.test.js`: tests the built JSON-RPC request surface against fake `fetch` implementations.
- `packages/ethereum/README.md`: documents the current Milestone 1 surface.
- `packages/ipfs/src/config.ts`, `packages/ipfs/src/request-utils.ts`, and `packages/ipfs/test/*.test.js`: reference patterns for strict config, injected fetch, timeout/retry behavior, abort handling, and focused tests.

Reference-only runtime code:

- `agent/src/lib/tx.js`: contains existing transaction-building and Optimistic Governor proposal helpers using `viem`.
- `agent/src/lib/runtime-bootstrap.js`: creates existing `viem` public clients for the legacy agent runtime.
- `agent/src/lib/og.js`: contains Optimistic Governor ABI reference material.

This plan does not require Solidity changes. It does not touch `src/`, `script/`, or `test/` for contracts. It also does not wire the new package into `agent/`, `agent-library/`, or `node/` during the first package milestone.

## Plan of Work

Milestone 1: Create the package-local RPC transport surface. This milestone is complete.

Add `packages/ethereum/src/config.ts`, `packages/ethereum/src/request-utils.ts`, and any small validation helpers needed locally. Export `createEthereumRpcConfig(...)`, `requestEthereumJsonRpc(...)`, and related types from `packages/ethereum/src/index.ts`.

`createEthereumRpcConfig(...)` should require explicit `url`, `headers`, `timeoutMs`, `maxRetries`, and `retryDelayMs`. It should normalize trailing slashes from the RPC URL, freeze validated headers, reject non-plain header objects, require positive timeout, and require non-negative retry settings.

`requestEthereumJsonRpc(...)` should accept explicit `config`, explicit injected `fetch`, a non-empty JSON-RPC method string, an array of params, and an optional caller `AbortSignal`. It should send a POST request with `content-type: application/json`, preserve configured headers except for disallowing caller-provided `content-type`, enforce timeout even if the injected fetch ignores signals, retry transient HTTP or network failures, parse JSON, throw inspectable errors for JSON-RPC error responses, and return the result plus attempt metadata.

Milestone 2: Add Ethereum method wrappers and hex validation.

Add `packages/ethereum/src/ethereum.ts` or equivalent package-local module for method wrappers. Export:

- `ethChainId(...)`
- `ethBlockNumber(...)`
- `ethCall(...)`
- `ethEstimateGas(...)`
- `ethSendRawTransaction(...)`
- `ethGetTransactionReceipt(...)`
- `ethWaitForTransactionReceipt(...)`
- `ethGetLogs(...)`

Add small local validators and converters for:

- 20-byte address hex strings.
- 32-byte hash hex strings.
- arbitrary hex data strings.
- Ethereum quantity hex strings.
- conversion from non-negative `bigint` or safe integer to quantity hex.
- conversion from quantity hex to `bigint`.

Do not implement checksum validation in this milestone because that requires Keccak hashing or an external dependency. Syntactic address validation is enough for this low-level JSON-RPC package.

`ethCall(...)` and `ethEstimateGas(...)` should accept a transaction call object with `to`, optional `from`, optional `data`, optional `value`, optional `gas`, and optional block tag where applicable. They should normalize quantities to compact Ethereum quantity hex and keep calldata as hex data. `ethCall(...)` should return raw hex data.

`ethSendRawTransaction(...)` should accept a signed raw transaction hex string and return a transaction hash. It should not sign.

`ethGetTransactionReceipt(...)` should return either a normalized receipt object or `null` when the node returns `null`.

`ethWaitForTransactionReceipt(...)` should poll `eth_getTransactionReceipt` until a receipt appears or until a caller-provided timeout expires. It should use an explicit `pollIntervalMs`, respect caller abort, return the receipt plus poll count, and not treat a pending transaction as an error before timeout.

`ethGetLogs(...)` should accept a filter with optional `fromBlock`, `toBlock`, `address`, and `topics`. It should validate the shape but not impose application-specific chunking. Documentation must tell callers to chunk large ranges at the runtime layer.

Milestone 3: Add focused tests. The Milestone 1 request/config tests are complete; wrapper, receipt, and log tests remain for Milestone 2.

Add tests under `packages/ethereum/test/`, modeled after the IPFS package tests. Tests should import from `../dist/index.js`, so they validate the package build output rather than TypeScript source.

Required test coverage:

- Config creation requires explicit fields, normalizes RPC URLs, freezes headers, and rejects caller-provided `content-type`.
- The raw request primitive sends POST JSON-RPC with injected headers and returns result plus attempt count.
- Retry occurs on HTTP 429 or 5xx, timeout, and retryable network errors only when the JSON-RPC method is in the package's retry allowlist.
- Retry does not occur on HTTP 400 or JSON-RPC contract errors.
- Timeout still works when injected fetch ignores `options.signal`.
- Caller abort prevents the first request when already aborted and interrupts retry backoff.
- JSON parse failures and JSON-RPC error responses produce useful errors.
- Hex validators reject malformed addresses, hashes, quantities, and calldata.
- `ethCall`, `ethEstimateGas`, `ethSendRawTransaction`, and `ethGetLogs` produce the expected JSON-RPC method names and params.
- `ethGetTransactionReceipt` returns `null` for pending transactions and a normalized object for mined transactions.
- `ethWaitForTransactionReceipt` polls through pending responses, returns after a mined receipt, and times out clearly.

Milestone 4: Document the package and future integration boundaries.

Update `packages/ethereum/README.md` to describe:

- The package as a hardened Ethereum JSON-RPC primitive package.
- The explicit config and injected `fetch` model.
- The no external runtime dependency and no-signing constraints.
- The fact that contract-specific calldata must be prepared by callers for now.
- How future Oya flows can use the primitives for token transfers, Optimistic Governor proposals, Optimistic Oracle disputes, and future Logger CID submissions.
- How future Logger indexing can use `eth_getLogs` once the contract event shape exists.

Milestone 5: Optional node integration plan, not implementation.

After the package primitives are validated, update this ExecPlan with a follow-on section or create a new ExecPlan for node adoption. The adoption plan should decide whether the first runtime consumer is `node/` or legacy `agent/`, and should keep signer/key handling outside the package.

## Concrete Steps

All commands below assume they are run from the repository root, the directory that contains `AGENTS.md`, `PLANS.md`, and `packages/`, unless otherwise stated.

1. Reconfirm local instructions and current state:

       sed -n '1,120p' packages/AGENTS.md
       git status --short

2. Inspect the current package and IPFS patterns:

       sed -n '1,160p' packages/ethereum/src/index.ts
       sed -n '1,160p' packages/ethereum/README.md
       sed -n '1,220p' packages/ipfs/src/config.ts
       sed -n '1,260p' packages/ipfs/src/request-utils.ts

3. Implement Milestone 1 in package-local files:

       packages/ethereum/src/config.ts
       packages/ethereum/src/request-utils.ts
      packages/ethereum/src/index.ts

   Import shared validation helpers from `@oyaprotocol/utils`; keep Ethereum-specific helpers package-local unless they become public API through `src/index.ts`.

4. Build the package workspace:

       npm --prefix packages run build

   Expected behavior: TypeScript builds all kernel packages and emits updated `packages/ethereum/dist/*` files.

5. Add Milestone 1 tests:

       packages/ethereum/test/rpc.test.js

   Run:

       node --test packages/ethereum/test/rpc.test.js

   Expected behavior: all tests pass using fake `fetch` implementations and no network access.

6. Implement Milestone 2 method wrappers and validators:

       packages/ethereum/src/ethereum.ts
       packages/ethereum/src/hex.ts
       packages/ethereum/src/index.ts

   The exact helper filenames can change if implementation reveals a cleaner package-local split. Update this plan if filenames differ.

7. Build and test wrappers:

       npm --prefix packages run build
       node --test packages/ethereum/test/rpc.test.js
       node --test packages/ethereum/test/ethereum.test.js

8. Smoke-import the package root:

       node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"

   Expected behavior: the output includes `createEthereumRpcConfig`, `requestEthereumJsonRpc`, and the exported `eth*` wrappers.

9. Update package documentation:

       packages/ethereum/README.md

10. Run final validation:

       npm --prefix packages run build
       node --test packages/ethereum/test/rpc.test.js
       node --test packages/ethereum/test/ethereum.test.js
       node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.ethCall))"
       git diff --check

11. Update this ExecPlan before yielding control:

       plans/ethereum-json-rpc-primitives.md

   Mark completed progress entries with timestamps, add validation evidence to `Outcomes & Retrospective`, and record any implementation discoveries or decisions.

## Validation and Acceptance

Acceptance criteria for the first implementation pass:

- `@oyaprotocol/ethereum` exposes dependency-light Ethereum JSON-RPC primitives through the package root.
- The package has no runtime dependencies added to `packages/ethereum/package.json`.
- The package does not import from `agent/`, `agent-library/`, `node/`, or `frontend/`.
- All transport behavior requires explicit config and injected `fetch`.
- Contract write submission is supported only through signed raw transaction submission, not package-owned private-key signing.
- Contract reads and gas estimation accept caller-provided calldata and return raw hex data or normalized metadata.
- Receipt waiting can observe a pending transaction until it becomes mined or times out.
- Log scanning can request raw logs by address/topic/range, supporting a future Logger event index without defining the Logger contract now.
- Focused tests use fake transports and require no RPC endpoint, secrets, private keys, Anvil instance, or network access.

Required validation commands:

    npm --prefix packages run build
    node --test packages/ethereum/test/rpc.test.js
    node --test packages/ethereum/test/ethereum.test.js
    node --input-type=module -e "import('./packages/ethereum/dist/index.js').then((m) => console.log(typeof m.createEthereumRpcConfig, typeof m.ethCall))"
    git diff --check

Optional later integration validation, not part of the first package milestone:

    anvil

Then, in a separate shell, run a future smoke script that sends a simple funded transaction or deploys/calls a tiny test contract. This optional integration test should be designed in a follow-on plan because the current plan avoids runtime signer ownership.

## Idempotence and Recovery

The package implementation is safe to retry. Re-running `npm --prefix packages run build` overwrites generated `dist/` files from TypeScript source. Re-running `node --test ...` has no external side effects because tests use fake `fetch` implementations.

If a test fails after partial implementation, prefer fixing source files under `packages/ethereum/src/` and rebuilding. Do not edit generated `dist/` files by hand. If generated files become stale, rerun the package build.

If a future implementation accidentally adds dependencies to `packages/ethereum/package.json`, pause and justify the dependency in this plan before continuing. The default target is zero runtime dependencies.

If a future implementation needs ABI encoding, private-key signing, or contract-specific helpers to proceed, do not silently broaden this plan. Record the blocker in `Surprises & Discoveries`, add a decision entry, and either create a follow-on plan or get user approval for the expanded scope.

If unrelated local changes appear in the worktree, leave them alone. Only modify the `packages/ethereum/` files and this plan unless a validation or documentation update requires a tightly scoped additional file.

## Artifacts and Notes

Current package evidence:

- `packages/ethereum/src/index.ts` exports `createEthereumRpcConfig(...)`, `requestEthereumJsonRpc(...)`, `EthereumJsonRpcError`, `EthereumJsonRpcHttpError`, and public transport/request types.
- `packages/ethereum/README.md` documents the current JSON-RPC config/request surface.
- `packages/ethereum/test/rpc.test.js` validates the Milestone 1 surface against fake fetch implementations with no network access.
- `packages/ipfs` demonstrates the current hardened package style: strict config, explicit injected dependencies, timeout/retry helpers, built TypeScript output, and Node tests against `dist`.
- `agent/src/lib/tx.js` has existing app-layer `viem` usage for reference only; it should not be imported by the package.

Design notes for the future Oya Logger use case:

- The future Logger contract can be event-first. This plan does not choose event names, fields, CID encoding, or storage behavior.
- The JSON-RPC package must be able to submit prepared Logger calldata through a signed raw transaction and wait for the resulting receipt.
- The JSON-RPC package must be able to scan logs once the Logger event address and topics are known.
- CID string validation, IPFS publication, and Logger event schema validation belong outside this first transaction primitive milestone.

Design notes for token transfers, Optimistic Governor proposals, and Optimistic Oracle disputes:

- Token transfers and contract interactions require calldata. For now, callers prepare calldata outside this package.
- Optimistic Governor proposal and dispute flows need reads, gas estimation, transaction submission, receipts, and possibly logs. The wrappers in this plan support those mechanics without encoding the contract-specific business logic.
- Package-level support for ERC20 transfer calldata or Oya-specific contract calldata can be added later as narrow helpers after raw JSON-RPC behavior is stable.

## Interfaces and Dependencies

Public interfaces planned for `@oyaprotocol/ethereum`:

- `createEthereumRpcConfig(options)`
- `requestEthereumJsonRpc(options)`
- `ethChainId(options)`
- `ethBlockNumber(options)`
- `ethCall(options)`
- `ethEstimateGas(options)`
- `ethSendRawTransaction(options)`
- `ethGetTransactionReceipt(options)`
- `ethWaitForTransactionReceipt(options)`
- `ethGetLogs(options)`
- Types for config, fetch-like transport, request options, call objects, log filters, receipts, and result objects.
- An inspectable JSON-RPC error type, tentatively `EthereumJsonRpcError`, with `code`, optional `data`, method name, and raw error payload.

Internal interfaces likely needed:

- `assertNonEmptyString(...)`
- `assertPositiveInteger(...)`
- `assertNonNegativeInteger(...)`
- `assertHeadersObject(...)`
- `normalizeAddress(...)`
- `normalizeHash(...)`
- `normalizeHexData(...)`
- `toQuantityHex(...)`
- `quantityHexToBigInt(...)`
- timeout, abort-composition, retry-delay, and retry-classification helpers modeled after `packages/ipfs/src/request-utils.ts`.

Runtime dependencies:

- No external npm runtime dependencies for the first milestone.
- Use standard JavaScript and Web APIs available in supported Node runtimes: `fetch` shape supplied by caller, `AbortController`, `AbortSignal`, `setTimeout`, `clearTimeout`, `JSON`, and `BigInt`.

External services:

- None for unit tests.
- Future runtime use requires an Ethereum-compatible JSON-RPC endpoint supplied by the caller, such as a local Anvil node, a self-hosted execution node, or a provider endpoint.

Secrets and credentials:

- None for package tests.
- Runtime RPC endpoints may require headers or tokens. The package accepts explicit headers but does not read secrets from environment variables or files.

Out-of-scope interfaces for this plan:

- Oya Logger Solidity contract.
- Contract deployment scripts.
- Private-key management or transaction signing.
- Generic ABI encoding and decoding.
- Node runtime wiring.
- Agent-specific behavior under `agent-library/agents/<name>/`.
