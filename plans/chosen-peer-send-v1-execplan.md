# Send one ordinary job to a chosen registered node

Feature ID: `chosen-peer-send-v1`. This living ExecPlan follows `PLANS.md`.

## Purpose / Big Picture

An operator selects a node by its Ethereum address from an installed, reviewed registry and sends a text file with one command. Automation imports the same function. Before sending, the helper saves the exact ordinary version-1 signed job and destination. Later status and explicit retry use only that saved file, without a key or registry lookup. Acceptance is demonstrated against a loopback inbox with real signatures, not a live service.

## Progress

- [x] 2026-11-15 22:34Z: Read repository guidance, inbox protocol/transport, registry reception and broader operator plan. Established base `5179b7f046e2a4c2d49579431485bb1470fc7a1b`.
- [x] 2026-11-15 22:38Z: Implemented importable sender and thin CLI with durable preparation and pinned recovery.
- [x] 2026-11-15 22:43Z: Added 17 failure-path and real CLI-to-inbox acceptance tests; passed on host and isolated image.
- [x] 2026-11-15 22:44Z: Packaged and documented the helper. Focused checks and all 469 production tests passed. Reviewed the complete change.
- [x] 2026-11-15: Independent review found no blockers and reran 54 focused tests. Full production suite independently rerun: 469 passed, zero failures or skips.
- [x] 2026-11-17: Verified publication as PR #179 at `71e64af`, its source label, and all seven original-head CI checks.
- [x] 2026-11-17: Integrated upstream `7da47ea` and reconciled the upgrade allowlist, retaining both the sender guide and gas-policy assets. All 571 production tests passed with a canonical private temporary directory.
- [ ] Resolve the sender-identity choice raised by [review comment 4593032328](https://github.com/oyaprotocol/oya-commitments/pull/179#discussion_r4593032328), then simplify the command to recipient and text file. Existing sender credentials and node gas-paying credentials have separate roles. The proposed operator-profile resolver is not implemented.

## Surprises & Discoveries

The existing transport already bounds responses and deadlines and refuses redirects. Registry loading currently establishes membership only, so the sender must validate selected routing separately. The release bundle and Python upgrader both have explicit guide allowlists. The broader `plans/node-operator-experience-execplan.md` proposes profile-aware sending in milestone 3; this small reusable helper provides a foundation without implementing that framework.

The first image build with `--network=none` failed during the existing npm dependency layer (`EAI_AGAIN`); rebuilding without that build-time restriction succeeded using cached layers. All image execution tests then ran with `--network none` and loopback-only fixtures. Review also found that URL parsing accepts an empty userinfo marker (`https://@...`); explicit routing validation now rejects it, with a regression case.

## Decision Log

- 2026-11-17 / Oya Gardener: Preserve the union of release allowlist entries when merging upstream. Defer automatic sender-key selection until the reviewer clarifies whether sending uses a dedicated sender identity or the installed node identity. `send-message.mjs` uses `OYA_AGENT_PRIVATE_KEY`, while local node settings use `OYA_NODE_PRIVATE_KEY` and the current Keychain helper retrieves worker tokens. These are not interchangeable defaults.

- 2026-11-15 / Oya Gardener: Follow [pemulis's PR173 request](https://github.com/oyaprotocol/oya-commitments/pull/173#issuecomment-6902056112) requesting a simple chosen-node CLI and reusable sending function. Use existing `signJob`, `validateJob` and `createInboxClient`, with unchanged independent inner signature and 24-hour default. No receiver-specific protocol.
- 2026-11-15 / Oya Gardener: Save a versioned local wrapper containing destination metadata and the exact v1 job, exclusively with mode 0600, syncing file and parent before HTTP. Metadata is routing input, not signed identity evidence. Retry/status never consult a newer registry.
- 2026-11-15 / Oya Gardener: Use an explicit registry path, address, key file, text file and fresh output file. No inferred destination, implicit fetch, scheduler, automatic retry or replacement request. Only HTTPS off-host; permit HTTP loopback for acceptance.

## Outcomes & Retrospective

The upstream integration preserves both release bundles' required files. The full production suite passed 571 tests after setting `TMPDIR` to a canonical private directory. An initial run hit macOS `/var` symlink traversal in the gas-policy permission test. No test or permission restriction was weakened. The two-argument workflow remains pending the sender-identity decision. Removing path arguments should hide setup mechanics, not silently select a different signing authority.

The CLI and importable API work end to end against the ordinary inbox HTTP handler with real signatures and an in-memory store. Restarted CLI processes recover the original request after key/registry removal. Lost acknowledgement, stalled headers/body, redirects, malformed responses, forged signatures, bounded short reads, partial writes and both file/directory sync failure have regressions. The guide ships in release bundles and passes the strict upgrade verifier. No new dependencies or protocol changes were needed.

Validation completed with host Node v26.12.1 and container Node v24.21.0. This demonstrates admission/recovery, not PostgreSQL durability, IPFS availability or onchain logging. The local image is Linux arm64; this task did not validate a release amd64 image or publish assets. No real-peer sends, deployments or remote mutations occurred.

Next candidate: integrate this sender into the operator profile interface after its prerequisite migration is ready. The bounded candidate is detailed below.

## Context and Orientation

All implementation lives under `node/production`. `src/inbox/protocol.mjs` signs a message independently, then signs the job containing target (receiver's queue name), random request ID and expiry. `src/inbox/http.mjs` supplies client and server. `src/peers/config.mjs` supplies bounded regular-file reads. The registry is an array of `{nodeAddress,url,target}` records; `url` ends exactly in `/v1/jobs`. Authorization is still decided independently by receiver inbox and worker. A remote admission response is not proof of storage or a Ledger log.

## Plan of Work

First add `src/peers/send.mjs` for selection, preparation, persistence, submission and recovery, plus `src/peers/client.mjs` for positional CLI commands and sanitized JSON output. Validate all inputs before persistence or HTTP. Classify valid remote states separately from unknown delivery, HTTP failure and local invalid input.

Then add `test/peer-send.test.mjs` covering validation, durability, exact retries, expiry and sanitized failures. Run the actual CLI asynchronously against `createInboxServer` with an in-memory fixture store, real disposable signatures and loopback networking only. Finally add `peers/send.md`, link it from task guides, include modules in `.dockerignore`, and include the guide in release and upgrade allowlists and packaging assertions.

## Concrete Steps

From the repository root, install locked production dependencies if absent with `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund`. Run:

    node --test node/production/test/peer-send.test.mjs
    node --test node/production/test/inbox-client.test.mjs node/production/test/peer-receive.test.mjs node/production/test/publish-image.test.mjs
    npm --prefix node/production test
    node node/production/src/peers/client.mjs --help
    git diff --check

The commands above passed: sender 17/17; related client/reception/packaging 37/37; full production 469/469; CLI help and whitespace checks passed. For the successful image validation, run from the repository root:

    docker build --pull=false -t oya-chosen-peer-send-v1:local node/production
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node oya-chosen-peer-send-v1:local /app/src/peers/client.mjs --help
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
      --mount "type=bind,src=$PWD/node/production/test/peer-send.test.mjs,dst=/app/test/peer-send.test.mjs,readonly" \
      --entrypoint node oya-chosen-peer-send-v1:local --test /app/test/peer-send.test.mjs

The real image build and packaged CLI help passed. All 17 sender tests passed inside that image with networking disabled except container loopback. The timeout regression asserts the production 10-second setting while shortening its test timer to 100 milliseconds. Release tests use fake Docker and disposable local Git repositories; they must never invoke real publication.

## Validation and Acceptance

A new send must save an owner-only exact job before one POST; the fixture observes the file before admission. The real CLI returns queued admission, and a restarted CLI can query or retry with unchanged ID/signatures after key and registry removal. Invalid/duplicate/missing addresses, URL credentials/paths/query/fragment, malformed targets, bad signatures, invalid/oversized text or saved files, existing output and filesystem failure must cause no network effects. Test disconnect after admission, malformed/oversized replies, redirects, HTTP rejection and expired retry while status remains queryable. Output must omit text, signatures, keys, raw errors and response bodies. Full production tests and bundle assertions must pass, with image limitations stated honestly.

## Idempotence and Recovery

The output filename must be fresh. A write/sync failure leaves its artifact for inspection and sends nothing. Never overwrite a saved request. Status can inspect expired jobs; retry cannot extend expiry. After an uncertain send, retain the saved file and query status, then explicitly choose whether to retry the same job. Missing status does not prove non-publication. Signed jobs can be reused across authorized receivers sharing a target; no cross-node deduplication is promised. Protect local metadata from modification with a private parent directory.

## Artifacts and Notes

The measured implementation, tests, scripts and configuration change is 634 additions plus 3 deletions, or 637 code lines, below the 3,000-line budget. Documentation is measured separately. Validation uses disposable keys and saved requests outside the checkout. Deployment and real-peer/onchain sends require separate authorization.

## Next feature — candidate when capacity permits

Candidate ID: `operator-profile-peer-send-v1`. Reuse `sendToPeer` through the operator profile CLI described in `node-operator-experience-execplan.md`, reducing repeated path arguments while retaining an explicit recipient. Deliver a profile-to-sender adapter and saved-job retry/status commands in the planned operator interface. Acceptance requires the same ordinary signed job and pinned destination, protected output before HTTP, and recovery after credentials or registry inputs become unavailable.

Affected components are the planned operator CLI/profile loader, `src/peers/send.mjs`, and their tests and guides. Estimated budget is 600–1,200 added/deleted code lines. Dependencies are the broader plan's JavaScript migration/parity milestone and the reviewed sender API. Reassess ownership and readiness before selection. Tests should exercise role-aware profile validation, credential resolution, exact retries, rejected destination changes and unknown delivery. Preserve explicit send intent and saved evidence. The adapter must not imply that an endpoint response proves onchain logging.

## Interfaces and Dependencies

`sendToPeer({registryFile,nodeAddress,keyFile,textFile,outputFile}, {transport})` creates and submits once. `retryPeerJob(savedFile, {transport})` and `peerJobStatus(savedFile, {transport})` read the persisted destination/job only. The optional Fetch-compatible transport supports local deterministic tests. Public functions sanitize local validation failures and remote outcomes. CLI: `send REGISTRY_FILE NODE_ADDRESS KEY_FILE TEXT_FILE OUTPUT_FILE`, `retry SAVED_FILE`, `status SAVED_FILE`, `--help`. Exit 0 means recognized admission/state except failed/expired execution, 1 means remote/unknown/failed/expired outcome and 2 means local input/persistence failure. These commands require production dependencies (or the matching built image); no new dependencies are planned.
