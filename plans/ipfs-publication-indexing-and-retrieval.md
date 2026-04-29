# Harden IPFS Publication Pinning, Indexing, and Retrieval

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Oya nodes already have the beginning of a hardened kernel primitive for publishing bytes or text to IPFS. The next goal is post-publication usability: any data an Oya node publishes should be easy to retain, discover, retrieve, and verify by the publishing node, the node's customers, third-party verifiers, interfaces, and future automation.

This plan adds that capability in layers. First, IPFS add and pin behavior becomes explicit and recoverable. Then the publishing package gets a durable publication index: a searchable catalog of published artifacts and their metadata. Finally, node-facing read APIs can expose that index safely without exposing the raw IPFS RPC API.

Definitions used in this plan:

- IPFS: content-addressed storage where content is retrieved by a CID, a content identifier derived from the bytes.
- Kubo: the common IPFS node implementation whose local HTTP RPC API exposes endpoints such as `/api/v0/add`, `/api/v0/pin/add`, and `/api/v0/cat`.
- Publication artifact: the JSON, text, or bytes an Oya node publishes to IPFS.
- Pinning: instructing an IPFS node or remote pinning service to retain content so local garbage collection does not remove it.
- Publication index: an Oya-owned catalog that maps stable Oya identities, request IDs, agents, commitments, publication kinds, CIDs, timestamps, pin status, validation status, and optional domain metadata.

## Progress

- [x] 2026-04-29 23:12Z: Created this follow-on ExecPlan after resolving the final open decision in `plans/hardened-kernel-packages.md`.
- [ ] Make IPFS add pin behavior explicit in `@oyaprotocol/publishing`.
- [ ] Add low-level IPFS pinning and pin-status primitives.
- [ ] Add low-level IPFS retrieval primitives for safe artifact reads.
- [ ] Add a durable, queryable publication index abstraction.
- [ ] Add tests and documentation for package-level indexing and retrieval behavior.
- [ ] Add a node-facing read API design or implementation once the reusable package interfaces are stable.

## Surprises & Discoveries

- Observation: Pinning is retention, not discovery.
  Evidence: A pin protects a CID from garbage collection on the pinning node or service, but it does not tell customers or verifiers which CIDs correspond to a node, commitment, agent, request ID, market, proposal, trade log, or reimbursement request.

- Observation: The hardened `publishToIpfs(...)` primitive currently omits explicit pin behavior.
  Evidence: `packages/publishing/src/publish-to-ipfs.ts` currently calls `/api/v0/add?cid-version=1&progress=false`. Kubo's add endpoint defaults to pinning unless `pin=false` is supplied, while the legacy runtime in `agent/src/lib/ipfs.js` explicitly adds with `pin=false` and pins as a separate step.

- Observation: The legacy message and proposal publication flows already demonstrate the safer lifecycle shape.
  Evidence: `agent/src/lib/message-publication-api.js` and `agent/src/lib/proposal-publication-api.js` persist the artifact and CID before pinning, allowing retries to avoid duplicate uploads and to recover from pin failures.

- Observation: The hardened packages must not import the legacy runtime.
  Evidence: `packages/AGENTS.md` says existing code under `agent/`, `agent-library/`, `node/`, and `frontend/` is reference material only for the new kernel packages.

## Decision Log

- Decision: Start the next implementation inside `@oyaprotocol/publishing`.
  Rationale: The existing raw IPFS add primitive already lives there, and pinning, indexing, and retrieval are publishing-domain concerns. Starting in the package keeps the next diff reviewable and avoids premature node wiring.
  Date/Author: 2026-04-29 / Codex.

- Decision: Keep IPFS add and pinning as separate explicit operations.
  Rationale: A successful add followed by a failed durable write or failed pin is a real recovery case. Separate operations let the caller persist the CID before pinning and retry pinning without re-uploading identical content.
  Date/Author: 2026-04-29 / Codex.

- Decision: Treat indexing as a first-class post-publication primitive, not as a side effect hidden inside pinning.
  Rationale: Customers and verifiers need to discover relevant records by Oya metadata, not just check whether a known CID is pinned.
  Date/Author: 2026-04-29 / Codex.

- Decision: The node should expose a safe Oya read API instead of exposing the Kubo RPC API.
  Rationale: Kubo RPC is an administrative local API. Oya consumers should see filtered, read-only publication metadata and artifact retrieval surfaces controlled by the Oya node.
  Date/Author: 2026-04-29 / Codex.

- Decision: Public signed index snapshots are important but should come after the local index and read APIs.
  Rationale: A local durable index gives immediate node/customer usability. Signed snapshots can later make the catalog independently auditable without blocking the smaller package primitives.
  Date/Author: 2026-04-29 / Codex.

## Outcomes & Retrospective

