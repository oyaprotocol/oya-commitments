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
   - Optional tuning: `POLL_INTERVAL_MS`, `START_BLOCK`, `WATCH_NATIVE_BALANCE`, `DEFAULT_DEPOSIT_*`, `AGENT_MODULE`, `UNISWAP_V3_FACTORY`, `UNISWAP_V3_QUOTER`, `UNISWAP_V3_FEE_TIERS`, `POLYMARKET_*`
   - Optional proposals: `PROPOSE_ENABLED` (default true), `ALLOW_PROPOSE_ON_SIMULATION_FAIL` (default false)
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
- **Timelock triggers**: Parses plain language timelocks in rules (absolute dates or “X minutes after deposit”) and emits `timelock` signals when due.
- **Price triggers**: If a module exports `getPriceTriggers({ commitmentText, config })`, the runner evaluates those parsed/inferred Uniswap V3 thresholds and emits `priceTrigger` signals.

All other behavior is intentionally left out. Implement your own agent in `agent-library/agents/<name>/agent.js` to add commitment-specific logic and tool use.

### Price Trigger Config

Export `getPriceTriggers({ commitmentText, config })` from `agent-library/agents/<name>/agent.js` when your agent needs price-trigger behavior. This keeps commitment interpretation local to the module.

### Uniswap Swap Action in `build_og_transactions`

`build_og_transactions` supports action kind `uniswap_v3_exact_input_single`, which expands to:
1. ERC20 `approve(tokenIn -> router, amountInWei)`
2. Router `exactInputSingle(...)`

This lets agents propose reusable Uniswap swap calldata without embedding raw ABI in prompts.

### Polymarket Support (CLOB + CTF)

The shared tooling supports:
- Onchain Conditional Tokens Framework (CTF) actions through `build_og_transactions`.
- Offchain CLOB order placement/cancel through signed API requests.
- Direct ERC1155 deposits to the commitment Safe.

#### Polymarket Environment Variables

Set these when using Polymarket functionality:
- `POLYMARKET_CONDITIONAL_TOKENS`: Optional CTF contract address override used by CTF actions (default is Polymarket mainnet ConditionalTokens).
- `POLYMARKET_CLOB_ENABLED`: Enable CLOB tools (`true`/`false`, default `false`).
- `POLYMARKET_CLOB_HOST`: CLOB API host (default `https://clob.polymarket.com`).
- `POLYMARKET_CLOB_ADDRESS`: Optional address used as `POLY_ADDRESS` for CLOB auth (for proxy/funder setups). Defaults to runtime signer address.
- `POLYMARKET_CLOB_API_KEY`, `POLYMARKET_CLOB_API_SECRET`, `POLYMARKET_CLOB_API_PASSPHRASE`: Required for authenticated CLOB calls.
- `POLYMARKET_CLOB_REQUEST_TIMEOUT_MS`, `POLYMARKET_CLOB_MAX_RETRIES`, `POLYMARKET_CLOB_RETRY_DELAY_MS`: Optional request tuning.

#### Execution Modes

- `PROPOSE_ENABLED=true` and/or `DISPUTE_ENABLED=true`: onchain tools are enabled (`build_og_transactions`, `make_deposit`, `make_erc1155_deposit`, propose/dispute tools).
- `PROPOSE_ENABLED=false` and `DISPUTE_ENABLED=false`: onchain tools are disabled.
- `POLYMARKET_CLOB_ENABLED=true`: CLOB tools can still run in this mode (`polymarket_clob_place_order`, `polymarket_clob_cancel_orders`).
- All three disabled (`PROPOSE_ENABLED=false`, `DISPUTE_ENABLED=false`, `POLYMARKET_CLOB_ENABLED=false`): monitor/opinion only.

#### CTF Actions (`build_og_transactions`)

Supported kinds:
- `ctf_split`
- `ctf_merge`
- `ctf_redeem`

Example `ctf_split` action:

