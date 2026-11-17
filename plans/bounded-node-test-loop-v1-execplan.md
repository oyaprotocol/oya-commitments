# Run a finite chosen-node publication diagnostic

Feature ID: `bounded-node-test-loop-v1`. This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator explicitly runs `peer client test --execute RECIPIENT TEXT_FILE EVIDENCE_SETTINGS COUNT TIMEOUT_MS` using the existing installed node identity. Each iteration saves and submits one ordinary signed job, polls its status, independently retrieves the original signed message and verifies the expected recipient's Ledger event. Only verified completion permits another iteration. A finite JSON report separates receiver claims from independent provider-snapshot evidence.

The original candidate in `plans/batch-evidence-v1-execplan.md` proposes a bounded test loop to expose publication, logging and retrieval failures. Chosen-peer sending has converged at the assigned base. This slice composes that sender and existing evidence settings, rather than the broader operator profile/status feature owned separately. No profile, protocol, scheduler, funding, deployment or credential migration is included.

## Progress

- [x] 2026-11-17: Read repository guidance, complete predecessor plans, sender, inbox, evidence and publication serialization paths. Installed locked dependencies.
- [x] 2026-11-17 03:07Z: Implemented the bounded CLI/coordinator, cancellation, opt-in status evidence, unique expected-event selection and repeated-event rejection.
- [x] 2026-11-17 03:07Z: Added 51 permanent diagnostic tests including actual CLI processes, genuine message publication serialization, limits, interruption and failure paths.
- [x] 2026-11-17 03:07Z: Full production passed 633/633. Built Linux arm64 image and passed 51/51 diagnostic tests through its packaged CLI. Extended existing Docker acceptance passed against real PostgreSQL, Kubo, HTTPS and disposable Anvil. Reviewed the diff; code/test/script/config budget is 684 added/deleted lines.
- [x] 2026-11-17 03:21Z: Fixed independent P2 review: propagate the coordinator's synchronous monotonic check to both signing calls and the final transport invocation. Added nine permanent boundary regressions. Independent probes pass 2/2, focused tests 156/156, full production 642/642, rebuilt-image diagnostic tests 60/60, and actual Docker inbox/EVM integration 1/1.

## Surprises & Discoveries

Independent adversarial probes exposed two gaps despite the original passing suite: a deadline during local reads still produced two signatures, and a synchronous stall after persistence invoked transport before the abort timer could run. An abort timer is not a synchronous deadline gate. The fix checks elapsed monotonic time immediately before each signature and at the transport wrapper after request serialization. Nine permanent tests exercise asynchronous deadline, timer starvation and explicit cancellation at local reads, between signatures and after durable persistence; they count actual signatures and transport invocations and verify retained recovery files.

Publication serializes exactly `text`, `signer`, `signature` in that order. PostgreSQL JSON field order is not authoritative. Expected content digest must use the publisher's fixed order, not arbitrary saved-object order. The original generic verifier required an explicit log index; ordinary inbox status supplies only CID and transaction hash. The bounded expectation-based selector avoids a second receipt fetch. The first test fixture omitted required IPFS retry/time settings, producing HTTP 503 instead of reaching its hooks; supplying the production kernel settings fixed the fixture. Later tests assert successful admission before checking failure behavior.

## Decision Log

- 2026-11-17 / Hermes: Keep the synchronous check optional in sender options and adapt the wallet's signing method locally, preserving ordinary sender and protocol compatibility. Wrap the actual transport rather than only the outer request call so request construction cannot cross the deadline unnoticed. After persistence, return the sanitized unknown-delivery result with the original saved path, permitting the coordinator to retain evidence before reporting cancellation/deadline.
- 2026-11-17 / Hermes: Add unique log selection to the existing verifier only when CID, expected node and expected content digest are supplied. Reuse its bounded receipt parsing, block identity and byte checks instead of fetching receipts twice.
- 2026-11-17 / Hermes: Require explicit execution intent, count and total deadline. Preserve all outbox files, stop after any unknown/failure, and never retry submission. Thread cancellation through existing transport and evidence. Keep the current status command projection compatible unless evidence is explicitly requested by the loop.

## Outcomes & Retrospective

The operator can run the explicit finite diagnostic and recover every original job after uncertainty. After the independent-review fix, all 642 production tests pass with no failures, skips or cancellations, including release packaging/upgrade checks and ordinary sender compatibility. All 60 diagnostic tests also pass in the rebuilt read-only, externally network-isolated Node 24 image. The extended Docker integration passed again after the sender change: it runs the actual host CLI as an installed synthetic sender through packaged inbox/worker, real PostgreSQL, offline Kubo and locally deployed Ledger on Anvil, verifying two exact messages and distinct recipient events. These EVM results are separate from controlled-RPC unit tests. The review lesson is to assert side-effect counts at every asynchronous boundary, not just the final deadline report. No live services or funded-chain calls were made.

## Context and Orientation

All runtime changes live under `node/production`. `src/peers/send.mjs` signs ordinary version-1 jobs and durably saves them in the selected installation's private `peer-outbox` before sending. `src/peers/client.mjs` is the CLI. `src/inbox/http.mjs` bounds responses and rejects redirects. `src/ledger-evidence.mjs` checks a configured chain, Ledger contract, receipt and block, retrieves bytes through the configured IPFS endpoint and checks their digest. A CID is a content identifier, not a storage promise. A Ledger event attributes publication to its immediate caller. Evidence is one provider snapshot, not finality.

## Plan of Work

