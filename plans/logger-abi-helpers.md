# Add Logger call and event helpers with CID indexing

This ExecPlan follows `PLANS.md` and implements the next small Logger integration
step after Ethereum receipt handling, including the approved indexed CID hash.

The milestones below record the original ABI implementation and CID index
extension. Their permissive offchain string policy, fixture set, and absence of
runtime hashing are superseded by [Standardize kernel CIDs](standardize-kernel-cids.md).
Current helpers require canonical CIDs, expose `hashLoggerCid`, and verify the
event's hash using `@noble/hashes`; the Solidity ABI remains the one recorded here.

## Purpose / Big Picture

A host can prepare calldata for the deployed Logger and interpret its receipt
events through `@oyaprotocol/ethereum`. The existing contract exposes
`log(string)` and emits
`Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)`.
The hash enables RPC topic filtering by a known CID while event data preserves
the full CID. Calldata is the
hex-encoded function selector and arguments carried by an Ethereum transaction;
an event contains indexed values in topics and other values in its data bytes.

## Progress

- [x] 2026-09-04: Reviewed the contract, package guidance, byte validators, receipt types, and Solidity ABI specification. Verified selector and event topic using offline Foundry commands.
- [x] 2026-09-04: Added and exported both helpers and their input/result types; reused the existing package-local byte validator.
- [x] 2026-09-04: Added 11 behavioral tests, 11 independent Foundry fixtures, and TypeScript consumer checks. Logger's eight existing contract tests passed, including 256 fuzz cases.
- [x] 2026-09-04: Documented host use and regenerated tracked output. Build, all 52 Ethereum tests, TypeScript consumer checks, package-name imports, all eight offline Logger contract tests, and diff checks passed inside the sandbox.
- [x] 2026-09-05: Moved `parseBytes` unchanged to shared validation utilities and updated Ethereum imports. Build, 63 Ethereum/utils tests, TypeScript consumer checks, package-name imports, and diff checks passed inside the sandbox.
- [x] 2026-09-05: Reviewed the approved CID index update and recorded the unchanged 46-character CID call baseline of 24,905 gas with the pinned compiler.
- [x] 2026-09-05: Added indexed `cidKeccak256Hash` in the contract and decoded event, updated tests and 11 independent fixtures, and documented exact-string lookup behavior.
- [x] 2026-09-05: Contract formatting/build/ABI checks, eight contract tests (256 fuzz cases), refreshed gas snapshot, package build, 53 Ethereum runtime tests, TypeScript consumer checks, package-root import checks, and diff checks passed inside the sandbox.
- [x] 2026-09-05: Linked the subsequent CID standardization plan, which replaces the offchain opaque-string policy and adds shared lookup hashing without changing Solidity.

## Surprises & Discoveries

- Logger permits empty and arbitrary strings. The initial codec imposed no CID
  syntax policy; the subsequent standardization plan tightens the offchain
  boundary. UTF-8 byte lengths, rather than JavaScript string lengths, determine
  ABI lengths. JavaScript strings with unpaired surrogates cannot be encoded losslessly.
- Receipt parsing supplied a strict, variable-size byte validator. `parseBytes`
  now lives in `packages/utils/src/validation-utils.ts` and is exported through
  `@oyaprotocol/utils` for receipt parsing and Logger decoding.
- Solidity strings can hold invalid UTF-8 bytes. The decoder returns JavaScript
  text and therefore rejects these bytes instead of replacing them silently.
- Foundry's CLI string coercion strips a trailing newline. The first fixture
  checks exposed that normalization. Generate exact string argument bytes using
  `cast abi-encode 'f(bytes)' <UTF-8 hex>` instead: ABI strings and bytes have the
  same layout. Prefix the independently compiled Logger selector for calldata.
  Ordinary string cases also match `cast calldata 'log(string)'` directly.
- The indexed hash is Keccak-256 of the exact CID string bytes, not the digest
  embedded in an IPFS CID. Different text encodings of equivalent CIDs produce
  different lookup hashes; the contract preserves its existing opaque-string policy.

## Decision Log