```json
{
  "name": "build_og_transactions",
  "arguments": {
    "actions": [
      {
        "kind": "ctf_split",
        "collateralToken": "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "conditionId": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "partition": [1, 2],
        "amount": "1000000"
      }
    ]
  }
}
```

`ctf_split` auto-inserts ERC20 approvals to the CTF contract (`approve(0)`, then `approve(amount)`) before `splitPosition(...)`.

#### ERC1155 Deposit to Safe

Use `make_erc1155_deposit` after receiving YES/NO position tokens:

```json
{
  "name": "make_erc1155_deposit",
  "arguments": {
    "token": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    "tokenId": "123456789",
    "amount": "1",
    "data": "0x"
  }
}
```

#### CLOB Place/Cancel Tools

`polymarket_clob_place_order` submits a pre-signed order:

```json
{
  "name": "polymarket_clob_place_order",
  "arguments": {
    "side": "BUY",
    "tokenId": "123456789",
    "orderType": "GTC",
    "signedOrder": {
      "maker": "0xYourSignerOrClobAddress",
      "tokenId": "123456789",
      "side": "BUY"
    }
  }
}
```

`polymarket_clob_cancel_orders` supports `ids`, `market`, or `all`:

```json
{
  "name": "polymarket_clob_cancel_orders",
  "arguments": {
    "mode": "ids",
    "orderIds": ["order-id-1"]
  }
}
```

#### CLOB Identity Validation Rules

For `polymarket_clob_place_order`, the runner validates the same order payload that will be sent to `/order`:
- The submitted order must include `side` and `tokenId`/`asset_id` that match declared tool args.
- The submitted order must include at least one identity field: `maker`/`signer`/`funder`/`user` (or corresponding `*Address` variants).
- Every extracted identity address must be allowlisted:
  - runtime signer address, and
  - `POLYMARKET_CLOB_ADDRESS` when set.

If any identity is outside that allowlist, the tool call is rejected before submission.

#### CLOB Retry Behavior

- `POST /order` is not automatically retried.
- Cancel endpoints (and other retry-eligible requests) can use configured retry settings.

### Propose vs Dispute Modes

Set `PROPOSE_ENABLED` and `DISPUTE_ENABLED` to control behavior:
- Both true: propose and dispute as needed (default).
- Only `PROPOSE_ENABLED=true`: propose only, never dispute.
- Only `DISPUTE_ENABLED=true`: dispute only, never propose.
- Both false: monitor and log opinions only; no on-chain actions.

### Agent Modules & Commitments

Use `AGENT_MODULE` to point to an agent implementation name (e.g., `default`, `timelock-withdraw`). The runner will load `agent-library/agents/<name>/agent.js`.
Each agent directory must include a `commitment.txt` with the plain language commitment the agent is designed to serve.

You can validate a module quickly:

```bash
node agent/scripts/validate-agent.mjs --module=default
```

Default agent smoke test:

```bash
node agent-library/agents/default/test-default-agent.mjs
```

Update ERC-8004 metadata after registration:

```bash
AGENT_ID=1 AGENT_WALLET=0x... \
node agent/scripts/update-agent-metadata.mjs --agent=default
```

Register an agent on Sepolia (and update metadata in-place):

```bash
AGENT_MODULE=default \
AGENT_BRANCH=<branch> \
AGENT_NETWORK=ethereum-sepolia \
node agent/scripts/register-erc8004.mjs
```

The script infers `AGENT_URI` as:
`https://raw.githubusercontent.com/<org>/<repo>/<branch>/agent-library/agents/<agent>/agent.json`
Defaults: `AGENT_ORG=oyaprotocol`, `AGENT_REPO=oya-commitments`
Override with `AGENT_URI` or `AGENT_URI_BASE` if needed.

### Timelock Agent Testing

Unit test (plain JS):

```bash
node agent-library/agents/timelock-withdraw/test-timelock.mjs
```

Simulation (prints due triggers):

```bash
node agent-library/agents/timelock-withdraw/simulate-timelock.mjs
```

Run the timelock agent:

```bash
AGENT_MODULE=timelock-withdraw \
node agent/src/index.js
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
