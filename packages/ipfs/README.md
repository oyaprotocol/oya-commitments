# @oyaprotocol/ipfs

Utilities for publishing and retrieving Oya-related data through IPFS. This package is a hardened kernel surface: callers provide explicit transport settings, explicit `fetch` implementations, and explicit bounds instead of relying on process-level defaults.

## Public Entrypoint

- `@oyaprotocol/ipfs`

## Current Surface

- `createIpfsConfig(options)`: validate explicit transport settings for IPFS publication and retrieval.
- `publishToIpfs(options)`: publish and pin content through a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies. The add request explicitly sets `pin=true`.
- `readIpfsBytes(options)`: read bounded bytes by CID from a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies.
- `readIpfsPublicGatewayBytes(options)`: read bounded bytes by CID from a public IPFS gateway using `GET /ipfs/<cid>` and explicit dependencies.
- `readIpfsPublicGatewayText(options)`: read bounded ASCII text by CID from a public IPFS gateway using `readIpfsPublicGatewayBytes(...)` plus text-specific verification.
- `readIpfsText(options)`: read bounded ASCII text content by CID from a Kubo-compatible IPFS HTTP API using `readIpfsBytes(...)` plus text-specific verification.

## Behavior

`createIpfsConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized for Kubo by trimming trailing slashes and a trailing `/api/v0` segment.

`publishToIpfs(...)` is the standard add-and-pin primitive. It sends a Kubo `/api/v0/add` request with `cid-version=1`, `pin=true`, and `progress=false`, then returns normalized CID, URI, byte length, and pin metadata.

Kubo reads and public gateway reads are separate because they target different interfaces. `readIpfsBytes(...)` and `readIpfsText(...)` use Kubo RPC with `POST /api/v0/cat`; `readIpfsPublicGatewayBytes(...)` and `readIpfsPublicGatewayText(...)` use public gateway HTTP with `GET /ipfs/<cid>`.

All read helpers require `maxBytes`. This keeps unexpectedly large content from consuming unbounded memory when the helper combines streamed chunks into a single `Uint8Array`. Text helpers are intentionally ASCII-specific wrappers over byte reads so text artifacts can be validated narrowly.

## Indexing

Pinning keeps content retained by an IPFS node, but it does not create a discovery index. Public CID discovery is intentionally deferred to a future onchain Logger design where nodes can publish data to IPFS and log CIDs onchain for verifiers and interfaces to scan.
