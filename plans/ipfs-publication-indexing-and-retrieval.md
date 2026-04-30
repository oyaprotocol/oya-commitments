# Harden IPFS Add-And-Pin Publication and Retrieval

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Oya nodes already have the beginning of a hardened kernel primitive for publishing bytes or text to IPFS. The next immediate goal is post-publication retrieval: any data an Oya node publishes should be pinned by the node and easy to retrieve later by CID.

This plan keeps the near-term package work intentionally small. First, IPFS add-and-pin behavior becomes explicit while staying simple: the standard Oya path adds and pins in one Kubo request. Then the publishing package gets a low-level retrieval primitive for safe artifact reads from a Kubo-compatible node. Tests and documentation should cover both behaviors.

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
- [ ] Add low-level IPFS retrieval primitives for bounded ASCII text artifact reads.
- [x] 2026-04-30 19:09Z: Added add-and-pin publication tests and documentation.
- [ ] Add tests and documentation for bounded ASCII text retrieval.
- [ ] Create or update a future plan for onchain CID logging and public indexing when ready.

## Surprises & Discoveries

- Observation: Pinning is retention, not discovery.
  Evidence: A pin protects a CID from garbage collection on the pinning node or service, but it does not tell customers or verifiers which CIDs correspond to a node, commitment, agent, request ID, market, proposal, trade log, or reimbursement request.

- Observation: Onchain CID logging can provide the public index instead of building a local durable index first.
  Evidence: a simple Logger contract can emit events that match a node address to a series of CIDs with block ordering and timestamps. Offchain consumers can scan those logs to discover the node's public publication history.

- Observation: The hardened `publishToIpfs(...)` primitive currently omits explicit pin behavior.
  Evidence: `packages/publishing/src/publish-to-ipfs.ts` currently calls `/api/v0/add?cid-version=1&progress=false`. Kubo's add endpoint defaults to pinning, but the hardened kernel should not rely on an implicit provider default.

- Observation: A separate add-then-pin track is unnecessarily complex for the expected Oya artifact shape.
  Evidence: the expected artifacts are small text or JSON records, and the node can keep canonical local bytes. Retrying by re-adding the same canonical bytes is simpler than maintaining a second pinning state machine.

- Observation: The legacy message and proposal publication flows demonstrate a stricter lifecycle but are not the selected kernel path.
  Evidence: `agent/src/lib/message-publication-api.js` and `agent/src/lib/proposal-publication-api.js` add with `pin=false` and then pin separately. That remains useful reference material, but this plan chooses a simpler add-and-pin default for the hardened kernel.

- Observation: The hardened packages must not import the legacy runtime.
  Evidence: `packages/AGENTS.md` says existing code under `agent/`, `agent-library/`, `node/`, and `frontend/` is reference material only for the new kernel packages.

## Decision Log

- Decision: Start the next implementation inside `@oyaprotocol/publishing`.
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

## Outcomes & Retrospective

Milestone 1 is complete. `publishToIpfs(...)` now explicitly requests add-and-pin behavior with `/api/v0/add?cid-version=1&pin=true&progress=false`, and `PublishToIpfsResult` reports `pinned: true`. The focused publishing test now proves the explicit URL and normalized pinned result.

Validation evidence for Milestone 1:

- `npm --prefix packages run build`
- `node --test packages/publishing/test/publish-to-ipfs.test.js`
- `node --input-type=module -e "import('./packages/publishing/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

Remaining near-term work starts at Milestone 2: bounded ASCII text retrieval by CID.

## Context and Orientation

The hardened package area lives under `packages/`. The relevant local instructions are in `packages/AGENTS.md`: packages should be importable by package root, should not deep-import legacy runtime code, and should avoid app wiring, CLI code, environment loading, and repo-specific startup logic.

Current package files:

- `packages/publishing/src/ipfs-publish-config.ts`: validates explicit IPFS transport settings.
- `packages/publishing/src/publish-to-ipfs.ts`: publishes content to Kubo `/api/v0/add` using injected `fetch`.
- `packages/publishing/src/index.ts`: exports the public package surface.
- `packages/publishing/test/publish-to-ipfs.test.js`: tests the built package entrypoint.

Reference-only legacy files:

- `agent/src/lib/ipfs.js`: contains the older add and separate pin helpers.
- `agent/src/lib/message-publication-store.js`: durable JSON store for signed message publication records.
- `agent/src/lib/proposal-publication-store.js`: durable JSON store for proposal publication records.
- `agent/src/lib/message-publication-api.js`: demonstrates add, persist CID, then pin lifecycle.
- `agent/src/lib/proposal-publication-api.js`: demonstrates duplicate-safe publication recovery and pin retry behavior.

The package-level work should not wire into `node/` yet. Node-facing APIs and onchain indexing should be designed separately after the package exposes stable add-and-pin and retrieval primitives.

## Plan of Work

Milestone 1 makes existing IPFS add-and-pin semantics explicit. `publishToIpfs(...)` should not rely on Kubo defaults. The preferred first change is to call `/api/v0/add?cid-version=1&pin=true&progress=false` and document that the function is the standard add-and-pin primitive.

Milestone 2 adds retrieval primitives for the expected near-term artifact shape: small ASCII text. Add a small read helper for known CIDs, likely `readIpfsText(...)` or `fetchIpfsText(...)`, backed by Kubo `/api/v0/cat`. The helper must require a maximum byte limit, fail clearly if the response exceeds that limit, return text rather than JSON or arbitrary binary, and reject or clearly fail non-ASCII bytes instead of silently mis-decoding them. It should support caller cancellation. Binary, UTF-8-general, and true streaming retrieval are deferred until there is a concrete need.

Milestone 3 updates tests and package documentation. The README should explain that publication uses explicit add-and-pin, retrieval reads by CID from a configured Kubo-compatible endpoint, and indexing is intentionally deferred to a future onchain Logger design.

Milestone 4 captures the future indexing direction without implementing it. Add notes to this plan, or create a dedicated follow-on plan later, for a simple Logger smart contract that emits node-address-to-CID events. That future plan should decide event shape, chain choice, gas strategy, CID encoding, sequence/gap handling, and how offchain consumers scan logs.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Reconfirm local instructions and clean state:

       sed -n '1,120p' packages/AGENTS.md
       git status --short

2. Inspect the current package surface:

       sed -n '1,240p' packages/publishing/src/publish-to-ipfs.ts
       sed -n '1,160p' packages/publishing/src/ipfs-publish-config.ts
       sed -n '1,120p' packages/publishing/src/index.ts

3. Update `publishToIpfs(...)` so the Kubo add URL makes add-and-pin behavior explicit. The intended URL is:

       /api/v0/add?cid-version=1&pin=true&progress=false

4. Add or update tests in `packages/publishing/test/publish-to-ipfs.test.js` proving the add request includes `pin=true` and existing retry, timeout, and abort behavior remains unchanged.

5. Ensure `PublishToIpfsResult` can make the pinning outcome explicit enough for downstream consumers, likely by adding `pinned: true` or equivalent normalized metadata if that keeps the API clearer.

6. Add retrieval after add-and-pin behavior is explicit. Create a small ASCII text retrieval file under `packages/publishing/src/` and a matching test file. Include byte-limit enforcement, oversized-response failure, non-ASCII failure, and caller cancellation coverage before public API integration.

7. Add package documentation in `packages/publishing/README.md` explaining add-and-pin publication, local retrieval by CID, and the future onchain Logger indexing direction.

8. Build and test the package area:

       npm --prefix packages run build
       node --test packages/publishing/test/publish-to-ipfs.test.js
       node --test packages/publishing/test/ipfs-retrieval.test.js
       node --input-type=module -e "import('./packages/publishing/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"

9. Do not implement the onchain Logger in this immediate pass. If the user asks to proceed with indexing, create or revise a dedicated ExecPlan first.

## Validation and Acceptance

The package milestone is accepted when:

- `publishToIpfs(...)` does not rely on Kubo's implicit pin default and explicitly requests `pin=true`.
- The package does not add a `pinOnAdd` option or separate pinning track.
- Failed publication can be retried by re-adding the same canonical bytes with stable import options.
- A retrieval primitive can read known CIDs as bounded ASCII text with caller cancellation, oversized-response failure, and non-ASCII failure.
- Package README documentation explains add-and-pin publication, retrieval, and the future onchain Logger indexing direction.

Minimum validation commands from `/Users/johnshutt/Code/oya-commitments`:

- `npm --prefix packages run build`
- `node --test packages/publishing/test/publish-to-ipfs.test.js`
- `node --test packages/publishing/test/ipfs-retrieval.test.js`
- `node --input-type=module -e "import('./packages/publishing/dist/index.js').then((m) => console.log(Object.keys(m).sort().join(',')))"`

When onchain indexing work starts, create or update a separate ExecPlan with Solidity tests and deployment/chain assumptions before writing contract code.

If live Kubo validation is attempted, it must be optional and non-production. Use a local daemon bound to localhost and never expose the Kubo RPC API publicly.

## Idempotence and Recovery

IPFS add is content-addressed, so re-adding identical bytes should produce the same CID under the same Kubo import settings. The hardened flow should keep canonical artifact bytes locally so failed add-and-pin requests can be retried from source.

If a request fails or times out before the caller can trust the response, retry by re-adding the same canonical bytes. This may produce the same CID and may discover that the prior attempt already succeeded.

Future onchain logging must be append-only and idempotent at the application layer. The exact logger semantics are intentionally deferred.

## Artifacts and Notes

Current hardened public surface:

- `createIpfsPublishConfig(options)`
- `publishToIpfs(options)`

Likely new public surface:

- `readIpfsText(options)` or equivalent bounded ASCII text retrieval primitive

Important reference behavior:

- Kubo `/api/v0/add` adds content and has a pin option. The standard Oya path should call it with `pin=true`.
- Kubo `/api/v0/cat` reads content for a known IPFS path.
- Kubo RPC is administrative and should remain local/private. Public indexing should be handled by a future Oya Logger contract rather than exposing Kubo RPC.

## Interfaces and Dependencies

Existing package interfaces:

- `IpfsPublishConfig` from `packages/publishing/src/ipfs-publish-config.ts`
- `FetchLike`, `FetchRequestOptions`, and `FetchResponse` from `packages/publishing/src/publish-to-ipfs.ts`
- `PublishToIpfsOptions` and `PublishToIpfsResult` from `packages/publishing/src/publish-to-ipfs.ts`

Proposed new package interfaces:

- `ReadIpfsTextOptions`
- `ReadIpfsTextResult`

Future onchain indexing interfaces are intentionally deferred. A later plan should define the Logger contract event shape, package ownership, tests, and deployment assumptions.

Dependencies should remain minimal. The add-and-pin and retrieval milestones should not require new runtime dependencies.