No implementation has landed under this plan yet. This document records the selected direction from the prior package-shell ExecPlan and defines the implementation sequence. The first successful milestone should leave reviewers with package-level tests proving explicit unpinned add, separate pinning, and retryable pin failures.

## Context and Orientation

The hardened package area lives under `packages/`. The relevant local instructions are in `packages/AGENTS.md`: packages should be importable by package root, should not deep-import legacy runtime code, and should avoid app wiring, CLI code, environment loading, and repo-specific startup logic.

Current package files:

- `packages/publishing/src/ipfs-publish-config.ts`: validates explicit IPFS transport settings.
- `packages/publishing/src/publish-to-ipfs.ts`: publishes content to Kubo `/api/v0/add` using injected `fetch`.
- `packages/publishing/src/index.ts`: exports the public package surface.
- `packages/publishing/test/publish-to-ipfs.test.js`: tests the built package entrypoint.

Reference-only legacy files:

- `agent/src/lib/ipfs.js`: contains the older add and pin helpers.
- `agent/src/lib/message-publication-store.js`: durable JSON store for signed message publication records.
- `agent/src/lib/proposal-publication-store.js`: durable JSON store for proposal publication records.
- `agent/src/lib/message-publication-api.js`: demonstrates add, persist CID, then pin lifecycle.
- `agent/src/lib/proposal-publication-api.js`: demonstrates duplicate-safe publication recovery and pin retry behavior.

The package-level work should not wire into `node/` yet. Node-facing APIs should be added only after the package exposes stable primitives and tests.

## Plan of Work

Milestone 1 makes existing IPFS add semantics explicit. `publishToIpfs(...)` should not rely on Kubo defaults. The preferred first change is to call `/api/v0/add?cid-version=1&pin=false&progress=false` so the function remains a raw add primitive. If implementation reveals a compatibility issue, add an explicit option instead of using an implicit default, and record the decision here.

Milestone 2 adds pinning primitives. Add `pinIpfsCid(...)` to `@oyaprotocol/publishing` using the same explicit config, injected `fetch`, timeout, retry, and abort behavior as `publishToIpfs(...)`. Add a pin-status primitive if it can remain small and reviewable, likely against Kubo `/api/v0/pin/ls`. The return types should normalize provider responses but preserve the raw provider response for audit/debugging.

Milestone 3 adds retrieval primitives. Add a small read helper for known CIDs, likely `readIpfsContent(...)` or `fetchIpfsContent(...)`, backed by Kubo `/api/v0/cat`. This helper must include a maximum byte limit or streaming-safe contract before it is used in a public node API. It should support caller cancellation and should not assume that all artifacts are JSON.

Milestone 4 adds a publication record model and index abstraction. Start with package-level types and pure validation/query behavior before choosing storage. The record model should include, at minimum, publication identity, CID, URI, filename, media type, byte length, publication timestamp, pin status, pin timestamp, publication kind, chain ID when available, signer or node address when available, agent address when available, commitment addresses when available, request ID when available, validation status when available, and caller-provided metadata for domain-specific indexing.

Milestone 5 adds durable storage. Prefer a storage-neutral index core first, such as a `PublicationIndexStorage` interface with `loadState()` and `saveState(state)`, plus tests using an in-memory adapter. Add a reusable file-backed adapter only if it can stay package-generic; if it requires Node-specific types, add the required package dependencies deliberately and document them.

Milestone 6 designs or implements node-facing read APIs. The initial shape should be read-only:

- `GET /v1/publications` lists records with filters such as `kind`, `chainId`, `agentAddress`, `commitmentAddress`, `signer`, `requestId`, `cid`, and time range.
- `GET /v1/publications/:id` returns one indexed record.
- `GET /v1/publications/by-cid/:cid` returns records for a known CID.
- `GET /v1/publications/:id/artifact` retrieves the artifact bytes through the node's controlled IPFS read path when configured.

Milestone 7 adds signed index snapshots only after local indexing and read APIs work. A signed snapshot is a published artifact containing the index state or an append-only page of index records, signed by the node. It lets third-party verifiers audit gaps or changes without relying only on the node's current HTTP API.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Reconfirm local instructions and clean state:

       sed -n '1,120p' packages/AGENTS.md
       git status --short

2. Inspect the current package surface:

       sed -n '1,240p' packages/publishing/src/publish-to-ipfs.ts
       sed -n '1,160p' packages/publishing/src/ipfs-publish-config.ts
       sed -n '1,120p' packages/publishing/src/index.ts

3. Update `publishToIpfs(...)` so the Kubo add URL makes pin behavior explicit. The intended URL is:

       /api/v0/add?cid-version=1&pin=false&progress=false

4. Add or update tests in `packages/publishing/test/publish-to-ipfs.test.js` proving the add request includes `pin=false` and existing retry, timeout, and abort behavior remains unchanged.

