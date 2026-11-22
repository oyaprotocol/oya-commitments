# Find candidate Ledger publications in a block range

## Purpose / Big Picture

A node catching up on other publishers needs a starting point even when nobody sends it a transaction hash. Query one block range and pass any candidate to the existing content verifier. This supports the historical retrieval goal in [Q024](../docs/gardener-dialogue.md#q024).

## Progress

- [x] 2026-11-21 18:35Z: Inspected the verifier settings, Ledger event signature and record format.
- [x] 2026-11-21 18:35Z: Added the bounded RPC query, operator instructions and local regression coverage.
- [x] 2026-11-21 18:43Z: Re-ran `node --test test/discover-ledger.test.mjs` (3/3 passed) and `npm test` (673/673 passed) from `node/production` on Node 24.22.3.

- [x] 2026-11-22: Added an operator-selected default verifier file for discovery. With a non-symlink temporary directory, `node --test test/discover-ledger.test.mjs` passed 4/4 and `npm test` passed 674/674 on Node 24.22.3.

## Surprises & Discoveries

Ledger permits arbitrary strings. Discovery can identify a log without promising the verifier can retrieve its content.

## Decision Log

- Decision: Return only the transaction hash and log index. Query explicit mined blocks and leave retries to the caller.
  Rationale: The two fields identify the verifier input without implying verified content. Fixed endpoints keep a retry from silently advancing its window. The caller can narrow a rejected range without losing track of which blocks remain unchecked.
  Date/Author: 2026-11-21 / Oya Gardener.

- Decision: Require an absolute operator-selected path for the discovery default. A positional override remains valid for standalone scripts.
  Rationale: Discovery can reuse private verifier settings without guessing a file from the launch directory or reading installation signing credentials.
  Date/Author: 2026-11-22 / Oya Gardener.

## Outcomes & Retrospective

Operators can now move from a block range to individual verification inputs. A dense block can exceed the response limit. Report the failure rather than silently truncating it.

## Context and Orientation

The Ledger contract emits a log, an event inside a transaction. Its log index distinguishes events in the same block. The existing `node/production/src/verify-ledger.mjs` already accepts a transaction hash and log index.

## Plan of Work

In `node/production/src/discover-ledger.mjs`, reuse the verifier’s settings and bounded transport. Check chain and head, filter the configured address and event signature, validate returned positions and emit sorted records. Package the entry point in the runtime image.

## Concrete Steps

From `node/production`, install with `npm ci` and run `node --test test/discover-ledger.test.mjs` and `npm test`. Follow the [operator guide](../node/production/inbox-api.md#find-ledger-records-to-verify) for CLI syntax.

## Validation and Acceptance

Loopback RPC tests check the exact filter, unordered inputs, empty results, range bounds, wrong chain, duplicate positions and malformed responses. No public RPC or credentials are needed.

## Idempotence and Recovery

Retry a smaller range on failure. Compare results only in the context of the same chain. Nothing is signed, submitted or stored. Reorganizations can change later reads.

## Artifacts and Notes

The runtime prints one JSON array only after validating all candidate locations. An empty array and a failing exit are distinct.

## Interfaces and Dependencies

The CLI accepts two decimal numbers. An explicit verifier settings file overrides the absolute path configured in `OYA_LEDGER_EVIDENCE_SETTINGS`. Only the configured Ethereum RPC receives requests. IPFS settings remain private and unused during discovery.

## Next feature — candidate when capacity permits

`offline-retained-content-check-v1`: let an operator check a retained file against a historical raw CID without fetching it again. Use the production verifier’s existing CID rules, stream the local file with a bound, and test correct, altered and unsupported inputs. Depend on a verified record and locally retained bytes. Report local byte identity, not continuous custody. Estimated code and tests: under 250 changed lines.
