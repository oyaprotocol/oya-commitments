# Offchain Agent

The agent in `agent/` can propose and execute transactions via the Optimistic Governor module. Customize the decision logic, signal monitoring, and overall behavior to match your commitment rules.

## Setup

```shell
cd agent
npm install
cp .env.example .env
npm start
```

Fill in at least:

- `RPC_URL`
- `PRIVATE_KEY`
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`

## Built-In Tools

- `postBondAndPropose`
- `makeDeposit`
- `pollCommitmentChanges`
