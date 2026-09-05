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
- `HttpStatusError`: thrown when an HTTP response itself is not successful, re-exported from `@oyaprotocol/utils`.

## Behavior

`createIpfsConfig(...)` accepts the shared `CreateHttpConfigOptions` shape from `@oyaprotocol/utils`. The `url` value is normalized for Kubo by trimming trailing slashes and a trailing `/api/v0` segment.

`publishToIpfs(...)` is the standard add-and-pin primitive. It sends one multipart file to `/api/v0/add` with the fixed import settings below, then returns the validated CID, URI, byte length, and provider metadata. The host supplies an HTTP service implementing that interface; this package requires no Kubo SDK, CLI, or local daemon.

Publication snapshots mutable content before the first attempt so retries send identical bytes. `filename` must be a single filename, with no slash, backslash, NUL, CR, or LF, and cannot be `.` or `..`. Surrounding whitespace is trimmed. With directory wrapping disabled and file metadata omitted, the filename and media type do not affect the file CID.

Kubo reads and public gateway reads are separate because they target different interfaces. `readIpfsBytes(...)` and `readIpfsText(...)` use Kubo RPC with `POST /api/v0/cat`; `readIpfsPublicGatewayBytes(...)` and `readIpfsPublicGatewayText(...)` use public gateway HTTP with `GET /ipfs/<cid>`.

All read helpers require `maxBytes`. This keeps unexpectedly large content from consuming unbounded memory when the helper combines streamed chunks into a single `Uint8Array`. Text helpers are intentionally ASCII-specific wrappers over byte reads so text artifacts can be validated narrowly.

## Canonical CIDs and File Imports

All CID inputs and successful publication responses must be **CIDv1 in lowercase, unpadded Base32 with a 32-byte SHA-256 digest**. The shared `assertCanonicalCid` helper from `@oyaprotocol/utils` validates the binary structure as well as the spelling. The package rejects noncanonical values instead of converting them: CIDv0, uppercase, other bases, surrounding whitespace, `ipfs://` URIs, and paths such as `<cid>/message.json` are not accepted. Pass the bare `cid` result into reads and Logger helpers.

Every upload explicitly sends the file settings from [the `unixfs-v1-2025` profile](https://specs.ipfs.tech/ipips/ipip-0499/), plus canonical text output and pinning:

| RPC option | Value |
| --- | --- |
| `cid-version` | `1` |
| `cid-base` | `base32` |
| `hash` | `sha2-256` |
| `chunker` | `size-1048576` (1 MiB) |
| `raw-leaves` | `true` |
| `trickle` | `false` (balanced tree) |
| `max-file-links` | `1024` |
| `wrap-with-directory` | `false` |
| `inline` | `false` |
| `preserve-mode`, `preserve-mtime` | `false` |
| `pin` | `true` |
| `progress` | `false` |

These settings are fixed in the package, with no caller override. Identical file bytes imported by a conforming provider yield the same CID. Files fitting in one chunk use a raw block; larger files use a UnixFS DAG-PB root linking their chunks. Different bytes, serialization, or import settings can still produce different CIDs. This change can alter future publication CIDs compared with the previous provider defaults; existing canonical CIDs remain valid read inputs regardless of their original import recipe.

Providers must support and honor these [RPC options](https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-add). Returned CID validation checks the identifier's structure; it does not recompute the file DAG, verify downloaded content against the CID, or prove storage. `pinned: true` reports a successful add with pinning requested, not an independent pin audit. Invalid provider CIDs fail without transport retries.

`packages/test/fixtures/cids.json` records independently generated CIDs for empty files, message JSON, and bytes below, at, and above the 1 MiB chunk boundary. They were generated with IPFS CLI 0.40.1 using an isolated temporary repository, offline mode, `--only-hash`, the settings above, and `--pin=false`. Tests use these committed fixtures and injected transports; they require no IPFS installation or live service and do not establish a provider's conformance.

## Indexing

Pinning keeps content retained by an IPFS node, but it does not create a discovery index or publication order. Hosts can compose publication with the Logger helpers in `@oyaprotocol/ethereum` to record the canonical CID onchain. `hashLoggerCid(cid)` computes the indexed lookup topic from the same validated spelling; verifiers and interfaces can scan events by block and log position.
