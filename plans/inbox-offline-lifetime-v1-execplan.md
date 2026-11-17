# Keep new inbox jobs eligible for seven days

This bounded execution of [operator-experience milestone M4](node-operator-experience-execplan.md) follows [PLANS.md](../PLANS.md).

## Purpose / Big Picture

An operator prepares an ordinary signed inbox job while its worker is offline. The saved job displays a deadline exactly seven days after preparation by default. An optional `--expires-in SECONDS` selects a shorter lifetime. A worker returning after a day can still start eligible queued work, while processing transactions retain their original recovery path.

## Progress

- [x] 2026-11-17: Read current main, all tracked plans and all open PR scopes. Traced prepare, signing, admission, claim, recovery and retention.
- [x] 2026-11-17: All three new focused tests failed on the original one-day default/missing option before implementation.
- [x] 2026-11-17: Implemented shared lifetime constant and prepare option, preserving explicit signed deadlines.
- [x] 2026-11-17: Focused CLI/signature tests 3/3, actual image tests 3/3 and disposable PostgreSQL harness 14/14 passed.
- [x] 2026-11-17: Full production suite 557/557 passed. Independent review found no production defects. Clarified the terminal-status test name and reviewed the complete diff.

## Surprises & Discoveries

The server already permits a seven-day deadline. The gap is the one-day client default and lack of a shorter-lifetime CLI option. PR181 touches the same protocol file only to extract target-name validation. Its status/profile work is independent of lifetime selection.

The first full-suite run passed 556/557. An existing gas-policy permission test hit the host temporary-directory symlink outside its read allowlist. Re-running with the configured scratch directory explicitly selected by `TMPDIR` passed 557/557 without changing that test or its security checks. PostgreSQL tests simulate elapsed time separately in the host clock and database deadline; signed payload and transaction bytes remain intact.

## Decision Log

- 2026-11-17 / Oya Gardener: Reuse the ordinary v1 envelope and existing prepare command. This satisfies M4 without another sender, configuration profile or protocol. Existing `expiresAt` library callers retain their exact signed value.
- 2026-11-17 / Oya Gardener: Implement a separate bounded milestone document linked to the operator roadmap. Profile/status and sender ergonomics remain in their existing PRs.

## Outcomes & Retrospective

Delivered the existing prepare command with a seven-day default and optional shorter lifetime. Node.js 24.22.3 production tests passed 557/557, focused tests passed 3/3, and the real disposable PostgreSQL harness passed 14/14. The built runtime image (Node.js 24.21.0) passed the same three focused tests with networking disabled and a read-only root filesystem. Checkpoint-ack and broadcast-receipt recovery each kept one transaction across simulated expiry. Completion-ack coverage verifies terminal status and replay rejection after expiry. Independent review found no production defects. Human review and merge remain.

## Context and Orientation

Paths below are relative to `node/production/`. `src/inbox/protocol.mjs` signs the independently signed message and outer job envelope. Its absolute `expiresAt` is part of the signed authorization. `src/inbox/client.mjs prepare` writes that envelope exclusively before submission. `src/inbox/store.mjs` expires only queued work and retains terminal records until seven days after the signed deadline. Processing jobs and saved transaction bytes must continue reconciliation after expiry. A worker lease is a separate short-lived authorization to advance work.

## Plan of Work

Name the existing seven-day maximum in the protocol module and use it for the default deadline and server check. Extend the existing four-positional-argument prepare command with an optional trailing `--expires-in SECONDS`, accepting integer seconds from 1 through 604800. Validate it before opening the signing key. Keep existing output fields and exact saved-job retry semantics. Add focused fixed-clock and subprocess tests. Extend the disposable PostgreSQL harness to exercise deferred work, terminal retention and transaction recovery across expiry. Update operator guides where they describe the one-day default.

## Concrete Steps

From repository root with Node.js 24+ and Docker available:

    npm --prefix node/production ci --ignore-scripts --no-audit --no-fund
    node --test node/production/test/inbox-lifetime.test.mjs
    npm --prefix node/production test
    node --test node/production/scripts/test-inbox.mjs
    git diff --check

All credentials and transports in tests are synthetic. Docker runs a disposable PostgreSQL instance on loopback. No production services or funded chains are used.

## Validation and Acceptance

Fixed-clock tests assert exactly 604800000 milliseconds by default, explicit shorter deadlines, the maximum boundary, one millisecond over, expiry at the current time and tampered signatures. Actual CLI tests cover unchanged positional usage, minimum/maximum/shorter lifetime options, malformed/duplicate options before key reads, exclusive mode-0600 output and printed deadlines. PostgreSQL tests exercise eligibility after more than a day, queued expiry, authenticated status after expiry, rejection of replay after expiry/pruning, terminal retention around the seven-day cutoff and in-progress signed-transaction recovery. Full regression tests must pass. Record actual results, independent review and added/deleted code totals before publication.

## Idempotence and Recovery

Prepare refuses to overwrite a saved job. Retrying submission reuses the same envelope, request ID and absolute deadline. Expired jobs cannot be extended by editing the file; a newly signed job is a new authorization and can cause another publication/transaction. Tests clean up owned temporary files and containers. No database migration is required.

## Artifacts and Notes

Budget: 144 added and 9 deleted code/test/script lines, 153 total against the 3000-line ceiling. Overall diff: 226 additions and 15 deletions across 10 files. Source plan is operator-experience M4 on the selected main revision. The prior gas-policy slice is now merged. Profile dispatch remains dependent on PR181.

## Interfaces and Dependencies

`signJob(wallet, target, text, options)` retains explicit `expiresAt` and request ID support. The wire format and server's maximum remain v1 and seven days. Prepare adds only an optional trailing lifetime argument. No package dependency changes are required. Clock synchronization matters: a client clock ahead of the inbox can exceed the exact maximum. Operators can use a shorter lifetime rather than silently changing signed authorization.

## Next feature — candidate when capacity permits

ID: `operator-gas-policy-profile-v1`. Let an operator inspect configured gas caps using the same saved profile as status. Deliverable: compose the merged gas projection with the operator dispatcher once PR181 converges. Acceptance: exact parity with standalone output, bounded/sanitized profile/config loading, direct/worker/IPFS coverage and execution from the extracted release bundle. Affected components: operator dispatcher/profile, gas CLI/module, packaging tests and operator guide. Estimated 150–300 code/test lines. Dependency: PR181 on main. Security: no signer loading, network requests, configuration writes or claims about loaded runtime policy.