First add cancellation and opt-in validated evidence identifiers to the sender. Extend generic evidence with cancellation and unique expected-event selection. Add `src/peers/test-loop.mjs` as the small sequential coordinator and dispatch the explicit CLI action. Then exercise real CLI processes against loopback inbox and controlled RPC/IPFS responses with genuine signatures. Extend disposable existing inbox Docker acceptance for real Anvil, Kubo and PostgreSQL when available. Include the module in the image allowlist and document the command in the existing shipped send guide.

## Concrete Steps

From repository root, install `npm ci --prefix node/production --ignore-scripts --no-audit --no-fund`. Set `TMPDIR` to an existing canonical private scratch directory. Run:

    node --test node/production/test/peer-test-loop.test.mjs node/production/test/ledger-evidence.test.mjs node/production/test/peer-send*.test.mjs
    npm --prefix node/production test
    docker build --pull=false -t oya-bounded-node-test:local node/production
    docker run --rm --network none --read-only --entrypoint node oya-bounded-node-test:local /app/src/peers/client.mjs --help
    npm --prefix node/production run test:inbox:docker
    git diff --check
    git diff --numstat

Image acceptance also mounts the new test file read-only and runs it with a writable disposable tmpfs, network disabled except container loopback. Run from repository root:

    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
      --mount "type=bind,src=$PWD/node/production/test/peer-test-loop.test.mjs,dst=/app/test/peer-test-loop.test.mjs,readonly" \
      --entrypoint node oya-bounded-node-test:local --test /app/test/peer-test-loop.test.mjs

Integration requires Docker and a prebuilt local Ledger artifact, with synthetic identities only. Keep all logs outside Git. Compile the existing Ledger artifact first with `forge build --root contracts`; initialize only `lib/forge-std` if needed. This acceptance used the fixture-pinned Foundry Docker image because host Foundry was absent. No Solidity source changed.

## Validation and Acceptance

Prove sequential finite success, exact original signed content, unique matching event among unrelated logs, expected chain/contract/node/CID identity, and recovery files before POST. Exercise wrong content (including another valid signed message), wrong identifiers, missing/ambiguous/removed logs, malformed/oversized remote replies, body/header deadlines, unavailable evidence, failed/expired/published jobs, lost acknowledgement without resubmission, poll/count/time limits, cancellation and secret redaction. Invalid settings and missing execution intent must send nothing. A real CLI process and actual packaged entrypoint must run. Controlled RPC tests must not be described as EVM execution. Full production tests and code/test/script/config changes below 3,000 cumulative added/deleted lines are acceptance gates.

## Idempotence and Recovery

Matching evidence does not cryptographically bind the outer job request ID to an event. The message signature contains only the text; repeated text can match historical evidence. The command rejects a reused transaction/log pair within a run. Use fresh diagnostic text for a new run. It makes no causal freshness, finality or named-peer-storage claim.

Each explicit run creates new requests and may cause public publication and receiver gas expenditure. It is not safe to rerun as recovery. Keep every saved file, including partial persistence failures. Query the existing `status SAVED_FILE` command after uncertainty. This loop never calls retry, removes files or replaces jobs. Cancellation stops local observation, not work already admitted remotely. If killed before reporting, inspect the private outbox. Rollback removes the command but retains all recovery data.

## Artifacts and Notes

Host validation used Node 26.12.1, canonical private `TMPDIR` and locked production dependencies. The image uses the pinned Node 24 runtime on Linux arm64; amd64 and released images were not tested. Post-review full production: 642 passed. Focused sender/evidence/diagnostic: 156 passed. Rebuilt-image diagnostic: 60 passed. Both independent probes now pass: local-read deadline produces zero signatures/jobs/sends; post-persistence event-loop starvation produces zero transport calls. Existing Docker inbox integration with the added diagnostic: 1 top-level integration passed again, including real Anvil execution, Kubo retrieval and PostgreSQL retention. The complete cumulative feature diff against the assigned base is 753 additions plus 18 deletions for code/test/script/config (771 lines), or 876 additions plus 18 deletions including all documentation and this plan (894 lines), below the 3,000-line budget. Independent final review confirmed the deadline fix and reran all 156 focused tests. A separate full-suite rerun passed all 642 tests. Human review and merge remain.

## Interfaces and Dependencies

`testNode({nodeAddress,textFile,settings,count,timeoutMs,execute}, {env,signal,transport})` returns a bounded summary. Optional poll limits are validated for import callers. CLI settings use the existing Ledger evidence shape: `chainId`, `ledgerContract`, `rpcUrl`, `ipfsUrl`, optional endpoint authorization, `timeoutMs`, `requestTimeoutMs`. Read only this explicit file and the selected installation. Never follow remote URLs. Count is 1–20 and total timeout 1–600000 milliseconds. Polling defaults to one second and at most 120 observations per job. Existing ten-second inbox timeout and 128 KiB response cap remain. No dependencies are added.

## Next feature — candidate when capacity permits

Candidate ID: `operator-balance-snapshot-v1`. Value: let an operator inspect a selected node's gas balance without loading its signer. Acceptance: resolve public identity through the converged operator profile, check approved RPC chain identity, report exact wei and timestamp, and report unknown on timeout or malformed responses. Components: existing profile/dispatcher adapter, small read-only balance module, tests and operator guide. Estimated size: 600–1,000 added/deleted code/test lines. Dependencies: convergence and ownership review of the separate operator profile/status feature and an explicit RPC authorization reference. Security: no key loading, funding, transaction creation or automatic endpoint fallback. Tests include wrong chain, numeric precision, unavailable RPC, bounded bytes/time and redaction.
