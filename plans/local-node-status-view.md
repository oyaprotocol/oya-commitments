# Watch the selected node’s health locally

## Purpose / Big Picture

Open a page on the operator’s device and see whether the selected worker or direct node is healthy now. This delivers the node-status part of the maintainer’s request in #236, distinguished from speculative dashboards in #248.

## Progress

- [x] 2026-11-25 05:37Z: Traced the installed operator profile, validated status and bundle allowlist.
- [x] 2026-11-25 05:40Z: Implemented and packaged the page. The focused suite passed 22 tests and the full production suite passed 697 on Node 24.

## Surprises & Discoveries

`operatorStatus` already distinguishes failure to reach the endpoint from a node reporting that it stopped. Reusing this result preserves that distinction.

## Decision Log

2026-11-25 / Gardener: Use server-rendered HTML with timed reload. This needs neither a browser script nor another data API. Only the validated status projection belongs on the page. The checkout’s worker peer configuration is not a canonical GitHub network roster.

## Outcomes & Retrospective

The HTTP integration test saw the real worker health handler change from retrying to idle on the next refresh. Simultaneous page reads shared one health check. Release tests verified the bundle and its strict upgrade allowlist. Validation used local processes, not a deployed node.

## Context and Orientation

`node/production/scripts/operator-profile.mjs` selects public settings from a private operator profile. Its sibling `operator-status.mjs` reads `/healthz` and checks role, identity, state and worker freshness. These are host tools independent of Docker and runtime secrets.

## Plan of Work

Add a loopback-only viewer beside those scripts. Include it in release packaging and the upgrade helper’s allowed files. Document launch and shutdown in the status guide.

## Concrete Steps

From the repository root run `node node/production/scripts/operator-view.mjs --profile "$OYA_LOCAL_DIR/operator.json"`. Open the printed URL. A running node should show its status and the time of the check.

## Validation and Acceptance

Run `node --test node/production/test/operator-view.test.mjs node/production/test/publish-image.test.mjs`, then `npm --prefix node/production test`. Exercise state transitions with local health responses. Check that arbitrary health fields never reach the page and rejected requests never touch the node.

## Idempotence and Recovery

Ctrl-C stops the listener. Restart to load a different profile. Neither operation changes the node.

## Artifacts and Notes

The observed time is local, not a Ledger block timestamp. No test needs a live deployment or account.

## Interfaces and Dependencies

Node.js built-ins, the existing operator profile and its loopback health endpoint. No package additions.

## Next feature — candidate when capacity permits

Candidate ID: `operator-view-recent-ledger-logs-v1`.

Let a Ledger operator see which transactions emitted Ledger logs in a bounded recent block range. Reuse the existing discovery reader and show the range, block, transaction hash and log index. Label these as logs, not all interacting transactions. Test two logs in one transaction, an empty range, wrong chain, RPC timeout and IPFS-only mode against a local stub. Limit scope to the selected contract, read-only RPC and one bounded page; keep RPC configuration server-side. Estimate one focused session, under 500 changed code lines. Confirm the desired range before implementing. Leave network membership until a canonical registry source and schema are identified.
