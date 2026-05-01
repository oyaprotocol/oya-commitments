# @oyaprotocol/publishing

Utilities for publishing and retrieving Oya-related data.

## Public Entrypoint

- `@oyaprotocol/publishing`

## Current Surface

- `createIpfsConfig(options)`: validate explicit transport settings for IPFS publication and retrieval.
- `publishToIpfs(options)`: publish and pin content through a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies. The add request explicitly sets `pin=true`.
- `readIpfsBytes(options)`: read bounded bytes by CID from a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies.
- `readIpfsPublicGatewayBytes(options)`: read bounded bytes by CID from a public IPFS gateway using `GET /ipfs/<cid>` and explicit dependencies.
- `readIpfsPublicGatewayText(options)`: read bounded ASCII text by CID from a public IPFS gateway using `readIpfsPublicGatewayBytes(...)` plus text-specific verification.
- `readIpfsText(options)`: read bounded ASCII text content by CID from a Kubo-compatible IPFS HTTP API using `readIpfsBytes(...)` plus text-specific verification.