- 2026-09-04 / Codex: Implement only `encodeLoggerCall` and
  `decodeLoggerEvent` in `packages/ethereum/src/logger.ts`. Fixed signatures
  allow checked constants and a small ABI codec without runtime hashing or a
  general ABI dependency. Signing, RPC submission, polling, finality policy, and
  IPFS composition remain with their existing helpers or future host integration.
- 2026-09-04 / Codex: Require the expected Logger address as the decoder's second
  argument. Return null for other emitters or event signatures, and throw for
  malformed matching events. Check exactly two topics, zero-padded indexed
  address, offset 32, bounded length, exact padded payload size, zero padding,
  and valid UTF-8. Preserve address hex casing and text, including leading BOM.
- 2026-09-04 / Codex: Preserve optional `removed` metadata in decoded events,
  including true, so callers can handle reorganization notifications. Decoding
  alone does not establish transaction success, finality, or content validity.
- 2026-09-05 / Codex: Move `parseBytes` to shared validation utilities at the
  user's request. It has no receipt-specific behavior; preserve its validation
  and error messages unchanged and reuse the existing utils dependency.
- 2026-09-05 / user and Codex: Add `bytes32 indexed cidKeccak256Hash` between
  `node` and `cid`, computed by `keccak256(bytes(cid))`. Keep the string in event
  data so consumers can both search for a known CID and discover unknown CIDs.
  This replaces the old two-topic event with `Log(address,bytes32,string)`.
- 2026-09-05 / Codex: Return the additional topic as readonly
  `LoggerEvent.cidKeccak256Hash`, validating its 32-byte shape and preserving
  casing. The decoder reports the supplied hash without recomputing it; the
  contract guarantees the correspondence. Hosts supply Keccak-256 when building
  lookup filters. No runtime hashing dependency or new query API is needed.

## Outcomes & Retrospective

Both helpers are implemented in `packages/ethereum/src/logger.ts` and exported
through the package root. Encoding matches independently generated ABI vectors;
decoding filters unrelated logs and validates matching events before returning
their node, CID Keccak-256 hash, CID, and optional removed flag. Shared byte validation is imported
from the utils package root. No new dependencies were added.

Validation passed: the package build, 52 Ethereum runtime tests (11 new Logger
tests), TypeScript consumer checks, package-name import checks, all eight Logger
contract tests including 256 fuzz cases, and diff whitespace checks. Everything
ran inside the sandbox without live RPC, keys, or deployment. Fixture generation
revealed that Foundry's CLI string parser drops trailing newlines; explicit UTF-8
byte fixtures now test exact text preservation, including newlines, BOM, and NUL.
Host publication/submission composition and confirmation policy remain separate
work as intended.

The CID index extension is complete. The new event is
`Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)`;
calldata and string event-data bytes are unchanged. The decoder requires three
topics, returns the hash, and filters the old signature as unrelated. All eight
contract tests (including 256 fuzz cases), 53 Ethereum tests, build/type/import
checks, and 11 regenerated Foundry fixtures passed. For the same 46-character
CID, `log` now costs 25,429 gas versus 24,905 before (+524). Runtime/initcode
sizes increased from 355/387 to 395/427 bytes. The deterministic snapshot was
refreshed; its test-level deltas also include the new event assertions.

## Context and Orientation

`contracts/src/Logger.sol` and `contracts/test/Logger.t.sol` define and test the
onchain interface. `packages/ethereum/src/receipt-utils.ts` validates receipt
logs using the shared byte validator in `packages/utils/src/validation-utils.ts`;
`packages/ethereum/src/index.ts` owns Ethereum public exports. Tests import the compiled
package, and `dist` JavaScript/declarations/maps are tracked in Git. Standard
Web `TextEncoder`/`TextDecoder` and `String.isWellFormed` are available in the
package's ECMAScript 2025 target. Runtime modules must not import Solidity
artifacts or legacy host code.

## Plan of Work

Reuse the existing byte validator, implement the pure encoding and decoding
functions, and export their types through the package root. Store independent
calldata and event-data fixtures generated by Foundry's `cast` in the package's
test fixtures. Verify successful round trips and strict rejection of truncated,
oversized, noncanonical, or invalid-text encodings. Add consumer type checks and
host examples showing receipt-status and removed-log checks. Finish with a build,
Ethereum runtime/type tests, root import, existing offline contract tests, and
diff review.

