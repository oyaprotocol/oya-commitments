# @oyaprotocol/publishing

Utilities for publishing and indexing Oya-related data.

## Public Entrypoint

- `@oyaprotocol/publishing`

## Current Surface

- `createIpfsPublishConfig(options)`: validate explicit transport settings for IPFS publication.
- `publishToIpfs(options)`: publish content to a Kubo-compatible IPFS HTTP API using explicit config and explicit dependencies, with no implicit defaults.
