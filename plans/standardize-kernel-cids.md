# Standardize CIDs across IPFS and Logger helpers

This ExecPlan follows `PLANS.md` and covers the IPFS, Ethereum, utils, and message
publication packages. It supersedes the earlier opaque-string CID policy in the
offchain helpers; the deployed Solidity event format remains unchanged.

## Purpose / Big Picture

Nodes using the kernel should publish identical file bytes with the same import
recipe and use one CID spelling in reads, Logger calls, and lookup hashes. Use
CIDv1, lowercase unpadded Base32, and SHA-256. IPFS interaction remains HTTP with
host-injected transports; no Kubo SDK or local daemon becomes a dependency.

## Progress

- [x] 2026-09-05: Read package instructions and existing upload/read/Logger paths,
  and verified the IPFS import profile and RPC flags against primary sources.
- [x] 2026-09-05: Confirmed the workspace is clean and an existing IPFS CLI
  0.40.1 is available for optional offline fixture generation.
- [x] 2026-09-05: Proceeded with strict rejection, consistent with the user's request
  to enforce one format, after the optional conversion question received no answer.
- [x] 2026-09-05: Implemented shared CID validation at all IPFS and Logger boundaries,
  plus `hashLoggerCid` and decoded CID/hash correspondence checks.
- [x] 2026-09-05: Fixed file import settings, validated provider results, prevented
  directory-path filenames, and snapshotted mutable upload bytes across retries.
- [x] 2026-09-05: Added nine independent CID and ABI fixtures, cross-package flow
  coverage, rejection cases, and package/contract documentation.
- [x] 2026-09-05: Build, all 168 runtime tests, both TypeScript consumer checks,
  all four package-root imports, and whitespace checks passed inside the sandbox.
  Reviewed source, fixtures, dependency changes, and generated output.

## Surprises & Discoveries

- Before this change, IPFS supplied only CIDv1, pinning, and progress options;
  provider configuration controlled the hash, chunker, and tree layout.
- Existing tests use invented strings such as `bafy-test`; these must become
  valid CID fixtures while retaining transport, retry, and cancellation coverage.
- `publishSignedMessage` already fixes JSON field order and preserves the signed
  envelope bytes; differing signatures or text remain different artifacts.
- `@noble/hashes` 2.2.0 is already installed and used by the messages package.
  Ethereum lookup hashing can reuse it through an explicit package dependency.
- Independent hash-only CLI fixtures switch from a raw root at 1,048,576 bytes to
  a DAG-PB root at 1,048,577 bytes. No daemon or actual upload was needed.
- The filename regression test initially failed for a trailing CR/LF because
  trimming removed it before validation. Checking the original filename for
  separators fixes the failure while retaining surrounding space trimming.
- The existing CI package job checks build freshness only. Runtime and consumer
  type tests were run explicitly with the commands below.

## Decision Log

- 2026-09-05 / user and Codex: Keep the Kubo-compatible HTTP interface; standardize
  the file portion of `unixfs-v1-2025` explicitly on each upload. Use SHA-256,
  1 MiB fixed chunks, raw leaves, original balanced layout, 1024 file links,
  CIDv1/Base32, no wrapping, inlining, permissions, or modification timestamps.
- 2026-09-05 / Codex: Put shared CID format validation in utils because IPFS and
  Ethereum both require it. Keep file-import settings local to IPFS.
- 2026-09-05 / Codex: Enforce the offchain protocol at package boundaries.
  Do not add onchain byte scanning or change `Log(address,bytes32,string)`.
  Event decoding must never silently rewrite a recorded CID, which would sever
  its relationship to the indexed hash. Reject nonconforming matching events.
- 2026-09-05 / Codex: Provide a Logger CID hash helper using the existing audited
  Keccak implementation and check decoded hash/CID correspondence. No custom
  cryptography or general Ethereum ABI dependency is needed.
- 2026-09-05 / Codex: Reject alternate representations instead of converting them.
  This implements the requested strict format and prevents silent rewriting of
  identifiers already used as lookup keys. The optional input-policy question
  received no answer before proceeding; the assumption was stated to the user.
- 2026-09-05 / Codex: Validate minimally encoded codec integers up to 63 bits
  without a codec registry allowlist. Creation uses raw and DAG-PB; reads and
  Logger helpers need not freeze the evolving codec registry to enforce one
  version, text base, hash algorithm, and digest size.

## Outcomes & Retrospective

Complete. IPFS publication requests a fixed import recipe and validates every
supported CID response shape. All four read helpers and Logger call, lookup,
and event helpers enforce the same spelling without normalization. A signed
message fixture passes through publication, Logger ABI encoding/hash/decoding,
and RPC/gateway retrieval with one unchanged CID using injected transports.

All 168 runtime tests passed (15 utils, 50 IPFS, 49 messages, 54 Ethereum), along
with the workspace build, both consumer type suites, package imports, and diff
checks. Generated `dist` files and the npm lockfile are updated. No Solidity
source changed, and no contract tests, deployment, live RPC, or publication were
needed. Provider conformance and content availability remain external assumptions;
the tests establish the request/response contract using independent fixtures.

## Context and Orientation

