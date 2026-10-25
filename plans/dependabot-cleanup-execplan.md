# Resolve dependency alerts before deployment

This ExecPlan follows `PLANS.md`. Dependency remediation and local validation are complete; deployment remains paused pending review and merge.

## Purpose / Big Picture

Resolve every open Dependabot alert in `oyaprotocol/oya-commitments` without breaking the frontend wallet/deployment flows or other applications. Review each affected dependency chain, install compatible patched releases, and verify the resulting lockfiles and application builds. GitHub closes alerts after the fixes reach the default branch and its dependency graph refreshes; do not dismiss alerts to hide unresolved packages.

## Progress

- [x] 2026-10-25: Read repository instructions and queried every open Dependabot alert. The working tree started clean on branch `10252026` at `4295bec`.
- [x] 2026-10-25: Located 29 open alerts, all in `frontend/package-lock.json`, covering seven packages. Identified two dependencies whose patched versions exceed their parents' current constraints.
- [x] 2026-10-25: Audited all five lockfiles. Four are clean; the frontend also contains the Zod advisory GHSA-mrhx-c7xc-m3w5, beyond the initial 29 GitHub alerts.
- [x] 2026-10-25: Patched compatible frontend dependencies and removed `stream-json` by updating Coinbase CDP SDK to 1.60.0. Selected `query-string` 9.5.1 with `decode-uri-component` 0.5.1 for the existing WalletConnect SDK.
- [x] 2026-10-25: Updated the frontend manifest/lockfile, documented maintenance, and added frontend validation to CI. Confirmed Zod 4.6.6 already supports Coinbase's record API, so no vendored patch or install script is needed.
- [x] 2026-10-25: A clean install with scripts disabled passed all 11 compatibility tests and the production build. All five lockfiles report zero audit vulnerabilities. An isolated headless Chrome check rendered the production page and opened the wallet picker with all default wallets and no uncaught browser errors; external page requests were blocked.
- [x] 2026-10-25: Re-fetched all 29 open GitHub alerts and checked every matching package version against each advisory's affected range. None remain vulnerable in the final lockfile. Reviewed repository changes and recorded remaining merge and deployment work.

## Surprises & Discoveries

The initial alerts are confined to the frontend, including packages brought in through wallet connectors. `jayson@4.3.0` requests `stream-json@^1.9.1`, while the alerts identify `3.6.0` as the patched release. `query-string@7.1.3` requests `decode-uri-component@^0.2.2`, while its advisory identifies `0.5.0`. A blanket forced audit update could break those consumers; inspect their upstream releases and actual imports before choosing a fix.

Both parser fixes change module/API compatibility. Coinbase's compatible parent update removes `stream-json`. RainbowKit supports Wagmi 2, whose current release still pins WalletConnect 2.21.1. A prototype with WalletConnect 2.26.0 removed its old parser, but that release changes the declared license from Apache-2.0 to `SEE LICENSE IN LICENSE.md`. The final implementation retains WalletConnect 2.21.1 and overrides its `query-string` dependency to 9.5.1, which uses patched `decode-uri-component` 0.5.1. Both WalletConnect and Reown's nested utility copies pass URI round-trip and malformed-percent-input tests. Node.js 24 supports loading the ESM parser through their CommonJS entry points.

Zod has no patched 3.x release. Its upstream collection-size fix is in the v4 implementation, so importing the bundled `zod/v3` compatibility entry would not remediate it. Coinbase CDP SDK 1.60.0 uses the legacy single-argument `z.record(valueSchema)` form. An initial compatibility-patch prototype proved unnecessary: Zod 4.6.6's `v4/classic/schemas.js` already handles that form with a string key schema. Both ESM and CommonJS typed-data validation tests pass without modifying Coinbase. No patch, vendored SDK code, postinstall hook, or patch tooling is included. Older ABIType 1.x copies move to 1.2.3, which declares Zod 4 support.

## Decision Log

- 2026-10-25 / User and Codex: Resolve dependency alerts before resuming deployment. Prefer maintained parent upgrades and compatible transitive updates, using narrowly scoped overrides only with compatibility evidence. Preserve application behavior and keep the existing node release immutable.
- 2026-10-25 / Codex: Use Zod 4.6.6 and runtime compatibility tests for its consumers. Discard the Coinbase patch prototype after checking the installed Zod implementation and testing the unmodified SDK. A clean install must pass with install scripts disabled.
- 2026-10-25 / Codex: Keep the existing WalletConnect SDK versions and apply a tested parser override, avoiding the newer WalletConnect license as part of a security maintenance change. Update all older ABIType 1.x copies to 1.2.3 for declared Zod 4 support. CI installs with scripts disabled, then runs compatibility tests, the frontend build, and an audit.

## Outcomes & Retrospective

The repository changes address all 29 open Dependabot alerts, plus the additional Zod advisory found by npm audit. Dependency changes are confined to the frontend. The final lockfile contains no versions in any of the 29 alerts' affected ranges, and all five dependency graphs audit clean. A clean install with scripts disabled passed all 11 tests and the production build. An isolated browser smoke check confirmed that the deployment page renders and its wallet picker opens without uncaught errors.

The new frontend CI job repeats the clean installation, compatibility tests, build, and audit. GitHub's alert status will update after these changes reach the default branch and the dependency graph refreshes; no alerts were dismissed. Review, commit, and merge this work before resuming deployment. Node runtime dependencies and existing release images are unchanged, so this cleanup alone does not require a new node image.

Validation used offline fixtures and blocked external browser requests; it did not perform authenticated wallet sessions or real-chain transactions. Vite still reports large wallet bundles and a browser externalization warning for an unused Node worker import in a transitive SDK. The production build and browser smoke check pass. Generated frontend output was removed from the working tree.

## Context and Orientation

