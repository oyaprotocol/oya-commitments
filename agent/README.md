# Commitment Agent Scaffold

Generic offchain agent wiring for monitoring a commitment and acting through the Optimistic Governor. It exposes only the core tools needed to serve commitments; add commitment-specific logic, prompts, and extra tools as needed.

## Prerequisites

- Node.js 18+
- RPC endpoint the agent can reach
- Private key funded for gas and permissions to propose through the Optimistic Governor

## Configure

1. Copy `.env.example` to `.env` and fill in:
   - `RPC_URL`: RPC the agent should use
   - `PRIVATE_KEY`: agent signer (never commit this)
   - `COMMITMENT_SAFE`: Safe address holding assets
   - `OG_MODULE`: Optimistic Governor module address
   - `WATCH_ASSETS`: Comma-separated ERC20s to monitor (the OG collateral is auto-added)
   - Optional tuning: `POLL_INTERVAL_MS`, `START_BLOCK`, `WATCH_NATIVE_BALANCE`, `DEFAULT_DEPOSIT_*`
   - Optional LLM: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1-mini`), `OPENAI_BASE_URL`
2. Install deps and start the loop:

```bash
npm install
npm start
```

## What the Agent Does

- **Polls for deposits**: Checks ERC20 `Transfer` logs into the commitment and (optionally) native balance increases. If nothing changed, no LLM/decision code runs.
- **Bonds + proposes**: `postBondAndPropose` approves the OG collateral bond and calls `proposeTransactions` on the module.
- **Deposits**: `makeDeposit` can send ERC20 or native assets into the commitment.
- **Optional LLM decisions**: If `OPENAI_API_KEY` is set, `decideOnSignals` will call the OpenAI Responses API with signals and OG context and expect strict-JSON actions (propose/deposit/ignore). Wire your own validation/broadcast of any suggested actions.

All other behavior is intentionally left out. Implement your own `decideOnSignals` in `src/index.js` to add commitment-specific logic and tool use.