`packages/ipfs/src/publish.ts` builds multipart uploads and parses the returned
root CID. `read-bytes.ts` and `read-public-gateway-bytes.ts` own shared read paths;
text helpers delegate to them. `packages/ethereum/src/logger.ts` encodes calls
and decodes events. `packages/utils/src/index.ts` exports shared utilities.
Generated JavaScript, declarations, and maps in each package's `dist/` are tracked.
The contract records arbitrary string bytes, while the kernel can require its
own stricter CID policy without modifying `contracts/src/Logger.sol`.

## Plan of Work

First define the immutable import query and obtain independent CIDs using the
existing CLI offline in a temporary repository, with no daemon or real uploads.
Then add a strict structural CID validator (including canonical Base32 padding,
minimal integer encodings, CID version, and SHA-256 digest length) and integrate
the input policy at all boundaries. Update mocked transport fixtures to real
CIDs and add rejection cases before network calls and after invalid responses.
Add shared lookup hashing and verify Logger fixtures against Foundry's ABI and
Keccak tools. Document the compatibility change and the limits of remote import
validation, then build and test all impacted packages.

## Concrete Steps

Run from the repository root:

    npm --prefix packages run build
    node --test packages/utils/test/*.test.js packages/ipfs/test/*.test.js packages/messages/test/*.test.js packages/ethereum/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    packages/node_modules/.bin/tsc -p packages/messages/tsconfig.type-test.json
    git diff --check

Smoke-import all changed packages from `packages/`. If package metadata changes,
update the npm lockfile offline using installed dependencies. Generate CID
fixtures with the already installed `ipfs` CLI using a temporary `IPFS_PATH`,
offline mode, `--only-hash`, `--pin=false`, and all explicit import flags. Normal
runtime tests must read committed fixtures and require neither IPFS nor Foundry.

The lockfile was updated with:

    npm --prefix packages install --package-lock-only --offline --ignore-scripts --no-audit --no-fund

For optional fixture reproduction, initialize an empty temporary IPFS repository
with `ipfs init --empty-repo --profile=test`, passing its path as `IPFS_PATH` to
both that process and the command below. Send exact fixture bytes through stdin:

    ipfs add --offline --only-hash --quieter --cid-version=1 --cid-base=base32 --hash=sha2-256 --chunker=size-1048576 --raw-leaves=true --trickle=false --max-file-links=1024 --wrap-with-directory=false --inline=false --preserve-mode=false --preserve-mtime=false --pin=false --progress=false

The fixture file specifies each input as literal UTF-8 text, hex bytes, or a
repeated byte and length. Use `cast abi-encode 'f(bytes)' <CID hex bytes>` for
event data and `cast keccak <CID hex bytes>` for its lookup hash. Prefix the
event data bytes with selector `0x41304fac` for calldata. These optional tools
generate fixtures only and are not package or ordinary test dependencies.

## Validation and Acceptance

Canonical CIDs survive round trips unchanged. Malformed alphabet/padding,
nonminimal integers, wrong version/hash/digest length, paths, URI strings, empty
strings, and non-ASCII values cannot reach a read or Logger submission. Provider
CID failures must not be retried as transport errors. Exact file bytes must have
known CIDs at and across chunk boundaries under the chosen profile. Logger hashes
must match independently generated Keccak vectors and decoded matching events
must validate both CID shape and hash correspondence. Existing cancellation,
timeouts, bounded reads, pinning requests, and signature preservation must pass.

## Idempotence and Recovery

All code, fixture generation, and tests run locally. Temporary test repositories
stay outside tracked source; no real keys or provider credentials are required.
This is an intentional tightening of accepted offchain input. Previously logged
claims cannot be rewritten; consumers of nonconforming historical events need
their old/raw decoding path. Changing import parameters can change future CIDs
for larger files while existing content remains retrievable by its old CID.

## Artifacts and Notes

The standard profile specifies 1,048,576-byte chunks, 1024 children per file node,
SHA-256 and raw leaves. Our primitive uploads one file and no directory metadata.
CID validation cannot prove that a remote service used the requested chunker or
stored/pinned the data; it checks the returned identifier's structure. The
explicit query and independent fixtures define the provider compatibility contract.

## Interfaces and Dependencies

Public additions:

    // @oyaprotocol/utils
    assertCanonicalCid(value: unknown, label: string): string
    // @oyaprotocol/ethereum
    hashLoggerCid(cid: string): string

The validator returns the original CID or throws `TypeError`; it does not trim
or convert. It validates Base32 alphabet and unused bits, CID version, minimal
codec varint encoding, SHA-256 algorithm, exact digest length, and absence of
trailing data. `hashLoggerCid` returns lowercase `0x`-prefixed Keccak-256 of that
validated CID's bytes. Existing encode/decode/publish/read signatures remain
unchanged but now reject nonconforming CIDs. Decode also verifies hash equality.

`packages/ipfs/src/import-profile.ts` owns the fixed RPC query internally; it is
not a public configuration surface. IPFS and Ethereum retain package-root-only
imports from utils. Ethereum adds the already-used `@noble/hashes` 2.2.0 as an
explicit dependency. No Kubo, multiformats, or general ABI dependency was added.

References: [CID specification](https://specs.ipfs.tech/cid/),
[UnixFS CID profiles](https://specs.ipfs.tech/ipips/ipip-0499/), and
[Kubo RPC options](https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-add).