5. Add `packages/publishing/src/pin-ipfs-cid.ts` and export it from `packages/publishing/src/index.ts`. The function should accept explicit `config`, injected `fetch`, a non-empty CID, and optional `signal`.

6. Add `packages/publishing/test/pin-ipfs-cid.test.js` covering success, invalid CID, retryable HTTP/network failure, non-retryable HTTP failure, timeout, caller abort, and provider response normalization.

7. Add retrieval only after pinning tests pass. Create a small retrieval file under `packages/publishing/src/` and a matching test file. Include byte-limit behavior before public API integration.

8. Add publication index types and normalization under `packages/publishing/src/`. Keep the first slice storage-neutral unless a file-backed adapter is explicitly needed.

9. Add package documentation in `packages/publishing/README.md` explaining add, pin, index, and retrieve responsibilities.

10. Build and test the package area:

       npm --prefix packages run build
       node --test packages/publishing/test/publish-to-ipfs.test.js
       node --test packages/publishing/test/pin-ipfs-cid.test.js
       node --input-type=module -e "import('./packages/publishing/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"

11. If node-facing API work is included in the same implementation pass, add focused node tests under `node/scripts/` or the relevant package test directory and record the exact commands here before implementation continues.

## Validation and Acceptance

The package milestone is accepted when:

- `publishToIpfs(...)` does not rely on Kubo's implicit pin default.
- `pinIpfsCid(...)` exists, is exported from `@oyaprotocol/publishing`, and has focused tests.
- A failed pin can be represented separately from a successful add.
- Publication index records can be added, queried, and conflict-checked without requiring legacy runtime imports.
- Package README documentation explains the difference between add, pin, index, and retrieval.

Minimum validation commands from `/Users/johnshutt/Code/oya-commitments`:

- `npm --prefix packages run build`
- `node --test packages/publishing/test/publish-to-ipfs.test.js`
- `node --test packages/publishing/test/pin-ipfs-cid.test.js`
- `node --input-type=module -e "import('./packages/publishing/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

When retrieval and indexing are implemented, add and run:

- `node --test packages/publishing/test/ipfs-retrieval.test.js`
- `node --test packages/publishing/test/publication-index.test.js`

If live Kubo validation is attempted, it must be optional and non-production. Use a local daemon bound to localhost and never expose the Kubo RPC API publicly.

## Idempotence and Recovery

IPFS add is content-addressed, so re-adding identical bytes should produce the same CID under the same Kubo import settings. The hardened flow should still avoid unnecessary duplicate uploads by persisting the CID before pinning.

Pinning an already pinned CID should be treated as success if Kubo or a pinning backend reports success or already-pinned state. A transient pin failure should not erase the publication record or CID.

Index writes must be idempotent for the same publication identity and CID. If the same identity is reused with different signed content, CID, or canonical payload, the index should surface a conflict instead of silently overwriting history.

Any future file-backed index store must use atomic write semantics comparable to the legacy JSON stores: write to a temporary file, then rename into place.

## Artifacts and Notes

Current hardened public surface:

- `createIpfsPublishConfig(options)`
- `publishToIpfs(options)`

Likely new public surface:

- `pinIpfsCid(options)`
- `getIpfsPinStatus(options)` or equivalent if kept small
- `readIpfsContent(options)` or equivalent retrieval primitive
- `normalizePublicationRecord(record)`
- `derivePublicationIndexKey(record)`
- `createPublicationIndex(options)`

Important reference behavior:

- Kubo `/api/v0/add` adds content and has a pin option.
- Kubo `/api/v0/pin/add` pins known CIDs.
- Kubo `/api/v0/cat` reads content for a known IPFS path.
- Kubo RPC is administrative and should remain local/private. Oya should expose its own read-only surfaces for customers and verifiers.

## Interfaces and Dependencies

Existing package interfaces:

- `IpfsPublishConfig` from `packages/publishing/src/ipfs-publish-config.ts`
- `FetchLike`, `FetchRequestOptions`, and `FetchResponse` from `packages/publishing/src/publish-to-ipfs.ts`
- `PublishToIpfsOptions` and `PublishToIpfsResult` from `packages/publishing/src/publish-to-ipfs.ts`

Proposed new package interfaces:

- `PinIpfsCidOptions`
- `PinIpfsCidResult`
- `IpfsPinStatus`
- `ReadIpfsContentOptions`
- `ReadIpfsContentResult`
- `PublicationRecord`
- `PublicationIndexState`
- `PublicationIndexQuery`
- `PublicationIndexStorage`

Dependencies should remain minimal. The first pinning and retrieval milestones should not require new runtime dependencies. If a file-backed index adapter is added inside `packages/`, the implementation may require Node type declarations or a deliberate alternative that keeps the core package storage-neutral.
