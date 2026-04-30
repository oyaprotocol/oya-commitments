# @oyaprotocol/publishing

Utilities for publishing and indexing Oya-related data.

## Public Entrypoint

- `@oyaprotocol/publishing`

## Current Surface

- `createIpfsPublishConfig(options)`: validate explicit transport settings for IPFS publication.
- `publishToIpfs(options)`: publish and pin content through a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies. The add request explicitly sets `pin=true`.
