# Bootstrap trusted node peers and exchange publishable messages

This living ExecPlan follows [PLANS.md](../PLANS.md) and the repository instruction hierarchy.

**Scoped implementation update (2026-11-13):** The current user instruction authorizes `peer-directory-v1` without a separate routine plan-approval step; PR #142 was merged on 2026-11-07 at `90f2d3fcbaab3f0c0a0c3853313a01e6f4320878`. The [offline directory ExecPlan](peer-directory-v1-execplan.md) implements only schema/inspection, repository revision CI and packaged snapshot metadata, following pemulis’s repository-registry direction below. The original approval wording below is historical for that completed plan-only PR, not a blocker on this explicitly authorized offline milestone. Runtime authorization, rollout, transport and the remaining network milestones are **not implemented or authorized for deployment** by that update.

**Historical status at plan publication: proposal; plan only.** This PR must contain only this document. It does not implement configuration fields, create a peer registry, enroll nodes, enable forwarding, change an installation, or authorize transactions. **Implementation may begin only after an authorized human explicitly approves this plan and this plan PR is merged into upstream `main`.** Both conditions are required. A bot review, passing CI, approval of another PR, or merge without explicit plan approval is not sufficient. Before the first implementation change, record the approval evidence and merged plan revision in this document, fetch current `main`, and reconcile intervening changes. Material design changes require renewed approval. Do not auto-merge this PR or start implementation while waiting.

## Purpose / Big Picture

During the testnet period, every participating node must support the official directory maintained in `oyaprotocol/oya-commitments` through reviewed pull requests. An operator should be able to start a production node with a pinned local copy of that directory, containing public Ethereum node addresses and one public message-receive endpoint per node. The node should derive its accepted peer message signers from that directory without losing separately configured agent signers. A node should then be able to originate a signed message, send it to selected peers, and have each receiving peer independently verify, publish to IPFS, and log the resulting content identifier (CID) through the existing Ledger pipeline.

The observable first-release result is a three-node demonstration: A creates one signed message; B and C publish the same signed bytes under the same CID and record separate Ledger events from B's and C's node accounts. B can also send a new message to A. Retrying the same delivery must not create another logical job or another Ledger transaction at that recipient. Receiving a message must not trigger automatic forwarding or a response loop.

This establishes identities, routing, signed content and publication records for later cross-node data availability checks. It does **not** establish that a Ledger log proves storage or retrieval. The active scope after approval is bootstrap configuration and bounded peer-to-peer delivery. A continuous Ledger watcher, content-serving protocol, availability challenges, scoring, slashing, consensus, and trustless membership remain separate future work requiring their own approved scope.

## Progress

- [x] 2026-11-07: Inspected upstream `main` at `a8dee241c5a26e7124c6d99af7f1bc212f0dcd75`, node/inbox configuration and signing, publication/recovery, Ledger semantics, and related open PRs.
- [x] 2026-11-07: Drafted the proposed configuration, trust model, message flow, milestones and acceptance criteria without implementation changes.
- [x] 2026-11-07 16:45Z: Completed independent source/plan reviews and incorporated their corrections. Documentation validation passed: 12 required sections, two JSON examples, 18 local links, whitespace/sensitive-information checks and a one-document-only diff.
- [x] 2026-11-07: Addressed Codex plan feedback by specifying persistent admission-only maintenance and ASCII network IDs; runtime implementation and acceptance tests remain gated.
- [x] 2026-11-07: Incorporated pemulis’s request for an official repository-hosted testnet registry, PR-based enrollment and mandatory support for all listed peers; no registry or runtime implementation added.
- [ ] **Approval gate:** record explicit human approval and merge of this plan into upstream `main`. No implementation milestones may start before both.
- [ ] After approval and merge: implement and validate directory loading and consistent signer policy.
- [ ] After approval and merge: implement node-originated messages and bounded, durable outbound delivery.
- [ ] After approval and merge: validate a three-node network, package operator assets and document controlled rollout/recovery.

## Surprises & Discoveries

