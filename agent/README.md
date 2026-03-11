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
   - `WATCH_ASSETS`: Comma-separated ERC20s to monitor when the selected agent does not override watchlists in `config.json` (the OG collateral is auto-added)
   - `WATCH_ERC1155_ASSETS_JSON`: Optional JSON array of tracked ERC1155 assets used as fallback when the selected agent does not override ERC1155 watchlists in `config.json`
   - Signer selection: `SIGNER_TYPE` (default `env`)
     - `env`: `PRIVATE_KEY`
     - `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
     - `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` (macOS Keychain or Linux Secret Service)
     - `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY` (default `private_key`)
     - `kms`/`vault-signer`/`rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (JSON-RPC signer that accepts `eth_sendTransaction`)
   - Optional tuning: `POLL_INTERVAL_MS`, `LOG_CHUNK_SIZE`, `PROPOSAL_HASH_RESOLVE_TIMEOUT_MS`, `PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS`, `START_BLOCK`, `WATCH_NATIVE_BALANCE`, `DEFAULT_DEPOSIT_*`, `AGENT_MODULE`, `UNISWAP_V3_FACTORY`, `UNISWAP_V3_QUOTER`, `UNISWAP_V3_FEE_TIERS`, `POLYMARKET_*`, `MESSAGE_API_*`, `IPFS_*`
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
- **Optional message API**: When enabled, accepts authenticated user messages over HTTP and injects them as `userMessage` signals for the next decision cycle.
- **Optional IPFS publishing**: When enabled, agents can publish text/JSON artifacts to a Kubo-compatible IPFS API and pin the resulting CID.

All other behavior is intentionally left out. Implement your own agent in `agent-library/agents/<name>/agent.js` to add commitment-specific logic and tool use.

### Price Trigger Config

Export `getPriceTriggers({ commitmentText, config })` from `agent-library/agents/<name>/agent.js` when your agent needs price-trigger behavior. This keeps commitment interpretation local to the module.

### Message API (Optional)

Enable inbound user messages with one or both auth modes:

- Bearer tokens (`Authorization: Bearer ...`)
- Signed requests (EIP-191 message signatures from allowlisted addresses)

- `MESSAGE_API_ENABLED`: Set to `true` to start the API server.
- `MESSAGE_API_HOST`: Bind host (default `127.0.0.1`).
- `MESSAGE_API_PORT`: Bind port (default `8787`).
- `MESSAGE_API_KEYS_JSON`: JSON object of API key ids to tokens, for example `{"ops":"k_live_replace_me"}`.
- `MESSAGE_API_SIGNER_ALLOWLIST`: Comma-separated EVM addresses allowed to use signed auth.
- `MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS`: Max signature age (default `300`).
- `MESSAGE_API_MAX_BODY_BYTES`: Request body limit in bytes (default `8192`).
- `MESSAGE_API_MAX_TEXT_LENGTH`: Max `text` length (default `2000`).
- `MESSAGE_API_QUEUE_LIMIT`: Max queued/in-flight messages (default `500`).
- `MESSAGE_API_BATCH_SIZE`: Max messages consumed per agent loop (default `25`).
- `MESSAGE_API_DEFAULT_TTL_SECONDS`: Default message lifetime applied when `deadline` is omitted (default `3600`).
- `MESSAGE_API_MIN_TTL_SECONDS`: Minimum allowed remaining lifetime for `deadline` (default `30`).
- `MESSAGE_API_MAX_TTL_SECONDS`: Maximum allowed remaining lifetime for `deadline` (default `86400`).
- `MESSAGE_API_IDEMPOTENCY_TTL_SECONDS`: Request replay/dedup cache window (default `86400`).
- `MESSAGE_API_RATE_LIMIT_PER_MINUTE`: Per-key refill rate (default `30`).
- `MESSAGE_API_RATE_LIMIT_BURST`: Per-key burst capacity (default `10`).

When `MESSAGE_API_ENABLED=true`, configure at least one of:
- `MESSAGE_API_KEYS_JSON`
- `MESSAGE_API_SIGNER_ALLOWLIST`

Endpoints:

- `GET /healthz`: health probe.
- `POST /v1/messages`: queue a message for processing.

`POST /v1/messages` body:

```json
{
  "text": "Pause proposals for 2 hours",
  "command": "pause_proposals",
  "args": { "hours": 2 },
  "metadata": { "ticket": "INC-42" },
  "requestId": "inc-42-pause",
  "deadline": 1735696800000,
  "auth": {
    "type": "eip191",
    "address": "0x1111111111111111111111111111111111111111",
    "timestampMs": 1735689600000,
    "signature": "0x..."
  }
}
```

`auth` is optional for Bearer-token requests. For signed auth:
- `auth.type` must be `eip191`
- `requestId` is required
- `deadline` is optional and, when present, must be a Unix timestamp in milliseconds
- signature is verified against a canonical payload that includes
  `address`, `timestampMs`, `text`, `command`, `args`, `metadata`, `requestId`, and `deadline`