For the CID index extension, update `contracts/src/Logger.sol` and its existing
event assertions, including fuzzed inputs, to check three topics and the exact
Keccak-256 value. Update the Ethereum decoder, readonly result type, and type
fixtures. Regenerate each fixture's hash using `cast keccak <UTF-8 hex>` and the
new signature using `cast keccak 'Log(address,bytes32,string)'`. Add rejection
coverage for malformed hash topics, missing/extra topics, and old event filtering.
Document RPC filters, decoder hashing limits, and the event ABI change in both
package and contract READMEs. Keep `encodeLoggerCall` unchanged. Refresh the
deterministic contract gas snapshot and compare the same fixed-CID call benchmark.

## Concrete Steps

Run from the repository root:

    forge inspect --root contracts --offline Logger methodIdentifiers
    forge fmt --root contracts
    forge build --root contracts --offline --sizes
    forge inspect --root contracts --offline Logger abi
    cast keccak 'Log(address,bytes32,string)'
    cast calldata 'log(string)' 'bafy-test'
    cast abi-encode 'log(string)' 'bafy-test'
    cast abi-encode 'f(bytes)' '0x626166792d74657374'
    npm --prefix packages run build
    node --test packages/ethereum/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    forge test --root contracts --offline -vv
    forge test --root contracts --offline --gas-report --match-test test_LogsCallerAndExactCid -vv
    forge snapshot --root contracts --offline --no-match-test testFuzz_ --snap contracts/.gas-snapshot
    git diff --check

Smoke-import `encodeLoggerCall` and `decodeLoggerEvent` by package name
from a Node process with `packages/` as its working directory. Fixture inputs
are listed in `test/fixtures/logger-abi.json`. Encode each CID's exact UTF-8 bytes
as hex and pass them to `cast abi-encode 'f(bytes)'`. That output is event data;
prefix its bytes with `0x41304fac` for calldata. Get the topic from `cast keccak`
and encode the fixture node address with `cast abi-encode 'f(address)' <node>`.
Generate each fixture's `cidKeccak256Hash` with `cast keccak <UTF-8 hex>` to avoid
string parsing or newline normalization. Use the existing local Solidity 0.8.23,
Paris EVM, and 200 optimizer runs. No RPC, keys, or deployments are needed.

## Validation and Acceptance

The encoder must match independent fixture bytes for empty, ASCII, Unicode,
and word-boundary strings. The decoder must extract the indexed node and exact
CID and 32-byte `cidKeccak256Hash`, allow null-return filtering, preserve removed metadata, and reject invalid
addresses, topics, offsets, lengths, padding, UTF-8, and malformed input shapes.
Declared uint256 lengths must be checked against actual input before conversion
to Number or allocation. Existing receipt tests must still pass after validator
reuse; TypeScript checks must prove receipt logs can be passed directly.
Contract tests must establish that the topic equals Keccak-256 of the exact
emitted CID bytes, including empty, opaque, and fuzzed strings. The decoder must
require three topics and treat the old event signature as unrelated.

## Idempotence and Recovery

Builds, fixtures, and tests are reproducible and have no external effects. Keep
the change in the Logger contract, Ethereum package, and documentation; no signing, publication,
deployment, or network mutation is authorized or required. If checks fail, fix
the local implementation or fixture and rerun the affected checks.

## Artifacts and Notes

Offline inspection reports `log(string)` selector `0x41304fac`. Keccak of
`Log(address,bytes32,string)` is
`0xce2d845fcf02211a951a2153c1ddf64ec48ef6d54644ea188101f10018b871dc`.
The function arguments and event data both encode a single dynamic string:
one 32-byte offset word, one byte-length word, and UTF-8 bytes padded to 32 bytes.
The event's second topic is the caller address with twelve leading zero bytes.
The third topic is `keccak256(bytes(cid))`.
Reference: [Solidity ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html).

## Interfaces and Dependencies

    encodeLoggerCall(cid: string): string
    decodeLoggerEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null

`LoggerEventInput` selects `address`, `topics`, `data`, and optional `removed`
from `EthereumReceiptLog`. `LoggerEvent` contains readonly `node`, `cidKeccak256Hash`, `cid`, and
optional `removed`. The functions are synchronous and use only standard language
features and the existing utils dependency.