There is already a signed-message allowlist and an IPFS-to-Ledger publisher; neither needs to be replaced. The current production code has no peer membership directory, public-endpoint directory, or node registration contract integration. In this first design, **registered means included in the official repository-hosted testnet registry through a reviewed and merged pull request**, not on-chain registered, globally discoverable, or trusted because an address emitted a Ledger event. The initial local-directory proposal was superseded by [pemulis’s repository-registry direction](https://github.com/oyaprotocol/oya-commitments/pull/142#issuecomment-6712305115) on 2026-11-07. A verified bootstrap roster has not been supplied; examples below are placeholders, not claims that any live node is enrolled. An authoritative on-chain registry adapter can be proposed later; do not silently substitute ERC-8004 agent registration or arbitrary Ledger callers for node membership.

The production deployment has two roles: a public inbox durably accepts jobs, while a local worker owns the IPFS publisher and transaction signer. The worker presently reads `allowedSigners` directly from the raw node JSON, independently of the parser's authorizer. Merely adding addresses to a parser's allowlist would therefore leave worker reauthorization inconsistent. The same resolved policy must reach every enforcement point.

The durable inbox and synchronous direct API are different protocols. Inbox jobs sign a destination `target`, request ID, expiration and inner signed message; the direct API has no equivalent durable job identity. This plan uses the existing inbox protocol for peer transport. Direct-only installations need an inbox before joining this first peer-network implementation; their existing API remains unchanged. Do not send inbox envelopes to `/v1/messages` or add automatic retries to the synchronous API.

`signJob` currently signs both the inner message and outer job with the same wallet. A node's Ledger account is also not interchangeable with an IPFS peer ID, inbox target name, worker bearer token, or an ordinary agent's signing key. A shared CID across recipients requires preserving the exact inner signed message rather than adding recipient metadata to it or signing it afresh for every destination.

[PR #139](https://github.com/oyaprotocol/oya-commitments/pull/139) proposes Sepolia defaults but is still open at plan drafting. The plan is based on actual `main`, not that branch. Use explicit chain/contract settings until those defaults are merged, and reuse its constants if they have landed before implementation. Open inbox hardening PRs #136, #140 and #141 must also be rechecked before editing overlapping code. This plan does not approve or duplicate those PRs or any separate Ledger-evidence feature proposal.

Codex review exposed two plan gaps: the current Caddy route and inbox process serve admissions and worker traffic together, so stopping the service cannot drain its queue; normal JSON serialization also preserves `é` in `oya-é`, whereas the message schema rejects non-ASCII signed text. The revisions below specify an admission-only pause and an ASCII network-ID grammar.

## Decision Log

The technical decisions below are proposed by Oya Gardener on 2026-11-07 and become implementation direction only through the approval gate. Decision 1 incorporates pemulis’s direction on that date; the revised plan still requires approval and merge.

1. Maintain the official testnet membership and routing registry at `node/production/peers/testnet-directory.json` in this repository. Additions, removals and endpoint/key changes go through normal reviewed pull requests; merged upstream revisions are the authority, not arbitrary local lists or peer responses. Every participating testnet node must authorize all other listed nodes as supported message signers. Operators install complete, pinned snapshots through controlled rollout rather than filtering peers or downloading mutable data at startup. This follows pemulis’s request for simple Git-based bootstrapping before a future on-chain registry; no on-chain adapter is implemented here.
2. Use one shared public directory file and a small local `peers` reference in each node/inbox configuration. Keep the self identity explicit, derive the other nodes' allowed signer addresses, and keep manually approved agent signers separate. Directory membership is a security permission, not just an address book.
3. Support the production **Ledger inbox/worker** topology first. Preserve existing deployments with no peer configuration, including IPFS-only and direct-only installations. Reject peer-network opt-in on unsupported modes instead of silently acquiring a signer or changing modes. Every participating node's execution chain and Ledger must match the directory's common execution domain.
4. Use the node's existing dedicated Ethereum account to originate node messages, matching the address other nodes enroll. Expose narrowly scoped off-chain signing operations, not a public generic signing API. The existing worker remains the sole owner of that account's transaction nonce stream.
5. Keep an immutable signed inner message across recipients and a distinct signed inbox job per recipient. Persist jobs before contacting peers, reuse their exact IDs and bytes on retries, and distinguish a recipient's reported result from independently verified evidence. No automatic forwarding or unsolicited replies.
6. Treat peer URLs as untrusted network destinations even though their enrollment is trusted. Restrict routing to approved endpoints, prevent private-network access and redirects, bound all work, and never attach local RPC, IPFS, database or worker credentials to peer requests.
7. Establish the interfaces needed for later availability evidence, but do not implement a new availability verifier or claim that a receive endpoint doubles as an IPFS gateway.
8. Add a persisted inbox admission-only pause, leaving original-policy worker/status access available during draining, rather than requiring an unspecified proxy workaround. Restrict network IDs to a bounded ASCII grammar so accepted directories can produce valid signed messages.

## Outcomes & Retrospective

The plan now specifies the official repository-hosted testnet registry, reviewed PR enrollment and all-listed-peer signer support, alongside the Codex corrections for maintenance/draining and network-ID serialization; implementation remains blocked on explicit human approval and merge. No implementation, schema migration, live membership change, delivery, funding or deployment has occurred under this task. The inspected code provides a reusable durable receiver and publisher, but directory loading, shared signer resolution, outbound node messaging and safe peer routing do not yet exist. The first implementation should remain a small permissioned-network building block, not turn into a general gossip protocol or a proof-of-availability system.

Update this section after plan review and each later approved implementation milestone. Clearly separate completed checks from proposed tests and peer-reported publication from independently observed chain/content evidence.

## Context and Orientation

The production runtime under `node/production/` is the target, not the experimental daemons in `node/scripts/` or commitment-specific agent logic.

| Existing location | Reuse or extension point |
| --- | --- |
| [`node/production/src/config.mjs`](../node/production/src/config.mjs) | `parseConfig` is synchronous and strict; `loadConfig` loads files. Resolve one effective signer set before constructing its authorizer. |
| [`node/production/src/inbox/config.mjs`](../node/production/src/inbox/config.mjs), [`main.mjs`](../node/production/src/inbox/main.mjs) | Inbox configuration, execution identity, startup and durable store initialization. Add explicit directory loading here without putting signing keys on the inbox. |
| [`node/production/src/inbox/worker.mjs`](../node/production/src/inbox/worker.mjs) | `main`, `runWorker` and `runOne` currently pass raw `allowedSigners`; route the resolved set and peer policy to validation. |
| [`node/production/src/inbox/protocol.mjs`](../node/production/src/inbox/protocol.mjs) | `targetName`, `signJob`, `jobText`, `validateJob` and `executionIdentity`. Preserve current version-1 envelope fields and serialization. |
| [`node/production/src/inbox/http.mjs`](../node/production/src/inbox/http.mjs) | `createInboxServer` and `createInboxClient`; public job/status paths are separate from token-protected worker paths. |
| [`node/production/src/inbox/store.mjs`](../node/production/src/inbox/store.mjs), [`processor.mjs`](../node/production/src/inbox/processor.mjs) | Durable target/request ID deduplication and signature verification → IPFS → CID checkpoint → transaction checkpoint → broadcast → verified receipt/event. Preserve these invariants. |
| [`node/production/src/signer.mjs`](../node/production/src/signer.mjs), [`secrets.mjs`](../node/production/src/secrets.mjs) | Local transaction signer and protected key loading. Do not pass the raw key into networking or directory modules. |
| [`node/production/scripts/local-config.mjs`](../node/production/scripts/local-config.mjs), [`local-node.mjs`](../node/production/scripts/local-node.mjs) | Host configuration/check commands must resolve the same policy as runtime startup. |
| [`packages/messages/src/handlers/publish.ts`](../packages/messages/src/handlers/publish.ts) | Canonical publication of `{text, signer, signature}`; preserve its bytes and do not add recipient routing fields to the IPFS envelope. |
| [`contracts/src/Ledger.sol`](../contracts/src/Ledger.sol), [`contracts/README.md`](../contracts/README.md) | `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` attributes a claim to the publishing caller, not the message's original signer. |
| [`node/production/inbox-api.md`](../node/production/inbox-api.md) | Existing job authentication, expiration, status, queue/checkpoint and recovery contract. |

A **peer** is a directory-enrolled node other than this installation. Its `nodeAddress` identifies the account used for Ledger publication and, in this version, node-originated message signatures. `target` is the exact destination name required by the peer's inbox. A **directory revision** is a versioned snapshot of the official upstream registry, identified for rollout by its upstream Git commit and file checksum, not a consensus height. An **outbox** is a local durable record of signed outbound jobs; it does not replace the recipient's authoritative PostgreSQL execution journal.

## Plan of Work

### Milestone 0 — verify permission and integrate with current main

Wait for explicit plan approval and merge. Then create a fresh implementation branch from current upstream `main`, record the approval reference, inspect merged/open changes named above, and reread applicable repository instructions. Do not include implementation commits in this plan-only PR. Subsequent implementation PRs should link the merged plan, update its progress and obtain normal review. This gate does not authorize releases, live enrollment, key changes, deployments or public-chain spending.

### Milestone 1 — bootstrap directory and identical local signer policy

Propose `node/production/src/peers/config.mjs` for pure directory validation and policy derivation, plus bounded local file loading. Proposed public directory schema:

```json
{
  "version": 1,
  "networkId": "oya-sepolia-v1",
  "revision": 1,
  "execution": {
    "mode": "ledger",
    "chainId": 11155111,
    "ledgerContract": "0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3"
  },
  "nodes": [
    {
      "nodeAddress": "0x1111111111111111111111111111111111111111",
      "receiveUrl": "https://node-a.example/v1/jobs",
      "target": "node-a"
    },
    {
      "nodeAddress": "0x2222222222222222222222222222222222222222",
      "receiveUrl": "https://node-b.example/v1/jobs",
      "target": "node-b"
    }
  ]
}
```

The node addresses and `.example` endpoints above are deliberately non-operational placeholders. The Ledger value is the Sepolia target documented in PR #139, not a newly deployed contract. The official registry contains **one receive URL for every enrolled node, including self**. During implementation, create `node/production/peers/testnet-directory.json` and `node/production/peers/README.md` documenting its schema, contribution and rollout procedure. Populate it only with publicly confirmed node addresses, endpoints and targets approved through PR review; never promote these example values into the official roster. If no entries have been verified, commit an empty `nodes` array as an explicitly non-runnable bootstrap registry: it cannot satisfy the self-record startup requirement. Existing standalone installations remain unchanged, but joining the testnet network requires the complete official list, not a private subset.

Proposed optional fragment in each node and corresponding inbox configuration:

```json
{
  "allowedSigners": ["0x3333333333333333333333333333333333333333"],
  "peers": {
    "directoryFile": "./testnet-directory.json",
    "selfNodeAddress": "0x1111111111111111111111111111111111111111"
  }
}
```

These are proposed schemas, **not currently supported configuration or runnable full examples**. Existing execution, IPFS, database and worker settings remain required. Relative paths resolve against the containing configuration file, not the process working directory. The same directory revision must be deliberately mounted read-only into the local worker and its remote inbox; it contains no secrets. Only local files are accepted. Operators acquire the file from a reviewed, merged upstream commit, record that commit and the file checksum, and verify the same complete snapshot on both roles before rollout. Runtime schema validation alone cannot prove Git provenance or latest membership; configuration inspection and rollout checks must expose the applied revision/checksum for comparison with upstream. Bound reads before parsing, reject malformed JSON and unsupported fields/versions, and never download a missing directory.

Onboarding is explicit: generate or reuse the node key locally through the existing setup workflow, then open a PR updating the official registry with its public address, HTTPS receive endpoint and inbox target. The contributor confirms control of the signing identity and endpoint without publishing secrets; maintainers verify that evidence and the execution domain before normal review/merge. Each membership or routing change increments `revision`; CI must validate schema, address/endpoint/target uniqueness, limits and revision advancement against the base registry. Registry validation must not require a particular installation’s self record or live network access. After merge, operators distribute the complete pinned snapshot to every participating inbox/worker pair using the maintenance procedure below. All listed peers must become supported signers, while manually approved agent signers remain additive. Do not call enrollment operational until every participating pair reports the agreed revision and passes policy preflight; merge alone does not update running nodes. An offline or lagging node is explicitly pending rollout, not permission to silently omit it from the official list. Do not automatically insert an unapproved self record or overwrite an identity.

Use a maximum 256-KiB directory and 256 node records initially. Require a string `networkId` fully matching `^[a-z0-9][a-z0-9._-]{0,63}$` (1–64 ASCII characters), with no trimming, case folding or Unicode normalization; reject trailing newlines too rather than relying on JavaScript's permissive `$` anchor. Reject invalid IDs during directory loading and apply the same grammar when decoding peer messages. Require a positive safe-integer revision and explicit Ledger execution domain; installation policy resolution additionally requires exactly one self record. Validate nonzero Ethereum addresses and mixed-case checksums before normalization. Reject duplicate addresses after case normalization, duplicate receive endpoints, duplicate inbox targets, conflicting entries, missing endpoints, and invalid URL/target types. Keep the display address separate from its normalized comparison form. A single-self directory is valid only if the existing non-peer allowlist still supplies at least one accepted signer.

Every record's endpoint is a strict HTTPS URL with exactly `/v1/jobs`, no credentials, query or fragment, and no surrounding whitespace. Derive `/v1/status` from that same approved origin; never accept a status URL returned by a peer. Hostnames need not resolve at startup, so an offline peer does not stop a valid node from booting. Connection-time destination checks belong to Milestone 3. No IPFS API, database, RPC, health or worker URL belongs in this directory.

Compute `effectiveAllowedSigners = distinct(manual allowedSigners ∪ enrolled node addresses other than self)`. Preserve the manually configured set without rewriting files. `allowedSigners: []` is permitted with peers only when the effective set is nonempty; without peers, existing validation remains unchanged. Excluding self from the derived set prevents accidental self-routing, not legitimate separately configured local agents. New-directory membership explicitly grants the ability to trigger publication and potentially spend the receiver's gas; existing request, queue, transaction-fee and gas limits still apply and do not constitute a cumulative spending budget.

Keep `parseConfig`/`parseInboxConfig` pure by passing already validated directory data through options when `peers` is configured. File-loading wrappers resolve the directory before parsing. Return frozen effective signer data and peer policy, and make participating inbox admission, worker revalidation and local checks use it rather than rereading raw arrays. Direct-only startup must explicitly reject peer-mode configuration before serving requests or contacting dependencies; its authorizer remains unchanged when peers are absent. Enforce the directory's execution domain against the fully resolved runtime configuration. On the worker, check the actual signer address equals `selfNodeAddress`; on the inbox, require `execution.nodeAddress` and `target` to match its self record. The inbox never receives the signing key.

Create a deterministic `peerPolicyHash` over the normalized directory snapshot, self identity, effective signer set and peer message-policy version. Use the existing SHA-256 `digest` helper after sorting normalized node/signer sets; require the resulting lowercase 64-hex-character value on the wire. The authenticated claim must have a valid matching hash exactly when the inbox has peers configured: reject missing, unexpected and mismatched hashes before acquiring work. Legacy claims without this field remain unchanged when both roles have peers absent. A peer-mode worker first performs a side-effect-free authenticated `POST /v1/worker/peer-policy` preflight and requires a supported response matching its target, execution identity and policy hash before any claim. An older inbox without this endpoint, or an inbox with peers disabled, must fail this preflight without acquiring a job. Keep the claim-time hash check as well so a later server restart/configuration change cannot bypass it. This detects disagreement between the two roles, not global freshness: two roles using the same obsolete snapshot can agree. Directory freshness/rollback remains operator-controlled, and role mismatch is detected before claim rather than necessarily before process startup. **Do not put the hash into `executionIdentity` or rewrite the stored Ledger identity.** No network requests, key generation, membership changes or delivery occur merely from loading configuration.

Add an inbox-only optional boolean `admissionPaused` in `src/inbox/config.mjs`, defaulting to `false`. With it enabled, `src/inbox/http.mjs` must reject `POST /v1/jobs` that pass existing request/resource guards with HTTP 503 and `inbox_admission_paused` before signature validation or enqueue, while preserving signed `/v1/status`, health and all authenticated worker routes (including policy preflight, claim, renew, checkpoint, complete and retry). Existing resource limits and authentication still apply. This is an operator-controlled startup setting, not a public toggle; persist it in the mounted configuration and restart only the inbox service with the original directory/policy to enter maintenance. It must remain paused across restarts and must not enter `peerPolicyHash` or execution identity. A short inbox restart may interrupt worker requests; existing durable leases/checkpoints support retry under the unchanged policy. Do not stop Caddy or leave the inbox stopped while attempting to drain. Resume requires explicitly setting `admissionPaused: false` and restarting after reconciliation. Document service-scoped restart commands for supported installations and test this transition in the packaged fixture.

### Milestone 2 — node-originated content and destination-specific jobs

Propose `src/peers/protocol.mjs` and a narrowly scoped peer message signer composed with existing protected node-key loading. The signer may produce only the defined peer-message domain and version-1 inbox job signatures; do not expose arbitrary remote signing or a raw wallet/private key to the HTTP layer. Message signing does not use or advance transaction nonces. Only the existing worker signs and broadcasts Ledger transactions. Keep one transaction-producing worker/target per Ledger account; a second worker or concurrent direct runtime does not gain shared nonce coordination from this feature.

Define the node-authored text as a fixed domain prefix `Oya peer message v1\n` followed by a canonical JSON array containing, in order, network ID, chain ID, normalized Ledger address, normalized originating node address, message UUIDv4, creation timestamp in milliseconds, and payload text. Fixed array order avoids ambiguous object serialization. Accept nonempty ASCII payloads without NUL; preserve accepted payload whitespace exactly. Validate the final serialized text against the receiver's existing text limit, including escaping and wrapper overhead; never truncate or normalize signed data. The directory grammar makes the network ID ASCII before serialization; no alternate Unicode-escaping convention is introduced. Golden vectors must cover accepted ID boundaries and rejected Unicode, whitespace and control characters. This is a proposed wire format to freeze with golden-vector tests after approval.

Sign this inner text **once**, validate that its recovered address is self, and retain the exact `{text, signer, signature}` for every recipient. Recipient endpoints, targets, request IDs, expiration and statuses belong outside that inner message, so B and C publish identical content. Use one common signed expiration policy per prepared fan-out, initially the existing 24-hour default and never above the current seven-day bound.

Add an additive `signJobFromMessage` helper alongside `signJob` in `src/inbox/protocol.mjs`. It verifies that the supplied signed message belongs to the outer signing account, then signs the existing `jobText` representation for a selected recipient and saved request ID. Preserve `signJob`'s existing API and behavior. Do not allow different inner and outer signers or expand version-1 envelope fields silently.

For a configured peer signer, both inbox admission and worker processing validate the peer domain, network/chain/Ledger, message format and destination target before queueing or publication. Require normalized declared inner origin = recovered inner-message signer = recovered outer-job signer = enrolled source address. A valid A signature must never authorize a message whose embedded origin claims to be B. Ordinary non-peer agent messages retain their existing behavior. If an address appears in both the manual and peer sets, peer-message checks still apply; the manual set must not bypass them. Check cryptographic signatures as well as the declared signer. Directory-wide unique targets provide the existing signed outer destination binding; the peer domain supplies network binding absent from plain inbox-v1 text. Inbox v1 does not cryptographically sign the HTTPS origin or recipient account. Unique targets bind destinations only within the approved directory; operator-confirmed endpoint/identity mappings remain a trust assumption, and an independent service cloning the same target is outside that guarantee. Do not automatically switch endpoints or fall back to the direct API after an uncertain result. If authenticated recipient/origin binding beyond this scope is required, revise the plan for a versioned outer job protocol rather than claiming it exists. A malicious node can always copy publicly available content and emit its own Ledger claim; this is not confidential or exclusive delivery.

This version originates **node-authored** messages. It does not impersonate an agent or automatically turn an agent's message into a node-authored one. Relaying a third party's preserved signed envelope under a different outer sender would require a separately reviewed protocol extension because inbox v1 requires the same signer. It is not a shortcut in this plan.

### Milestone 3 — bounded delivery and restart-safe outbox

Propose `src/peers/client.mjs`, `outbox.mjs` and `http.mjs`. Add an operator-facing `peer` CLI entrypoint, with separate offline inspection/preparation and explicit network submission/status commands. The proposed command surface is listed below; none exists yet. The initial implementation is deliberately on-demand, not an unattended broadcast daemon. An operator selects recipient addresses from the directory; optional all-peers selection must be explicit and must exclude self.

Preparation validates the current snapshot, recipients, key identity and payload; generates the message and per-recipient job IDs; and durably saves the exact signed jobs **before** any HTTP request. Use a private outbox directory, files restricted to their owner, exclusive creation/locking, bounded regular-file reads, and atomic journal updates with file/directory durability. Never follow an unexpected symlink, overwrite a different message, or invent replacements for corrupt/lost state. Store directory/policy identity, expected recipient execution identity, endpoint, target, request ID, expiration, exact signed payload and bounded latest observations. Do not store private keys, worker tokens or unbounded response bodies. The recipient database remains the execution authority.

Submission/status can use saved signatures without reopening the private key. Validate the outbox against the currently approved configuration before every network operation; an endpoint or policy change must stop automatic reuse rather than silently redirect an existing job. One invocation performs a bounded pass, with at most four concurrent peer requests, existing 10-second per-request and 128-KiB response limits, and a 120-second overall elapsed-time deadline. Record per-recipient partial outcomes instead of declaring all delivered when one recipient fails or the deadline expires. There are no unbounded background retries.

A 202 means accepted, not published. A timeout, malformed response or connection loss is unknown, not proof that nothing happened. Resume by polling the same saved job; an allowed resubmission uses its exact ID and signed bytes while valid. Never mint another job or extend its expiration automatically. Preserve 409 conflicts for investigation and distinguish rejected, accepted/pending, expired, unknown and peer-reported terminal states. A status query can remain possible after expiration using the original envelope, but it still requires current signer authorization and a retained database row. A rejection after revocation, a pruned/missing row, or a lost local record does not prove non-publication or authorize a replacement job. Preserve the existing distinction between expired queued jobs and already-processing jobs: processing/checkpointed transactions continue reconciliation and may publish after the deadline. Expiration is not cancellation and must not discard or replace them. Record elapsed local deadlines as observations only; do not turn an unknown/processing result into terminal “not published” solely because time passed. Deduplication is per recipient's target/request ID, not globally exactly-once delivery after database loss.

Validate returned IDs, state, CID/hash syntax and allowed result fields. Store `peerReportedStatus` separately from any future independently verified evidence; a peer-controlled HTTP result is not cryptographic proof of its claimed Ledger transaction. One failed/lying peer must not suppress healthy peers' results or overwrite their records.

Use `createInboxClient` through a dedicated peer transport adapter, with **no worker token** and only message-protocol headers. For production destinations, reject private, loopback, link-local, multicast, unspecified and other non-public addresses, including IPv4-mapped IPv6. Resolve all candidate addresses and fail closed on prohibited answers; connect only to a validated address without a second unchecked lookup. Preserve the original hostname for HTTP Host, TLS SNI and certificate validation, disable redirects and implicit proxy/environment routing, and reapply the destination policy for subsequent connections. These controls follow the [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Prefer a small `node:https` adapter with controlled resolution/connection handling rather than introducing a network stack dependency solely for this feature; [Node's HTTPS options](https://nodejs.org/docs/latest-v24.x/api/https.html) and [HTTP lookup hook](https://nodejs.org/docs/latest-v24.x/api/http.html) supply the relevant connection controls. Keep transport injection for local fixtures. Test-only private-address allowances and test certificate authorities belong to the harness, not a remotely supplied directory, production environment switch, or a global disable-TLS flag. Apply transport bounds through body completion, including slow responses.

Receiving, completing or observing a peer message must never invoke the outbound sender automatically. No gossip, recursive fan-out, auto-acknowledgment messages, or signing of remote instructions. Normal result logging and signed status polling are sufficient. The local worker token, provider authorization headers and node key must never leave their existing trust boundary.

### Milestone 4 — three-node acceptance and operator packaging

Add focused peer directory/policy, signed-message, outbound transport and outbox tests. Extend PostgreSQL/inbox fixtures to prove consistent policy on both roles, restart-safe recipient deduplication and unchanged transaction checkpoints. Add `scripts/test-peer-network.mjs` with isolated A/B/C inbox/worker installations, independent identities and Kubo stores, HTTPS, PostgreSQL and disposable Anvil. Generate all accounts locally and fund only local-chain identities. Do not use public Sepolia RPC or send public-chain transactions in tests.

Prepare A's message once, enqueue it to B and C while their workers are offline, restart services, and observe both recipients complete. Independently retrieve each recipient's exact IPFS bytes and inspect local-chain receipts: the CID and original signer A match, while the Ledger event's caller is B or C respectively. Send a new B-authored message to A to prove bidirectional operation. Duplicate submissions, lost acceptance acknowledgments and sender/worker restarts must retain IDs, reuse saved transactions and avoid extra Ledger events for the same delivery. Reject unknown node D before queue/IPFS/signing side effects. Verify no peer-delivery traffic merely from startup or completion, and no peer delivery to self or unconfigured destinations. Normal worker communication with its own inbox, including the authenticated policy preflight, remains expected.

Package the official registry snapshot and its contribution/rollout guide, with upstream source commit and file checksum, separately from placeholder-only examples. A release bundle’s snapshot may lag the current upstream registry; joining or updating the testnet requires an operator-verified merged snapshot and coordinated rollout, not treating the bundled revision as automatically current. Update `node/production/README.md`, `run-locally.md`, `host-inbox.md`, `deploy-with-agent.md`, `inbox-api.md` and the repository deployment skill where relevant. Describe membership as a grant of publication authority, protected key reuse, common directory distribution, expected self/execution identity, configuration inspection, explicit send/status and revocation/rollback constraints. Keep settings without peers backward compatible.

Include new runtime modules explicitly in `.dockerignore`, and include public example/documentation assets in `scripts/publish-image.sh` and its packaging tests. Wire read-only directory mounts through the supported inbox/local-worker deployment paths. Verify container permissions, relative path resolution and source-versus-release behavior in the packaged fixture. Do not modify existing live configuration files or publish an image/release as part of implementation validation. If an implementation requires dependency/kernel changes, document their rationale and separate any publication authorization.

### Later availability checks — preserved interfaces, not implementation scope

Retain enough correlation to connect the **origin signer**, **publishing node**, **destination job**, **canonical signed content/CID**, **chain**, and **Ledger** without conflating them. A future verifier can join multiple `Log` events for the same CID using the existing `hashLedgerCid`, `decodeLedgerEvent` and read-only Ethereum RPC helpers, filtering the configured Ledger and approved node identities.

That future feature must independently validate chain/contract, receipt/log identity, block hash/number, transaction hash/log index, removed-log/reorganization handling and an explicit confirmation policy. A directory entry or a transaction hash from a peer is not sufficient. `cidKeccak256Hash` hashes the CID string; it is not the content digest. Retrieved content must be checked against the full CID/codec/DAG representation and the original message signature, not merely against a valid-looking CID or a hash of the identifier.

A receiving inbox accepts jobs but does not serve stored content. A node-specific retrieval/challenge endpoint, authenticated responses and bounded content-fetch protocol need separate design; never expose Kubo's administrative API. Retrieval from a public gateway may come from a cache or another node and cannot by itself establish availability at the named peer. Report observations with observer, source, time, chain/log reference and retrieval result; use unknown/unavailable/reorged distinctions rather than declaring non-storage from one timeout. Local replication tests in this plan demonstrate local copies, not internet-wide availability or a proof system.

## Concrete Steps

All repository commands below run from the repository root. Commands involving new files or `peer` scripts are **proposed acceptance commands after approval**, not claims that those files exist now.

For this plan-only PR, check required ExecPlan sections, local documentation links, example JSON shape, formatting and the exact one-document diff. Do not create implementation scaffolding or commit tests merely to make proposed commands runnable.

After the approval gate, prepare the development environment with Node 24, Python 3, Docker/Compose and the repository's pinned Foundry toolchain:

```sh
npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
git submodule update --init --recursive
forge build --root contracts
```

After the corresponding milestones exist, run:

```sh
node --test node/production/test/peer-*.test.mjs
npm --prefix node/production test
npm --prefix node/production run test:inbox
npm --prefix node/production run test:inbox:docker
npm --prefix node/production run test:peer-network
npm --prefix node/production run test:ipfs -- --verbose
forge test --root contracts --offline
```

The new peer-network script should report explicit outcomes for A→B, A→C and B→A, matching CIDs/independent publishing addresses, restart/idempotency checks, rejection paths and fixture cleanup. Passing a build or one HTTP response alone is insufficient. Existing IPFS-only behavior must still pass. No contract changes are proposed; the contract build supplies the isolated-chain fixture.

Proposed CLI examples, using operator-selected paths and **not executable against current releases**:

```sh
npm --prefix node/production run peer -- inspect NODE_JSON
npm --prefix node/production run peer -- prepare NODE_JSON NODE_SECRETS MESSAGE_TEXT_FILE OUTBOX_DIRECTORY --to PEER_ADDRESS
npm --prefix node/production run peer -- submit NODE_JSON OUTBOX_DIRECTORY
npm --prefix node/production run peer -- status NODE_JSON OUTBOX_DIRECTORY
```

Inspection and preparation must be offline. Inspection reports public self/network identity, directory revision/hash, peer destinations and effective signer count, never secrets. Preparation stores signed jobs but makes no request. Submission and status are the explicit network actions; Ledger publication occurs only at authorized receivers under their established execution policy.

Before every handoff, run `git diff --check`, inspect all staged/unstaged/new files and PR text under [Before Human Review](../AGENTS.md#before-human-review), and record actual validation. For the plan PR, the only changed path must be `plans/peer-node-network-execplan.md`. Future implementation PRs must not claim this plan's prospective tests have already passed.

## Validation and Acceptance

| Acceptance case after implementation | Required observation |
| --- | --- |
| No `peers` configuration | Existing signer authorization, IPFS-only/direct behavior and startup remain unchanged; no added network traffic. |
| Direct-runtime entrypoint or IPFS-only mode with `peers` configured | Explicitly reject before serving requests or contacting dependencies; do not enable a synchronous peer bypass or second transaction nonce owner. |
| Official registry with manual agent signers | Each participating node accepts every other listed node plus its original manually approved signers; no per-peer opt-out or rewrite of the original manual list. |
| Registry contribution and distribution | CI validates additions/removals/endpoint changes and revision advancement without live endpoints; placeholders are not live entries. A merged revision is pinned by commit/checksum, installed in full on every participating pair and verified before enrollment is declared operational. Empty bootstrap registries cannot start a peer node; stale bundled snapshots and lagging installations are reported. |
| Effective signer/policy mismatch, either mixed-mode direction, or old inbox without peer preflight | Refuse before acquiring work; reject unexpected as well as missing hashes, with no partial execution or raw-array bypass. |
| Wrong self, execution domain, missing self record or duplicate identities/endpoints/targets | Local validation failure before startup/signing/network side effects. Role snapshot disagreement fails before claim; matching obsolete snapshots require operator rollback reconciliation, not a false freshness guarantee. |
| Network ID grammar boundaries | Accept 1 and 64 valid ASCII characters; reject empty/65-character IDs, `oya-é`, whitespace, controls and non-string IDs during loading before signing/network activity. Accepted golden vectors remain ASCII and pass the existing message validator. |
| Admissions paused with authorized senders still posting | Jobs receive 503 `inbox_admission_paused` without validation/enqueue; signed status and authenticated worker preflight/claim/renew/checkpoint/complete/retry remain usable under normal limits. Existing jobs drain under the original policy; pause survives restart and resume restores admission. Verify through the packaged Caddy route, including a request accepted before restart and ambiguous acknowledgments. |
| Malformed types, bad address checksum, zero address, extra fields, oversized/truncated file | Fail closed, including file-read limits before JSON parsing. |
| B/C offline at bootstrap or submission | Valid nodes start; delivery records distinguish queued/unknown/unreachable without changing endpoints or authorizing new identities. |
| A sends the same inner message to B and C | Original signer/content/CID remain identical; recipient job IDs/targets differ and Ledger callers are B and C. |
| B sends a new message to A | A accepts B's registered address and publishes through its own existing worker pipeline. |
| Wrong signature, unknown signer D, A-signed content claiming origin B, wrong domain/network/target, peer-format bypass via manual allowlist | Reject before durable admission, IPFS upload or transaction signing. |
| Lost POST response, duplicate submit, sender crash, receiver restart | Persist and reuse exact jobs; one recipient job and one Ledger transaction per target/request ID under retained database state. |
| Queued job expires versus processing/checkpointed job passes its deadline | Only queued work becomes expired automatically; in-flight work reconciles its original transaction even after expiry. A local deadline, status 403 or missing/pruned row must not imply “not published.” |
| Expired or conflicted job, missing/corrupt journal, ambiguous transaction outcome | Preserve evidence; do not generate replacement IDs, re-sign, extend deadlines or erase checkpoints automatically. |
| Remote 202, invented `logged` status, wrong IDs/hashes, oversized/slow/malformed response | Validate and label only peer-reported outcomes; do not mark on-chain verification or availability. |
| Private/loopback/link-local/mapped address, mixed public/private DNS, rebinding, redirect or proxy escape | Production peer transport refuses the destination; tested fixture exceptions cannot come from directory data. |
| Malicious endpoint asks for credentials or returns another URL | No worker/RPC/IPFS credentials or private key reach it, and routing stays on the approved endpoint. |
| Restart, receipt completion or inbound peer message | No automatic forwarding, acknowledgments, self-delivery or gossip amplification. |
| Peer removal, key/target/endpoint rotation, or membership rollback with pending work | Follow the controlled procedure below; no silent reassignment of jobs or Ledger identity. |
| Removed peer also appears in a manual allowlist | Full revocation removes both grants on both roles. Deliberately retained manual authority remains agent authorization, not revoked access. |
| Packaged image and installation bundle | New modules, public assets, mounts and relative paths work without depending on a developer checkout. |

An implementation is complete only when these behaviors have exercised tests and an independently reviewed diff. A later authorized live rollout must separately verify real endpoint ownership, matching identities, receiver admission and testnet funding before any public send. This plan neither names an approved live roster nor grants that rollout permission.

## Idempotence and Recovery

Treat the directory as an immutable startup snapshot. Installation/restart never downloads replacements, overwrites an existing node key, adds self to trusted remote signers, or silently merges remote peer lists. Adding a peer grants testnet authority through a reviewed, merged change to the official registry, followed by coordinated installation of its complete snapshot on every participating inbox and worker. Operators must apply official membership updates to remain participating; a divergent local list is not the official testnet. Emergency local shutdown or admission pause remains available without representing it as successful network rollout. Record the applied revision and normalized policy hash locally without publishing operator-specific paths.

Because authorization is a union, deleting a peer record alone does not revoke an address also present in a manual allowlist. Full signer revocation must remove it from the directory and manual allowlists on both inbox and worker, after the controlled procedure below. If an operator deliberately retains manual membership, describe that as retained agent authorization: once it is no longer a peer, peer-only domain restrictions no longer apply. Test both full revocation and deliberate retention; do not report either as the other.

Before changing membership, endpoints, targets, execution or node keys, stop launching outbound `submit` invocations and wait for existing bounded passes to exit; keep read-only status reconciliation available. On each affected inbox, persist `admissionPaused: true` and restart only that inbox with its original directory, key/execution identity and policy. Confirm the restarted process rejects `/v1/jobs` with `inbox_admission_paused` while signed status and authenticated worker access remain functional before declaring admissions stopped. Include requests accepted before shutdown, even when their clients lost acknowledgments, in the database inventory. Keep the worker running under the original policy to drain/reconcile queued and in-flight jobs. Do not change directory or key settings until all previously accepted work is terminal and ambiguous transactions/deliveries are reconciled. Then stop the worker, apply the coordinated directory/configuration change, restart the inbox with admissions still paused, restart the worker and verify policy preflight before explicitly resuming admissions and outbound submissions. Unknown or checkpointed transactions block a blind cutover: an allowlist edit cannot undo a transaction already signed or sent. Preserve existing database state and signed transaction bytes. Do not remove authorization and then repeatedly retry a now-unprocessable job, clear a checkpoint, change a nonce, or repoint an old target to a new identity to force progress. If safe draining is impossible, leave the installation paused and require an explicit recovery decision rather than silently spending or discarding work. Document this conservative first-version limitation; instantaneous revocation plus cancellation of existing work is not promised.

For an endpoint change or key rotation, do not silently edit saved outbound jobs. An unresolved old delivery must be reconciled at its original destination/identity; new authorizations apply to newly prepared jobs after the coordinated change. Back up configuration, directory revision, outbox and recipient database together. Restoring an older outbox/directory/database can reintroduce revoked trust or lose deduplication history; require reconciliation instead of assuming exactly-once guarantees survive rollback.

Tests own unique service names, fresh accounts and disposable volumes and clean up only those resources. Never prune or restart a live installation. If an acceptance check fails, preserve sanitized evidence and fix the design/implementation after approval; do not weaken signatures, TLS, CID verification, queue durability or destination restrictions to obtain a pass.

## Artifacts and Notes

The baseline inspection found the existing public receive/status paths at `/v1/jobs` and `/v1/status`, and separate authenticated `/v1/worker/*` routes. `processWork` already revalidates the job and checkpoints the CID and signed transaction before broadcast. Ledger's event records the publishing caller and opaque CID claim, not a directory enrollment or storage guarantee. These source observations justify reuse instead of a parallel publisher, new logging contract or unauthenticated peer-ingress API.

The two JSON examples define a reviewable proposed data shape only. The first real registry entries must be assembled through reviewed pull requests from explicitly approved node addresses, targets and public endpoints with owner confirmation; no addresses should be scraped from transaction logs or copied from private installation records into a public PR.

The independent source-architecture review confirmed the inbox-first design, the raw-worker-allowlist integration trap, same-signer restrictions, origin-versus-publisher distinction and current availability limitations. It also prompted explicit statements about target-only destination binding, no transport fallback, one nonce-producing worker per account, and continued reconciliation after job expiration.

The independent plan review was resolved by requiring declared-origin/recovered-signer equality, explicit direct-runtime rejection, complete revocation of overlapping manual grants, bidirectional peer-policy presence checks with old-inbox preflight protection, and precise expiry/status-retention semantics. Matching snapshots are not represented as proof of global freshness.

Plan-only validation passed for the twelve required headings, both proposed JSON examples, eighteen repository-relative links/anchors, whitespace and sensitive-information checks. The diff contains only this Markdown document. No runtime or prospective peer acceptance tests were run; there is no implemented feature to claim validated. Record later approval references here before beginning implementation. Keep signed jobs, credentials, private deployment state and test scratch artifacts outside the committed plan. All implementation acceptance results remain pending until the gate is satisfied and those tests actually run.

## Interfaces and Dependencies

Proposed internal interfaces are `parsePeerDirectory(raw)`, a bounded local directory loader, `resolvePeerPolicy(manualSigners, directory, selfNodeAddress)`, peer-message encoding/validation, the restricted peer signer, `signJobFromMessage`, an outbox store and an injected safe HTTP transport. Their exact exported shapes should be frozen with focused tests in the implementation PR; the behaviors and trust boundaries above are normative for this proposed plan.

Reuse ethers address/signature validation, Node's cryptography/filesystem/HTTPS facilities, `createSignedMessageAuthorizer`, `createInboxClient`, existing inbox job validation, PostgreSQL journal/checkpoints, `publishSignedMessage`, and the current Ledger ABI. No changes to the Ledger contract, existing package signing algorithms, global agent runner, or on-chain registration are proposed. A public directory grants no worker-token authority. Signing material remains local to the node and never belongs in its directory, receive endpoint, HTTP response or shared bootstrap artifact.