- signed requests keep `requestId` replay-locked for at least `MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS`; replays during that window return `409` with code `request_replay_blocked`

Example request:

```bash
curl -sS \
  -X POST "http://127.0.0.1:8787/v1/messages" \
  -H "Authorization: Bearer k_live_replace_me" \
  -H "Content-Type: application/json" \
  -d '{"text":"Pause proposals for 2 hours","command":"pause_proposals","args":{"hours":2},"requestId":"pause-2h"}'
```

Signed-auth test script:

```bash
node agent/scripts/test-message-api-signature-auth.mjs
```

Signed send helper:

```bash
node agent/scripts/send-signed-message.mjs \
  --text="Pause proposals for 2 hours" \
  --private-key="0x<signer-private-key>" \
  --url="http://127.0.0.1:8787" \
  --command="pause_proposals" \
  --args-json='{"hours":2}' \
  --request-id="pause-2h"
```

### IPFS Publishing (Optional)

Enable IPFS artifact publishing when agents need to store signed requests, explanations, or other artifacts offchain and refer to them by CID.

- `IPFS_ENABLED`: Enable the `ipfs_publish` tool (`true`/`false`, default `false`).
- `IPFS_API_URL`: Base URL for a Kubo-compatible IPFS API (default `http://127.0.0.1:5001`).
- `IPFS_HEADERS_JSON`: Optional JSON object of extra HTTP headers for the IPFS API, for example `{"Authorization":"Bearer <token>"}`.
- `IPFS_REQUEST_TIMEOUT_MS`: Optional request timeout (default `15000`).
- `IPFS_MAX_RETRIES`: Optional retry count for transient IPFS failures (default `1`).
- `IPFS_RETRY_DELAY_MS`: Optional retry delay in milliseconds (default `250`).

Tool:

- `ipfs_publish`: Publish either raw string content or structured JSON content to IPFS. It pins the returned CID by default and returns `cid`, `uri`, `pinned`, `publishResult`, and `pinResult`.

### ERC1155 Tracking (Optional)

Some agent modules need tracked ERC1155 balances in addition to ERC20/native monitoring.

- `WATCH_ERC1155_ASSETS_JSON`: JSON array of tracked ERC1155 assets.
- Each entry must include:
  - `token`: ERC1155 contract address
  - `tokenId`: non-negative integer string
  - `symbol`: optional display label used by the agent prompt/context

Example:

```json
[
  {
    "token": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    "tokenId": "123456789",
    "symbol": "YES-123456789"
  }
]
```

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
- `POLYMARKET_EXCHANGE`: Optional CTF exchange override for EIP-712 order signing domain.
- `POLYMARKET_CLOB_ENABLED`: Enable CLOB tools (`true`/`false`, default `false`).
- `POLYMARKET_CLOB_HOST`: CLOB API host (default `https://clob.polymarket.com`).
- `POLYMARKET_CLOB_ADDRESS`: Optional address used as `POLY_ADDRESS` for CLOB auth (for proxy/funder setups). Defaults to runtime signer address.
- `POLYMARKET_CLOB_SIGNATURE_TYPE`: Optional default order signature type for build/sign flow (`EOA`/`POLY_PROXY`/`POLY_GNOSIS_SAFE` or `0`/`1`/`2`).
  - Per Polymarket docs: `0=EOA`, `1=POLY_PROXY`, `2=POLY_GNOSIS_SAFE`.
  - When using `POLY_PROXY` or `POLY_GNOSIS_SAFE`, set `POLYMARKET_CLOB_ADDRESS` to the proxy/funder wallet address.
- `POLYMARKET_CLOB_API_KEY`, `POLYMARKET_CLOB_API_SECRET`, `POLYMARKET_CLOB_API_PASSPHRASE`: Required for authenticated CLOB calls.
- `POLYMARKET_CLOB_REQUEST_TIMEOUT_MS`, `POLYMARKET_CLOB_MAX_RETRIES`, `POLYMARKET_CLOB_RETRY_DELAY_MS`: Optional request tuning.
- `POLYMARKET_RELAYER_ENABLED`: Enable Polymarket relayer submission for ERC1155 deposits (`true`/`false`, default `false`).
- `POLYMARKET_RELAYER_HOST`: Relayer API host (default `https://relayer-v2.polymarket.com`).
- `POLYMARKET_RELAYER_TX_TYPE`: Relayer wallet type (`SAFE` default, or `PROXY`).
- `POLYMARKET_RELAYER_FROM_ADDRESS`: Optional explicit relayer proxy wallet address (if omitted, runtime auto-resolves from signer + relayer APIs / deterministic address).
- `POLYMARKET_RELAYER_SAFE_FACTORY`, `POLYMARKET_RELAYER_PROXY_FACTORY`: Optional factory overrides for deterministic SAFE/PROXY address derivation.
- `POLYMARKET_RELAYER_RESOLVE_PROXY_ADDRESS`: Resolve proxy address via relayer API when from-address is not set (default `true`).
- `POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY`: Optionally create proxy wallet when absent (default `false`).
- `POLYMARKET_RELAYER_CHAIN_ID`, `POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS`, `POLYMARKET_RELAYER_POLL_INTERVAL_MS`, `POLYMARKET_RELAYER_POLL_TIMEOUT_MS`: Optional relayer runtime tuning.
- Builder credentials for relayer auth headers:
  - Preferred: `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`.
  - Fallbacks supported: `POLYMARKET_API_*` then `POLYMARKET_CLOB_API_*`.

