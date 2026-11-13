# Testnet peer directory — offline bootstrap milestone

`testnet-directory.json` is the official repository-hosted public directory, maintained through reviewed PRs. It starts with **no enrolled nodes**: no verified roster has been supplied. Empty data is valid for inspection and packaging, not a runnable peer network. No example address is enrolled.

**This milestone does not enable peers.** The production inbox and worker do not load this directory, derive signers from it, or send peer messages. Keep using the existing explicit `allowedSigners` configuration. Do not add the proposed `peers` configuration from the network plan to a running node; runtime config still rejects it. Directory validation grants no authority and does not change any installation.

## Inspect or review a snapshot

With Node 24 and locked production dependencies installed in a reviewed source checkout, run from the repository root:

```sh
npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
node node/production/scripts/peer-directory.mjs inspect node/production/peers/testnet-directory.json
node node/production/scripts/peer-directory.mjs compare BASE_DIRECTORY_JSON CANDIDATE_DIRECTORY_JSON
```

Replace the two comparison placeholders with local files. The commands only read files; they never download a registry, resolve DNS, contact endpoints, load a key, inspect environment credentials or modify config. Output is JSON; exit 0 means valid, 1 means validation/read/revision failure and 2 means incorrect arguments. Failures use stable error codes without echoing file contents, endpoints or input paths. Fix the candidate explicitly and rerun; failure does not rewrite either file.

`inspect` reports sorted public records, `nodeCount`, `bootstrapOnly`, the revision and execution domain, and:

- `fileSha256`: SHA-256 of the exact file bytes, including whitespace. Use this to compare a pinned upstream file with a bundle or another copy.
- `contentSha256`: SHA-256 of the normalized version/network/execution/records. Addresses are lowercase, nodes sorted by address, object fields fixed, and revision omitted. It identifies membership/routing content independently of JSON layout, array order or address casing. It is **not** the future runtime peer-policy hash and includes no self identity or manual signer list.
- `runtimeAuthorization: "unchanged"`: this command never grants or revokes permission.

`compare` returns sorted `added`, `removed` and `updated` records (updates include before/after), exact checksums and candidate content hash. A key rotation is a removal plus addition. Changed content requires a strictly higher positive revision. An unchanged snapshot permits the same or a higher revision, but never a lower revision. Revision gaps are allowed; revision-only updates are visible. Changes to the network ID, chain or Ledger are rejected and require a separately reviewed new directory/migration, not repurposing this network's identity.

These checks prove structure and consistency, **not** upstream provenance, latest membership, endpoint ownership, reachability, public routability, contract code, account control, message delivery or content availability. The parser accepts syntactically canonical HTTPS destinations, including IP literals; it performs no DNS or SSRF checks and must not be used as a safe network transport. Future transport must independently enforce public-destination resolution/connection policy and reject redirects.

## Version 1 schema

Only these exact fields are accepted; missing or extra fields fail at every level:

| Location | Fields and constraints |
| --- | --- |
| Root | `version: 1`; `networkId`: 1–64 ASCII characters matching `[a-z0-9][a-z0-9._-]*`; positive safe-integer `revision`; `execution`; `nodes`. |
| `execution` | `mode: "ledger"`; positive safe-integer `chainId`; nonzero Ethereum `ledgerContract`. |
| Each node | Nonzero Ethereum `nodeAddress`; one `receiveUrl`; one `target`. |
| `receiveUrl` | Canonical HTTPS URL ending exactly in `/v1/jobs`, at most 2,048 characters. No credentials, query, fragment, whitespace, backslashes, dot segments, escaped path, Unicode host normalization, trailing hostname dot or explicit default port. Non-default ports are allowed. |
| `target` | 1–64 ASCII characters matching `[a-z0-9][a-z0-9_-]*`, matching the inbox's existing target vocabulary. |

All strings are checked as given, including trailing newlines. Addresses must be exactly `0x` plus 40 hex digits, with valid mixed-case checksums; all-lowercase/all-uppercase hex is allowed and display output is checksummed. Address, endpoint and target duplicates are rejected. Case-normalized addresses count as duplicates. Maximum 256 records and 256 KiB of UTF-8 JSON. Files must be regular files; leaf symlinks, special files, oversized reads, invalid UTF-8/JSON and observed changes during reading fail closed. Use trusted local directories: parent-directory symlinks and filesystem provenance are not authenticated.

## Enrollment and revision review

1. Submit only public node addresses, HTTPS receive endpoints and inbox targets. Never include signing keys, worker tokens, RPC credentials, database URLs, private install paths or private endpoint inventories. Do not copy example identities into the official roster.
2. Supply public evidence of control of the signing identity and endpoint for maintainers to verify, together with confirmation of the execution domain. Validation alone cannot establish that evidence. No specific enrollment proof protocol is introduced here.
3. Change the complete official directory and increase `revision` for any membership/routing edit. Preserve immutable network/execution identity. A rollback of membership is a new reviewed higher revision, never silently restoring an old numeric revision.
4. Run `inspect` and `compare` against the current upstream snapshot. CI validates the candidate and compares it with the exact PR-base snapshot. Formatting/order/case-only changes do not require a revision bump; removals and endpoint/target changes do. If the base has no directory, introduction must be empty revision 1. Missing/unreadable base commits fail rather than bypassing comparison.
5. Obtain human review and merge. Merge alone does not authorize deployment, update installations or make enrollment operational.

In the later peer-policy milestone, every participating testnet node must support **all other listed nodes**, while preserving separately approved agent signers. Both inbox and worker must use the same pinned complete directory and resolved signer policy, with disagreement rejected before claiming work. There is no per-peer private subset representing official membership. That runtime milestone must supply maintenance/draining, key/self/execution checks and controlled coordinated rollout before enrollment can be operational. See the source checkout's `plans/peer-node-network-execplan.md` for the broader architecture; none of its delivery commands are implemented here.

## Bundles and provenance

Future release bundles include `peers/testnet-directory.json`, this guide and `peers/snapshot.json`. The generated metadata names the source Git commit, directory revision and exact file SHA-256. It is an attribution/checksum record, not a signature or independent proof of provenance. Verify the source commit against the reviewed upstream release and compare the exact registry bytes from that commit. Do not trust arbitrary downloaded metadata merely because its checksum matches.

The bundled snapshot can lag upstream; it is not automatically current membership. The source CLI is intentionally not added to the production image or standalone deployment bundle. Inspection needs the reviewed source checkout and its dependencies; bundle consumers can compare the recorded SHA-256 using their local checksum utility. Existing releases may contain no peer assets. The updated upgrade verifier accepts both old bundles and these new public files; an older verifier can reject new assets, so use the reviewed updated upgrade helper when upgrading across this packaging change.

No directory mount, runtime module inclusion, config migration, release publication or deployment is performed by this feature. Reverting its tooling/assets has no effect on existing runtime permissions or stored jobs. Future runtime rollbacks must reconcile queued work and overlapping manual grants; this offline validator does not make those actions safe.