Five independent npm dependency graphs have committed lockfiles: `frontend/`, `agent/`, `agent-library/`, `packages/`, and `node/production/`. `node/package.json` links the shared agent locally and has no committed lockfile. `packages/` is an npm workspace containing four production kernel libraries. The root Solidity project and separate `contracts/` project do not own these npm graphs.

The frontend is a Vite/React application using RainbowKit, Wagmi, and Viem. Wallet connectors bring additional SDKs and transitive dependencies. Its existing npm overrides constrain older `uuid` and `ws` versions. The existing frontend verification command is `npm --prefix frontend run build`; there is no frontend test script at the start of this task. Node.js 24 is the repository CI baseline.

## Plan of Work

First inventory GitHub alerts and audit each lockfile, retaining detailed audit output outside the checkout. Inspect dependency ancestry and advisory/upstream release information. Resolve compatible updates with npm so integrity fields remain registry-generated. For any required major dependency change, verify the calling package's API expectations and exercise the affected behavior before accepting it.

Next install the resulting dependency graphs reproducibly and run checks appropriate to the changes. At minimum build the frontend and exercise any transitive API changed outside its original semver range. If other application dependencies change, follow their local `AGENTS.md` and test the affected components. Avoid replacing unrelated dependency trees or altering production secrets.

Finally audit all lockfiles again and map every original alert to a patched version or removal. Record limitations explicitly if an upstream fix is unavailable. Review all intended source, lockfile, documentation, and plan changes before handing off. Leave deployment paused until the cleanup is reviewed and merged.

## Concrete Steps

From the repository root:

    gh api --paginate repos/oyaprotocol/oya-commitments/dependabot/alerts -f state=open -X GET
    npm --prefix frontend audit --package-lock-only --ignore-scripts --json
    npm --prefix agent audit --package-lock-only --ignore-scripts --json
    npm --prefix agent-library audit --package-lock-only --ignore-scripts --json
    npm --prefix packages audit --package-lock-only --ignore-scripts --json
    npm --prefix node/production audit --package-lock-only --ignore-scripts --json

Inspect versions/parents with registry metadata, lockfile entries, and `npm explain`. Use targeted npm updates or installs to regenerate registry integrity fields. Commands that fail from sandbox network restrictions must be retried through the normal approval mechanism.

The final validation sequence, matching CI, is:

    npm --prefix frontend ci --ignore-scripts
    npm --prefix frontend test
    npm --prefix frontend run build
    npm --prefix frontend audit --package-lock-only

Expect all 11 tests to pass, a successful production build, and zero audit vulnerabilities. The tests exercise unmodified CommonJS and ESM Coinbase schemas, its ABI validators, Reown wallet event schemas, both WalletConnect utility versions, and RainbowKit's default wallet factories without credentials or live transactions. `npm --prefix frontend ls abitype zod @coinbase/cdp-sdk query-string decode-uri-component --all` must finish successfully with the documented overrides and no invalid dependencies.

For a manual browser smoke check, run `npm --prefix frontend run preview -- --host 127.0.0.1`, open its printed local URL in an isolated browser profile, and confirm that the deployment page and Connect Wallet picker display. The completed automated smoke check performed the same actions against the production output in headless Chrome with external requests blocked. Actual wallet authorization and transaction submission are separate operator checks.

## Validation and Acceptance

Every initial alert must resolve to a non-vulnerable installed version or removal from the dependency graph. Fresh npm audit reports must include development dependencies. A clean installation must agree with the committed lockfile. The frontend build must pass, and wallet-facing APIs affected by major transitive updates must work. Existing production-node dependencies should remain unchanged unless an actual vulnerability requires modification. Do not claim GitHub alerts are closed before merge and GitHub re-evaluation.

## Idempotence and Recovery

Retain the current branch's unrelated work. Dependency installs may recreate ignored `node_modules` directories but must not read or rewrite operator secrets. Record the previous and patched versions in this plan. If a candidate update breaks compatibility, revise only this task's changes and choose a compatible parent or explicitly tested alternative. Never force-push, rewrite existing release tags, or suppress security alerts as a substitute for remediation.

## Artifacts and Notes

Initial alert inventory, 2026-10-25 (all paths are `frontend/package-lock.json`):

| Package | Initial version | Reported patched version | Final version | Alert numbers |
| --- | --- | --- | --- | --- |
| `vite` | 8.1.0 | 8.1.6 | 8.3.5 | 122–124, 127–128 |
| `axios` | 1.19.0 | 1.20.0 | 1.20.0 | 105–113, 115–117 |
| `follow-redirects` | 1.16.0 | 1.16.1 | 1.16.1 | 125–126 |
| `hono` | 4.13.2 | 4.13.11 | 4.13.14 | 102–104, 114, 121 |
| `source-map-js` | 1.2.1 | 1.2.2 | 1.2.2 | 120 |
| `stream-json` | 1.9.1 | 3.6.0 | Removed | 101, 118–119 |
| `decode-uri-component` | 0.2.2 | 0.5.0 | 0.5.1 | 100 |
| `zod` | 3.22.4, 3.25.76, 4.3.5 | 4.6.6 | 4.6.6 | Additional npm advisory |

The authenticated GitHub alerts API is the source of the 29-alert inventory. The additional Zod advisory is [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5); its upstream fix is [colinhacks/zod commit a0ebf97](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd). Final checks include development dependencies. All locked package downloads use npm registry URLs and SHA-512 integrity values.

## Interfaces and Dependencies

Use npm lockfile version 3 and the existing Node.js 24 environment. Preserve the frontend's public React, wallet connector, and contract-deployment behavior. No credentials, account changes, blockchain transactions, or external deployments are required to validate dependency fixes. Use disposable local fixtures if network-serving behavior needs a smoke test.
