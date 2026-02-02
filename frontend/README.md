# Oya Commitments Frontend

Lightweight web UI for configuring and deploying a commitment (Safe + Optimistic Governor module). It mirrors the Foundry deployment flow and helps craft the same onchain calls from a browser wallet.

## Beta Disclaimer

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose.

## Prerequisites

- Node.js 18+
- npm (or pnpm/yarn)

## Install & Run

```shell
npm install
npm run dev
```

## Environment Variables

The app reads env values directly or with `VITE_` / `NEXT_PUBLIC_` prefixes.

Supported today:

- `MODULE_PROXY_FACTORY` (optional; overrides the module proxy factory address)

All other Safe / Optimistic Governor defaults are currently hardcoded in `src/App.jsx` (mainnet defaults). If you want to make those configurable, update the defaults or wire in additional env keys.

## Build

```shell
npm run build
npm run preview
```

## What It Does

- Collects Safe + Optimistic Governor parameters (rules, collateral, bond, liveness, addresses).
- Deploys a Safe proxy and an Optimistic Governor module.
- Enables the module on the Safe.

If you need the CLI-based flow instead, use the Foundry scripts in `script/` from the repo root.
