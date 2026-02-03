# Oya Commitment Agent

Generic offchain agent wiring for monitoring an Oya commitment and acting through the Optimistic Governor. It exposes only the core tools needed to serve commitments; add commitment-specific logic, prompts, and extra tools as needed.

## Beta Disclaimer

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose.

## Prerequisites

- Node.js 18+
- RPC endpoint the agent can reach
- Private key funded for gas and bond currency to propose through the Optimistic Governor

## Configure

1. Copy `.env.example` to `.env` and fill in:
   - `RPC_URL`: RPC the agent should use
   - `COMMITMENT_SAFE`: Safe address holding assets
   - `OG_MODULE`: Optimistic Governor module address
   - `WATCH_ASSETS`: Comma-separated ERC20s to monitor (the OG collateral is auto-added)
   - Signer selection: `SIGNER_TYPE` (default `env`)
     - `env`: `PRIVATE_KEY`
     - `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
     - `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` (macOS Keychain or Linux Secret Service)
     - `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY` (default `private_key`)
     - `kms`/`vault-signer`/`rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (JSON-RPC signer that accepts `eth_sendTransaction`)
   - Optional tuning: `POLL_INTERVAL_MS`, `START_BLOCK`, `WATCH_NATIVE_BALANCE`, `DEFAULT_DEPOSIT_*`, `AGENT_MODULE`
   - Optional proposals: `PROPOSE_ENABLED` (default true)
   - Optional disputes: `DISPUTE_ENABLED` (default true), `DISPUTE_RETRY_MS` (default 60000)
   - Optional LLM: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1-mini`), `OPENAI_BASE_URL`
2. Install deps and start the loop:

```bash
npm install
npm start
```

## Alternative Signing Methods for Forge Scripts

You can reuse the agent’s signer helpers to inject a private key env var for Forge scripts without storing raw keys in `.env`.

```shell
# Private key from env
SIGNER_TYPE=env PRIVATE_KEY=0x... \
  node agent/with-signer.mjs --env DEPLOYER_PK -- \
  forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast

# Encrypted keystore
SIGNER_TYPE=keystore KEYSTORE_PATH=./keys/deployer.json KEYSTORE_PASSWORD=... \
  node agent/with-signer.mjs --env DEPLOYER_PK -- \
  forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast
```

For interactions, swap the env var (e.g., `PROPOSER_PK`, `EXECUTOR_PK`). For signing without exporting a key, use an RPC signer proxy (`SIGNER_RPC_URL`, `SIGNER_ADDRESS`) that supports `eth_sendTransaction`.

## What the Agent Does

- **Polls for deposits**: Checks ERC20 `Transfer` logs into the commitment and (optionally) native balance increases. If nothing changed, no LLM/decision code runs.
- **Bonds + proposes**: `postBondAndPropose` approves the OG collateral bond and calls `proposeTransactions` on the module.
- **Monitors proposals**: Watches for Optimistic Governor proposals and routes them to the LLM for rule checks.
- **Disputes assertions**: When the LLM flags a proposal as violating the rules, the agent posts the Oracle V3 bond and disputes the associated assertion. A human-readable rationale is logged locally.
- **Deposits**: `makeDeposit` can send ERC20 or native assets into the commitment.
- **Optional LLM decisions**: If `OPENAI_API_KEY` is set, the runner will call the OpenAI Responses API with signals and OG context and expect strict-JSON actions (propose/deposit/ignore). Wire your own validation/broadcast of any suggested actions in the agent module.

All other behavior is intentionally left out. Implement your own agent in `agent-library/agents/<name>/agent.js` to add commitment-specific logic and tool use.

### Propose vs Dispute Modes

Set `PROPOSE_ENABLED` and `DISPUTE_ENABLED` to control behavior:
- Both true: propose and dispute as needed (default).
- Only `PROPOSE_ENABLED=true`: propose only, never dispute.
- Only `DISPUTE_ENABLED=true`: dispute only, never propose.
- Both false: monitor and log opinions only; no on-chain actions.

### Agent Modules & Commitments

Use `AGENT_MODULE` to point to an agent implementation under `agent-library/agents/<name>/agent.js`.
Each agent directory must include a `commitment.txt` with the plain language commitment the agent is designed to serve.

You can validate a module quickly:

```bash
node agent/scripts/validate-agent.mjs --module=agent-library/agents/default/agent.js
```

## Local Dispute Simulation

Use this to validate the dispute path against local mock contracts.

```bash
# 1) Start anvil in another terminal
anvil

# 2) Build the Solidity artifacts (includes mock OO/OG/ERC20)
forge build

# 3) Run the no-dispute case (assertion remains undisputed)
RPC_URL=http://127.0.0.1:8545 \
PRIVATE_KEY=<anvil-private-key> \
node agent/scripts/simulate-dispute.mjs --case=no-dispute

# 4) Run the dispute case (assertion disputed, bond transferred)
RPC_URL=http://127.0.0.1:8545 \
PRIVATE_KEY=<anvil-private-key> \
node agent/scripts/simulate-dispute.mjs --case=dispute
```