#### Execution Modes

- `PROPOSE_ENABLED=true` and/or `DISPUTE_ENABLED=true`: onchain tools are enabled (`build_og_transactions`, `make_deposit`, `make_transfer`, `make_erc1155_deposit`, `make_erc1155_transfer`, propose/dispute tools).
- `PROPOSE_ENABLED=false` and `DISPUTE_ENABLED=false`: onchain tools are disabled.
- `POLYMARKET_CLOB_ENABLED=true`: CLOB tools can still run in this mode (`polymarket_clob_place_order`, `polymarket_clob_build_sign_and_place_order`, `polymarket_clob_cancel_orders`).
- `IPFS_ENABLED=true`: IPFS publishing tools can run in this mode (`ipfs_publish`), even if onchain/CLOB tools are disabled.
- All four disabled (`PROPOSE_ENABLED=false`, `DISPUTE_ENABLED=false`, `POLYMARKET_CLOB_ENABLED=false`, `IPFS_ENABLED=false`): monitor/opinion only.

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

When `POLYMARKET_RELAYER_ENABLED=true`, this tool submits via Polymarket relayer (SAFE/PROXY) instead of direct onchain `writeContract`. If `POLYMARKET_RELAYER_FROM_ADDRESS` is not set, the runtime resolves the proxy wallet from the signer and relayer metadata. For SAFE mode, any explicitly configured proxy wallet must match the relayer-derived SAFE address for that signer.

#### ERC1155 Direct Transfer

Use `make_erc1155_transfer` to send ERC1155 tokens directly from the agent wallet to any recipient:

```json
{
  "name": "make_erc1155_transfer",
  "arguments": {
    "token": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    "recipient": "0x1234567890123456789012345678901234567890",
    "tokenId": "123456789",
    "amount": "1",
    "data": "0x"
  }
}
```

When `POLYMARKET_RELAYER_ENABLED=true`, this tool also submits via the relayer and uses the resolved proxy wallet as the `from` address in `safeTransferFrom`.

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

`polymarket_clob_build_sign_and_place_order` builds and signs the order with the runtime signer before submission:

```json
{
  "name": "polymarket_clob_build_sign_and_place_order",
  "arguments": {
    "side": "BUY",
    "tokenId": "123456789",
    "orderType": "FOK",
    "makerAmount": "1000000",
    "takerAmount": "450000"
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

For `polymarket_clob_build_sign_and_place_order`, `maker` and `signer` must also be one of:
- runtime signer address, or
- `POLYMARKET_CLOB_ADDRESS` when set.

This tool requires a signer backend that supports `signTypedData`.

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
An agent directory may also include an optional `config.json` for repo-tracked, non-secret configuration.

`config.json` is loaded from `agent-library/agents/<name>/config.json` and merged like this:
- top-level keys apply on every chain
- `byChain.<chainId>` overrides top-level keys for the active RPC chain
- `watchAssets` and `watchErc1155Assets` from the file override env watchlists when present
- if the file is missing, or those keys are absent, the runner falls back to `WATCH_ASSETS` and `WATCH_ERC1155_ASSETS_JSON`

Example:

```json
{
  "policyName": "fast-withdraw",
  "byChain": {
    "11155111": {
      "watchAssets": [
        "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
      ],
      "watchErc1155Assets": [
        {
          "token": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          "tokenId": "123456789",
          "symbol": "YES-123456789"
        }
      ]
    }
  }
}
```

The merged result is exposed to agent modules as `config.agentConfig`, while the resolved active-chain watchlists still appear at `config.watchAssets` and `config.watchErc1155Assets`.

You can validate a module quickly:

```bash
node agent/scripts/validate-agent.mjs --module=default
```

Run the local agent script suite:

```bash
npm --prefix agent test
```

Optionally narrow the local suite to specific scripts:

```bash
node agent/scripts/run-local-tests.mjs --include=message-loop --exclude=message-api
```

Execute a specific OG proposal by proposal submission transaction hash (uses the configured signer from `agent/.env`):

```bash
node agent/scripts/execute-og-proposal.mjs \
  --og=0xYourOptimisticGovernor \
  --proposal-tx-hash=0xProposalSubmissionTxHash
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
