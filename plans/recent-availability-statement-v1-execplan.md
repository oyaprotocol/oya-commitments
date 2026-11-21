# Prepare a statement about a recent Ledger publication

## Purpose / Big Picture

An observing node can retrieve another node’s logged bytes and prepare a short first-person statement for review and signing. The statement names one observation rather than promising custody for a day.

## Progress

- [x] 2026-11-21 17:30Z: Compared existing Ledger verification and chosen-peer submission against the first-day retrieval request in PR #224.
- [x] 2026-11-21 17:35Z: Added the command, operator instructions, and positive and negative regression tests.

## Surprises & Discoveries

The verifier already returns the block timestamp and completion time. A verified independent digest can still leave the raw CID binding unchecked. The observation requires that binding explicitly.

## Decision Log

2026-11-21, Oya Gardener: Reuse the verifier and sender rather than add a new onchain method or message type. Accept completion times in the half-open first 24 hours. Use readable ASCII so operators can inspect the exact claim.

## Outcomes & Retrospective

The observer can now prepare shareable text in a single read-only operation. A synchronized local clock and the operator-selected endpoints are trusted. Publication, registration, and historical possession are distinct from observing a retrieval.

## Context and Orientation

`node/production/src/ledger-evidence.mjs` verifies the selected log against its block and retrieves bytes from Kubo (the IPFS service). The existing peer sender takes a text file. Neither a saved verification report nor a key is an input to this new command.

## Plan of Work

Add `src/observe-availability.mjs` in the production runtime. Read the existing verifier input files, run a fresh check and write public identifiers only on success. Include the module in the Docker context. Exercise the CLI against the existing loopback Ledger and Kubo fixture.

## Concrete Steps

From the repository root run `npm --prefix node/production ci --ignore-scripts` and `node --test node/production/test/ledger-evidence.test.mjs`. For manual use, see the command and input references in `node/production/README.md`.

## Validation and Acceptance

A matching recent raw CID yields a statement with chain, Ledger, block hash, transaction, log index, publisher, byte count and observation time. Corrupt or old data produces no statement. Cover both time boundaries and unsupported CID binding. Run `npm --prefix node/production test` on Node 24. On macOS use a non-symlinked temporary directory for the existing permission tests.

## Idempotence and Recovery

Each attempt reads fresh evidence. Redirect into a new file and check the exit code before using it. A later retry can fall outside the window.

## Artifacts and Notes

74 focused and 672 production tests passed using simulated services. No live chain, signing, or image publication is required for this check.

## Interfaces and Dependencies

The CLI takes the same record and settings files as `verify-ledger.mjs`. It relies on that module’s bounded receipt and content reads. The plain text is an operator statement rather than a protocol schema.

## Next feature — candidate when capacity permits

`recent-ledger-observation-discovery-v1`: let observers find records without already knowing a transaction hash. Add an explicitly bounded, read-only block-range lookup to the production evidence tools. Return exact transaction/log identities for the configured Ledger; test empty, multiple, wrong-emitter, removed-log, oversized and unavailable results against loopback RPC. Depend on existing Ledger event decoding, not on statement publication. Estimate 180–350 changed code/test lines. Do not treat a provider’s empty response as proof that nothing was published.
