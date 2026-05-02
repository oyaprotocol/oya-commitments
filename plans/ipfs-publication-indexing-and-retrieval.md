# Harden IPFS Add-And-Pin Publication and Retrieval

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Oya nodes already have the beginning of a hardened kernel primitive for publishing bytes or text to IPFS. The next immediate goal is post-publication retrieval: any data an Oya node publishes should be pinned by the node and easy to retrieve later by CID.

This plan keeps the near-term package work intentionally small. First, IPFS add-and-pin behavior becomes explicit while staying simple: the standard Oya path adds and pins in one Kubo request. Then the IPFS package gets a low-level retrieval primitive for safe artifact reads from a Kubo-compatible node. Tests and documentation should cover both behaviors.

Public indexing is still important, but it is not part of the immediate package milestone. The likely future direction is an onchain Logger contract: nodes publish data to IPFS, then log CIDs onchain so the chain serves as a public append-only index linking node addresses to published CIDs and block timestamps. That future indexing design should get its own plan or a later section after the add-and-pin and retrieval primitives are complete.

Definitions used in this plan:

- IPFS: content-addressed storage where content is retrieved by a CID, a content identifier derived from the bytes.
- Kubo: the common IPFS node implementation whose local HTTP RPC API exposes endpoints such as `/api/v0/add`, `/api/v0/pin/add`, and `/api/v0/cat`.
- Publication artifact: the JSON, text, or bytes an Oya node publishes to IPFS.
- Pinning: instructing an IPFS node to retain content so local garbage collection does not remove it.
- Publication index: a mechanism for discovering published CIDs and related publication context. The exact fields are intentionally not specified yet.

## Progress

- [x] 2026-04-29 23:12Z: Created this follow-on ExecPlan after resolving the final open decision in `plans/hardened-kernel-packages.md`.
- [x] 2026-04-30 17:43Z: Amended the direction after user clarification: do not add a `pinOnAdd` boolean and do not create a separate pinning track; make the standard Kubo add request explicitly pin by default.
- [x] 2026-04-30 18:05Z: Simplified the immediate scope after user clarification: implement explicit add-and-pin, add low-level retrieval, and document/test retrieval now; defer index design to a future onchain Logger system.
- [x] 2026-04-30 19:09Z: Completed Milestone 1. `publishToIpfs(...)` now explicitly calls Kubo add with `pin=true`, returns `pinned: true`, and the package README/test coverage reflects the add-and-pin contract.
- [x] 2026-04-30 21:28Z: Completed Milestone 2. Added `readIpfsText(...)`, a bounded ASCII text retrieval primitive backed by Kubo `/api/v0/cat`, with timeout, retry, byte-limit, non-ASCII, and caller-abort coverage.
- [x] 2026-04-30 19:09Z: Added add-and-pin publication tests and documentation.
- [x] 2026-04-30 21:28Z: Added bounded ASCII text retrieval tests and README documentation.
- [x] 2026-04-30 21:45Z: Renamed the shared transport config surface to `createIpfsConfig(...)` / `IpfsConfig` now that it is used by both publication and retrieval.
- [x] 2026-04-30 22:02Z: Removed the old publish-specific config names instead of keeping compatibility aliases, per user clarification.
- [x] 2026-04-30 22:20Z: Consolidated shared IPFS request abort, timeout, retry-delay, and retryable-error helpers in package-internal `ipfs-request-utils.ts`.
- [x] 2026-04-30 22:34Z: Fixed `readIpfsText(...)` to cancel non-OK `/api/v0/cat` response bodies before retrying or throwing, preventing leaked fetch sockets under repeated failures.
- [x] 2026-04-30 22:43Z: Moved shared string and integer validators into package-internal `validation-utils.ts`.
- [x] 2026-05-01 19:16Z: Added `readIpfsBytes(...)` for bounded arbitrary byte retrieval and made `readIpfsText(...)` a text-specific wrapper over the byte primitive.
- [x] 2026-05-01 19:22Z: Replaced duplicate byte/text fetch type aliases with shared `ReadIpfsFetchLike`, `ReadIpfsFetchOptions`, and `ReadIpfsResponse` transport types.
- [x] 2026-05-01 19:27Z: Renamed publish transport types from generic `FetchLike` names to publish-scoped `PublishIpfsFetchLike`, `PublishIpfsRequestOptions`, and `PublishIpfsResponse`.
- [x] 2026-05-01 19:34Z: Replaced duplicate byte/text retrieval options with shared `ReadIpfsOptions`.
- [x] 2026-05-01 20:04Z: Replaced duplicate read/publish HTTP error marker types with shared internal `IpfsHttpError` request utility.
- [x] 2026-05-01 22:02Z: Centralized HTTP status and transport retry decisions in shared `shouldRetryError(...)`.
- [x] 2026-05-01 23:21Z: Added `readIpfsPublicGatewayBytes(...)` for bounded public gateway `GET /ipfs/<cid>` reads while keeping gateway retrieval separate from Kubo RPC helpers.
- [x] 2026-05-01 23:24Z: Added `readIpfsPublicGatewayText(...)` as an ASCII text wrapper over the public gateway byte reader.
- [x] 2026-05-02 20:56Z: Renamed read fetch-contract option types from request-oriented names to `ReadIpfsFetchOptions` and `ReadIpfsPublicGatewayFetchOptions`.
- [x] 2026-05-02 21:00Z: Consolidated duplicate read fallback-error normalization into shared internal `normalizeIpfsOperationError(...)`.
- [x] 2026-05-02 21:04Z: Consolidated header object validation into shared internal `assertHeadersObject(...)` while preserving Kubo config's `content-type` restriction and gateway read pass-through behavior.
- [x] 2026-05-02 21:10Z: Fixed public gateway read URL construction to use URL parsing, preserve query strings, reject fragments, and avoid duplicate `/ipfs/<cid>` path appends.
- [x] 2026-05-02 21:52Z: Renamed the package from `@oyaprotocol/publishing` in `packages/publishing` to `@oyaprotocol/ipfs` in `packages/ipfs`.
- [x] 2026-05-02 21:54Z: Tightened shared header validation to reject non-plain objects, preventing `Headers` instances from silently dropping entries via `Object.entries(...)`.
- [ ] Create or update a future plan for onchain CID logging and public indexing when ready.

