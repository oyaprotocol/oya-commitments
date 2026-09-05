# Add Logger call and event helpers

This ExecPlan follows `PLANS.md` and implements the next small Logger integration
step after Ethereum receipt handling.

## Purpose / Big Picture

A host can prepare calldata for the deployed Logger and interpret its receipt
events through `@oyaprotocol/ethereum`. The existing contract exposes
`log(string)` and emits `Log(address indexed node, string cid)`. Calldata is the
hex-encoded function selector and arguments carried by an Ethereum transaction;
an event contains indexed values in topics and other values in its data bytes.

## Progress

- [x] 2026-09-04: Reviewed the contract, package guidance, byte validators, receipt types, and Solidity ABI specification. Verified selector and event topic using offline Foundry commands.
- [x] 2026-09-04: Added and exported both helpers and their input/result types; reused the existing package-local byte validator.
- [x] 2026-09-04: Added 11 behavioral tests, 11 independent Foundry fixtures, and TypeScript consumer checks. Logger's eight existing contract tests passed, including 256 fuzz cases.
- [x] 2026-09-04: Documented host use and regenerated tracked output. Build, all 52 Ethereum tests, TypeScript consumer checks, package-name imports, all eight offline Logger contract tests, and diff checks passed inside the sandbox.

## Surprises & Discoveries

- Logger permits empty and arbitrary strings. Its codec must not trim or impose
  CID syntax policy. UTF-8 byte lengths, rather than JavaScript string lengths,
  determine ABI lengths. JavaScript strings with unpaired surrogates cannot be
  encoded losslessly; the encoder will reject them.
- Receipt parsing already supplies a strict, variable-size byte validator.
  Exporting `parseBytes` inside its module allows reuse without a new public API.
- Solidity strings can hold invalid UTF-8 bytes. The decoder returns JavaScript
  text and therefore rejects these bytes instead of replacing them silently.
- Foundry's CLI string coercion strips a trailing newline. The first fixture
  checks exposed that normalization. Generate exact string argument bytes using
  `cast abi-encode 'f(bytes)' <UTF-8 hex>` instead: ABI strings and bytes have the
  same layout. Prefix the independently compiled Logger selector for calldata.
  Ordinary string cases also match `cast calldata 'log(string)'` directly.

## Decision Log

- 2026-09-04 / Codex: Implement only `encodeLoggerLogCall` and
  `decodeLoggerLogEvent` in `packages/ethereum/src/logger.ts`. Fixed signatures
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

## Outcomes & Retrospective

Both helpers are implemented in `packages/ethereum/src/logger.ts` and exported
through the package root. Encoding matches independently generated ABI vectors;
decoding filters unrelated logs and validates matching events before returning
their node, CID, and optional removed flag. Shared byte validation is reused
without exposing it at the package root. No new dependencies were added.

Validation passed: the package build, 52 Ethereum runtime tests (11 new Logger
tests), TypeScript consumer checks, package-name import checks, all eight Logger
contract tests including 256 fuzz cases, and diff whitespace checks. Everything
ran inside the sandbox without live RPC, keys, or deployment. Fixture generation
revealed that Foundry's CLI string parser drops trailing newlines; explicit UTF-8
byte fixtures now test exact text preservation, including newlines, BOM, and NUL.
Host publication/submission composition and confirmation policy remain separate
work as intended.

## Context and Orientation

`contracts/src/Logger.sol` and `contracts/test/Logger.t.sol` define and test the
onchain interface. `packages/ethereum/src/receipt-utils.ts` validates receipt
logs and hex bytes; `src/index.ts` owns public exports. Tests import the compiled
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
diff review. Contract source and ABI remain unchanged.

## Concrete Steps

Run from the repository root:

    forge inspect --root contracts --offline Logger methodIdentifiers
    cast keccak 'Log(address,string)'
    cast calldata 'log(string)' 'bafy-test'
    cast abi-encode 'log(string)' 'bafy-test'
    cast abi-encode 'f(bytes)' '0x626166792d74657374'
    npm --prefix packages run build
    node --test packages/ethereum/test/*.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json
    forge test --root contracts --offline
    git diff --check

Smoke-import `encodeLoggerLogCall` and `decodeLoggerLogEvent` by package name
from a Node process with `packages/` as its working directory. Fixture inputs
are listed in `test/fixtures/logger-abi.json`. Encode each CID's exact UTF-8 bytes
as hex and pass them to `cast abi-encode 'f(bytes)'`. That output is event data;
prefix its bytes with `0x41304fac` for calldata. Get the topic from `cast keccak`
and encode the fixture node address with `cast abi-encode 'f(address)' <node>`.

## Validation and Acceptance

The encoder must match independent fixture bytes for empty, ASCII, Unicode,
and word-boundary strings. The decoder must extract the indexed node and exact
CID, allow null-return filtering, preserve removed metadata, and reject invalid
addresses, topics, offsets, lengths, padding, UTF-8, and malformed input shapes.
Declared uint256 lengths must be checked against actual input before conversion
to Number or allocation. Existing receipt tests must still pass after validator
reuse; TypeScript checks must prove receipt logs can be passed directly.

## Idempotence and Recovery

Builds, fixtures, and tests are reproducible and have no external effects. Keep
the change in the Ethereum package and documentation; no signing, publication,
deployment, or network mutation is authorized or required. If checks fail, fix
the local implementation or fixture and rerun the affected checks.

## Artifacts and Notes

Offline inspection reports `log(string)` selector `0x41304fac`. Keccak of
`Log(address,string)` is
`0x0738f4da267a110d810e6e89fc59e46be6de0c37b1d5cd559b267dc3688e74e0`.
The function arguments and event data both encode a single dynamic string:
one 32-byte offset word, one byte-length word, and UTF-8 bytes padded to 32 bytes.
The event's second topic is the caller address with twelve leading zero bytes.
Reference: [Solidity ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html).

## Interfaces and Dependencies

    encodeLoggerLogCall(cid: string): string
    decodeLoggerLogEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null

`LoggerEventInput` selects `address`, `topics`, `data`, and optional `removed`
from `EthereumReceiptLog`. `LoggerEvent` contains readonly `node`, `cid`, and
optional `removed`. The functions are synchronous and use only standard language
features and the existing utils dependency.
