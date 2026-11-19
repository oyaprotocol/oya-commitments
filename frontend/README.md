# Oya Commitments Frontend

Use a browser wallet to deploy a Safe and an Optimistic Governor module. After enabling the module, the browser flow asks you to add the burn address as an owner and remove your wallet, leaving the burn address as the sole owner if both steps succeed.

If you want to keep your wallet as the Safe owner for testing, use the [CLI deployment guide](../docs/deployment.md). The CLI keeps the deployer as the sole owner by default.

## Beta Disclaimer

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose.

## Prerequisites

- Node.js 24 (also used in CI)
- npm (the supported package manager for this frontend)

Use `npm ci` with the committed `package-lock.json`. The security overrides in
`package.json` and dependency validation below are maintained for npm; pnpm and
Yarn installs are not supported. In particular, pnpm 10 ignores npm's top-level
`overrides`, which can reintroduce vulnerable transitive dependencies even while
the npm lockfile regression test passes.

## Install & Run

```shell
npm ci
npm run dev
```

## Environment Variables

To prefill the Module Proxy Factory field, set `VITE_MODULE_PROXY_FACTORY` to the factory address for your network before running `npm run dev` or `npm run build`. For a local override, put it in `frontend/.env.local`.

All other Safe / Optimistic Governor defaults are currently hardcoded in `src/App.jsx` (mainnet defaults). If you want to make those configurable, update the defaults or wire in additional env keys.

## Build

```shell
npm run build
npm run preview
```

## Dependency validation

Run these commands from `frontend/` after changing dependencies:

```shell
npm ci
npm test
npm run build
npm audit --package-lock-only
```

CI installs with `npm ci --ignore-scripts` and checks wallet URI parsing, wallet message schemas, transaction-policy validation, the production build, and the dependency audit. No dependency patch or install script is required.

The security overrides in `package.json` have specific purposes:

- WalletConnect's `query-string` override uses 9.5.1 and its patched URI decoder while retaining the existing WalletConnect SDK. The parser is now ESM; Node.js 24 supports its use from the SDK's CommonJS entry point.
- Zod 4.6.6 fixes oversized collection validation and supports the legacy record-schema API used by Coinbase. ABIType 1.2.3 supports Zod 4. Tests exercise Coinbase's ESM and CommonJS policy validators with these overrides.
- The existing UUID and WebSocket overrides keep older transitive copies on patched releases.
- RainbowKit's `@vanilla-extract/css` override uses 1.21.3, whose upstream release replaces vulnerable `deepmerge` with `deepmerge-ts` (GHSA-gcqx-w48m-w2h4). This removes the affected package rather than downgrading RainbowKit or suppressing the audit. Remove the override once RainbowKit requests a release that no longer depends on `deepmerge`, then repeat these checks.

The lockfile also updates Coinbase CDP SDK to 1.60.0, removing the old Solana dependency chain containing `stream-json`. Keep the Zod and ABIType overrides until all consumers request compatible patched versions. Remove the URI-parser override when the supported wallet SDK no longer brings in a vulnerable decoder, then repeat these checks.

## What It Does

- Collects Safe + Optimistic Governor parameters (rules, collateral, bond, liveness, addresses).
- Deploys a Safe proxy and an Optimistic Governor module.
- Enables the module on the Safe.

If you need the CLI-based flow instead, use the Foundry scripts in `script/` from the repo root.