## Surprises & Discoveries

- Observation: Pinning is retention, not discovery.
  Evidence: A pin protects a CID from garbage collection on the pinning node or service, but it does not tell customers or verifiers which CIDs correspond to a node, commitment, agent, request ID, market, proposal, trade log, or reimbursement request.

- Observation: Onchain CID logging can provide the public index instead of building a local durable index first.
  Evidence: a simple Logger contract can emit events that match a node address to a series of CIDs with block ordering and timestamps. Offchain consumers can scan those logs to discover the node's public publication history.

- Observation: The hardened `publishToIpfs(...)` primitive currently omits explicit pin behavior.
  Evidence: `packages/ipfs/src/publish-to-ipfs.ts` currently calls `/api/v0/add?cid-version=1&progress=false`. Kubo's add endpoint defaults to pinning, but the hardened kernel should not rely on an implicit provider default.

- Observation: A separate add-then-pin track is unnecessarily complex for the expected Oya artifact shape.
  Evidence: the expected artifacts are small text or JSON records, and the node can keep canonical local bytes. Retrying by re-adding the same canonical bytes is simpler than maintaining a second pinning state machine.

- Observation: The legacy message and proposal publication flows demonstrate a stricter lifecycle but are not the selected kernel path.
  Evidence: `agent/src/lib/message-publication-api.js` and `agent/src/lib/proposal-publication-api.js` add with `pin=false` and then pin separately. That remains useful reference material, but this plan chooses a simpler add-and-pin default for the hardened kernel.

- Observation: The hardened packages must not import the legacy runtime.
  Evidence: `packages/AGENTS.md` says existing code under `agent/`, `agent-library/`, `node/`, and `frontend/` is reference material only for the new kernel packages.

## Decision Log

- Decision: Start the next implementation inside `@oyaprotocol/ipfs`.
  Rationale: The existing raw IPFS add primitive already lives there, and pinning, indexing, and retrieval are publishing-domain concerns. Starting in the package keeps the next diff reviewable and avoids premature node wiring.
  Date/Author: 2026-04-29 / Codex.

- Decision: Use one explicit add-and-pin operation for the standard Oya publication path.
  Rationale: Kubo already supports pinning during `/api/v0/add`, and Oya artifacts are small enough that retrying by re-adding canonical bytes is simpler than supporting a separate pinning lifecycle. The request should include `pin=true` explicitly so the code does not rely on Kubo's default.
  Date/Author: 2026-04-30 / Codex.

- Decision: Do not add a `pinOnAdd` boolean to `publishToIpfs(...)`.
  Rationale: The user wants one standard behavior rather than another configurable branch. The package can stay strict by making `pin=true` explicit internally and documenting that `publishToIpfs(...)` is an add-and-pin primitive.
  Date/Author: 2026-04-30 / Codex.

- Decision: Do not create or support a separate pinning track in this plan.
  Rationale: Separate pin repair can be added later if an actual provider or recovery requirement needs it. Until then, the durable local canonical artifact store plus deterministic re-add retry is the simpler recovery model.
  Date/Author: 2026-04-30 / Codex.

- Decision: Defer publication indexing implementation to a future onchain Logger design.
  Rationale: A Logger contract can provide a public append-only index by emitting node-to-CID events with onchain ordering and timestamps. That is a cleaner public indexing direction than prematurely building a local package-level durable index whose fields are not yet settled.
  Date/Author: 2026-04-30 / Codex.

- Decision: Keep node-facing read APIs out of the immediate package milestone.
  Rationale: The immediate reusable kernel work is add-and-pin plus low-level retrieval. Public discovery and customer-facing access should be designed after the onchain indexing direction is specified.
  Date/Author: 2026-04-30 / Codex.

- Decision: Use `IpfsConfig` as the primary shared transport configuration name.
  Rationale: The same config now applies to both publish and read paths, so the old publish-specific config name is too narrow. The old publish-specific names are not retained as aliases because this package surface is still early and the user prefers one clear API.
  Date/Author: 2026-04-30 / Codex.

## Outcomes & Retrospective

Milestone 1 is complete. `publishToIpfs(...)` now explicitly requests add-and-pin behavior with `/api/v0/add?cid-version=1&pin=true&progress=false`, and `PublishToIpfsResult` reports `pinned: true`. The focused publishing test now proves the explicit URL and normalized pinned result.

Validation evidence for Milestone 1:

- `npm --prefix packages run build`
- `node --test packages/ipfs/test/publish-to-ipfs.test.js`
- `node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

Milestone 2 is complete. `readIpfsBytes(...)` reads known CIDs through `/api/v0/cat?arg=<cid>` and returns bounded arbitrary bytes. `readIpfsText(...)` wraps that byte primitive and adds ASCII verification plus text decoding for the immediate text-artifact use case. Both require `maxBytes`, support caller cancellation, and use the same explicit transport config pattern as publication.

Follow-up cleanup renamed the shared transport config to `createIpfsConfig(...)` / `IpfsConfig`. The old publish-specific config names were removed rather than retained as aliases, so new package code and tests use the neutral names exclusively.

Follow-up request cleanup centralized shared abort, timeout, retry-delay, and retryable-error mechanics in package-internal `ipfs-request-utils.ts`. `publishToIpfs(...)` and `readIpfsText(...)` now keep their operation-specific validation and error messages locally while sharing generic request-control behavior.

Review cleanup fixed the non-OK retrieval response path so `readIpfsText(...)` cancels failed `/api/v0/cat` response bodies before retrying or throwing. This keeps Node/Undici-style fetch connections from being held by unconsumed error bodies.

Validation cleanup moved shared string and integer checks into package-internal `validation-utils.ts`; IPFS config keeps only config-specific header validation locally.

Retrieval follow-up split the Kubo RPC read path into `readIpfsBytes(...)` for arbitrary bounded bytes and `readIpfsText(...)` for bounded ASCII text verification. This keeps future byte-oriented use cases available without weakening the current text-specific verification path.

Type cleanup replaced duplicate byte/text fetch aliases with shared read transport types. The data-specific public types are now the byte/text options and results, while `ReadIpfsFetchLike`, `ReadIpfsFetchOptions`, and `ReadIpfsResponse` describe the common Kubo `/api/v0/cat` fetch contract.

Publish type cleanup renamed the publishing fetch contract to `PublishIpfsFetchLike`, `PublishIpfsRequestOptions`, and `PublishIpfsResponse` so it is not confused with the read transport contract.

Read options cleanup replaced duplicate byte/text options with shared `ReadIpfsOptions`; byte and text helpers now differ only in result shape and text-specific ASCII verification.

Request error cleanup moved status-bearing HTTP failures into shared internal `IpfsHttpError` in `ipfs-request-utils.ts`; publish and read use the same marker to keep HTTP failures distinct from retryable network errors.

Retry cleanup moved both HTTP status retry policy and transport-error retry policy into shared `shouldRetryError(...)`, so publish and read use one retry decision path after errors are created.

Public gateway retrieval follow-up added `readIpfsPublicGatewayBytes(...)`, a bounded byte reader for public gateway-style `GET /ipfs/<cid>` endpoints. It uses explicit gateway URL, headers, timeout, retry, byte-limit, and injected fetch dependencies, while reusing the same bounded stream reading behavior as Kubo retrieval.

Public gateway text retrieval follow-up added `readIpfsPublicGatewayText(...)`, which mirrors the Kubo reader split by wrapping the public gateway byte reader and adding ASCII verification plus text decoding.

Read error cleanup moved duplicate fallback error-message handling from the Kubo and public gateway byte readers into package-internal `normalizeIpfsOperationError(...)` and `IpfsOperationErrorMessages` in `ipfs-request-utils.ts`.

Header validation cleanup moved duplicate header shape checking into package-internal `assertHeadersObject(...)` in `validation-utils.ts`. `createIpfsConfig(...)` passes `content-type` as a disallowed header for Kubo/FormData safety, while public gateway reads use the shared shape check without that restriction.

Public gateway URL cleanup replaced string concatenation with URL parsing in `buildGatewayReadUrl(...)`. Gateway query strings are preserved for signed/authenticated endpoints, fragments are rejected because they are not sent to servers, and the fetch call now uses the final URL directly.

Package rename cleanup moved the hardened IPFS package from `packages/publishing` to `packages/ipfs` and renamed the package entrypoint from `@oyaprotocol/publishing` to `@oyaprotocol/ipfs`. This matches the package's current responsibility: IPFS add-and-pin plus Kubo and public-gateway retrieval.

Header safety cleanup made `assertHeadersObject(...)` reject non-plain objects such as native `Headers` instances. The public API continues to require `Record<string, string>` headers, and JavaScript callers now get an explicit validation error instead of silently sending requests with dropped headers.

Validation evidence for Milestone 2:

- `npm --prefix packages run build`
- `node --test packages/ipfs/test/ipfs-retrieval.test.js`
- `node --test packages/ipfs/test/publish-to-ipfs.test.js`
- `node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

Remaining near-term work is documentation polish if reviewers request it. Future public indexing should be handled in a separate onchain Logger plan.

## Context and Orientation

The hardened package area lives under `packages/`. The relevant local instructions are in `packages/AGENTS.md`: packages should be importable by package root, should not deep-import legacy runtime code, and should avoid app wiring, CLI code, environment loading, and repo-specific startup logic.

Current package files:

- `packages/ipfs/src/ipfs-config.ts`: validates explicit IPFS transport settings.
- `packages/ipfs/src/ipfs-request-utils.ts`: contains shared retry, timeout, abort, HTTP error, and operation-error normalization helpers for IPFS HTTP requests.
- `packages/ipfs/src/validation-utils.ts`: contains shared internal validation helpers, including header object validation.
- `packages/ipfs/src/publish-to-ipfs.ts`: publishes content to Kubo `/api/v0/add` using injected `fetch`.
- `packages/ipfs/src/read-ipfs-bytes.ts`: reads bounded arbitrary byte content from Kubo `/api/v0/cat` using injected `fetch`.
- `packages/ipfs/src/read-ipfs-public-gateway-bytes.ts`: reads bounded arbitrary byte content from public gateway `GET /ipfs/<cid>` endpoints using injected `fetch`.
- `packages/ipfs/src/read-ipfs-public-gateway-text.ts`: reads bounded ASCII text content through `readIpfsPublicGatewayBytes(...)` and text-specific verification.
- `packages/ipfs/src/read-ipfs-text.ts`: reads bounded ASCII text content through `readIpfsBytes(...)` and text-specific verification.
- `packages/ipfs/src/index.ts`: exports the public package surface.
- `packages/ipfs/test/publish-to-ipfs.test.js`: tests the built package entrypoint.
- `packages/ipfs/test/ipfs-retrieval.test.js`: tests the built retrieval entrypoint.

Reference-only legacy files:

- `agent/src/lib/ipfs.js`: contains the older add and separate pin helpers.
- `agent/src/lib/message-publication-store.js`: durable JSON store for signed message publication records.
- `agent/src/lib/proposal-publication-store.js`: durable JSON store for proposal publication records.
- `agent/src/lib/message-publication-api.js`: demonstrates add, persist CID, then pin lifecycle.
- `agent/src/lib/proposal-publication-api.js`: demonstrates duplicate-safe publication recovery and pin retry behavior.

The package-level work should not wire into `node/` yet. Node-facing APIs and onchain indexing should be designed separately after the package exposes stable add-and-pin and retrieval primitives.

## Plan of Work

Milestone 1 makes existing IPFS add-and-pin semantics explicit. `publishToIpfs(...)` should not rely on Kubo defaults. The preferred first change is to call `/api/v0/add?cid-version=1&pin=true&progress=false` and document that the function is the standard add-and-pin primitive.

Milestone 2 adds retrieval primitives for the expected near-term artifact shape while preserving a byte-capable base. `readIpfsBytes(...)` reads bounded arbitrary bytes for known CIDs through Kubo `/api/v0/cat`. `readIpfsText(...)` wraps the byte primitive for small ASCII text and rejects non-ASCII bytes instead of silently mis-decoding them. Both helpers must require a maximum byte limit, fail clearly if the response exceeds that limit, and support caller cancellation. UTF-8-general text and true streaming retrieval are deferred until there is a concrete need.

Milestone 3 updates tests and package documentation. The README should explain that publication uses explicit add-and-pin, retrieval reads by CID from a configured Kubo-compatible endpoint, and indexing is intentionally deferred to a future onchain Logger design.

Milestone 4 captures the future indexing direction without implementing it. Add notes to this plan, or create a dedicated follow-on plan later, for a simple Logger smart contract that emits node-address-to-CID events. That future plan should decide event shape, chain choice, gas strategy, CID encoding, sequence/gap handling, and how offchain consumers scan logs.

Public gateway retrieval is intentionally separate from the Kubo RPC read helpers. The byte helper is the public gateway primitive, and the text helper wraps it for ASCII text verification.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Reconfirm local instructions and clean state:

       sed -n '1,120p' packages/AGENTS.md
       git status --short

2. Inspect the current package surface:

       sed -n '1,240p' packages/ipfs/src/publish-to-ipfs.ts
       sed -n '1,160p' packages/ipfs/src/ipfs-config.ts
       sed -n '1,120p' packages/ipfs/src/index.ts

3. Update `publishToIpfs(...)` so the Kubo add URL makes add-and-pin behavior explicit. The intended URL is:

       /api/v0/add?cid-version=1&pin=true&progress=false

4. Add or update tests in `packages/ipfs/test/publish-to-ipfs.test.js` proving the add request includes `pin=true` and existing retry, timeout, and abort behavior remains unchanged.

5. Ensure `PublishToIpfsResult` can make the pinning outcome explicit enough for downstream consumers, likely by adding `pinned: true` or equivalent normalized metadata if that keeps the API clearer.

6. Add retrieval after add-and-pin behavior is explicit. Create a small ASCII text retrieval file under `packages/ipfs/src/` and a matching test file. Include byte-limit enforcement, oversized-response failure, non-ASCII failure, and caller cancellation coverage before public API integration.

7. Add package documentation in `packages/ipfs/README.md` explaining add-and-pin publication, local retrieval by CID, and the future onchain Logger indexing direction.

8. Build and test the package area:

       npm --prefix packages run build
       node --test packages/ipfs/test/publish-to-ipfs.test.js
       node --test packages/ipfs/test/ipfs-retrieval.test.js
       node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"

9. Do not implement the onchain Logger in this immediate pass. If the user asks to proceed with indexing, create or revise a dedicated ExecPlan first.

## Validation and Acceptance

The package milestone is accepted when:

- `publishToIpfs(...)` does not rely on Kubo's implicit pin default and explicitly requests `pin=true`.
- The package does not add a `pinOnAdd` option or separate pinning track.
- Failed publication can be retried by re-adding the same canonical bytes with stable import options.
- Retrieval primitives can read known CIDs as bounded bytes and bounded ASCII text with caller cancellation, oversized-response failure, and non-ASCII failure for the text wrapper.
- Package README documentation explains add-and-pin publication, retrieval, and the future onchain Logger indexing direction.

Minimum validation commands from `/Users/johnshutt/Code/oya-commitments`:

- `npm --prefix packages run build`
- `node --test packages/ipfs/test/publish-to-ipfs.test.js`
- `node --test packages/ipfs/test/ipfs-retrieval.test.js`
- `node --input-type=module -e "import('./packages/ipfs/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

When onchain indexing work starts, create or update a separate ExecPlan with Solidity tests and deployment/chain assumptions before writing contract code.

If live Kubo validation is attempted, it must be optional and non-production. Use a local daemon bound to localhost and never expose the Kubo RPC API publicly.

## Idempotence and Recovery

IPFS add is content-addressed, so re-adding identical bytes should produce the same CID under the same Kubo import settings. The hardened flow should keep canonical artifact bytes locally so failed add-and-pin requests can be retried from source.

If a request fails or times out before the caller can trust the response, retry by re-adding the same canonical bytes. This may produce the same CID and may discover that the prior attempt already succeeded.

Future onchain logging must be append-only and idempotent at the application layer. The exact logger semantics are intentionally deferred.

## Artifacts and Notes

Current hardened public surface:

- `createIpfsConfig(options)`
- `publishToIpfs(options)`
- `readIpfsBytes(options)`
- `readIpfsPublicGatewayBytes(options)`
- `readIpfsPublicGatewayText(options)`
- `readIpfsText(options)`

Important reference behavior:

- Kubo `/api/v0/add` adds content and has a pin option. The standard Oya path should call it with `pin=true`.
- Kubo `/api/v0/cat` reads content for a known IPFS path.
- Kubo RPC is administrative and should remain local/private. Public indexing should be handled by a future Oya Logger contract rather than exposing Kubo RPC.

## Interfaces and Dependencies

Existing package interfaces:

- `IpfsConfig` from `packages/ipfs/src/ipfs-config.ts`
- `PublishIpfsFetchLike`, `PublishIpfsRequestOptions`, and `PublishIpfsResponse` from `packages/ipfs/src/publish-to-ipfs.ts`
- `PublishToIpfsOptions` and `PublishToIpfsResult` from `packages/ipfs/src/publish-to-ipfs.ts`
- `ReadIpfsBytesResult`
- `ReadIpfsFetchOptions`
- `ReadIpfsFetchLike`
- `ReadIpfsOptions`
- `ReadIpfsResponse`
- `ReadIpfsPublicGatewayFetchOptions`
- `ReadIpfsPublicGatewayFetchLike`
- `ReadIpfsPublicGatewayOptions`
- `ReadIpfsPublicGatewayResponse`
- `ReadIpfsTextResult`

Future onchain indexing interfaces are intentionally deferred. A later plan should define the Logger contract event shape, package ownership, tests, and deployment assumptions.

Dependencies should remain minimal. The add-and-pin and retrieval milestones should not require new runtime dependencies.
