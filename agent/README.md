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
   - `AGENT_MODULE`: Agent implementation name, unless you pass `--module` to helper scripts
   - Signer selection: `SIGNER_TYPE` (default `env`)
     - `env`: `PRIVATE_KEY`
     - `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
     - `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` (macOS Keychain or Linux Secret Service)
     - `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY` (default `private_key`), optional `VAULT_REQUEST_TIMEOUT_MS`
     - `kms`/`vault-signer`/`rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (JSON-RPC signer that accepts `eth_sendTransaction`)
   - Secret API/auth values only:
     - `OPENAI_API_KEY`
     - `MESSAGE_API_KEYS_JSON` for secret bearer tokens layered on signed Message API auth
     - `POLYMARKET_CLOB_API_KEY`, `POLYMARKET_CLOB_API_SECRET`, `POLYMARKET_CLOB_API_PASSPHRASE`
     - `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`
     - `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`
     - `IPFS_HEADERS_JSON` when it carries auth headers
   - Non-secret runner behavior belongs in the selected agent module's `config.json`.
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
  bash script/deploy-commitment.sh

# Encrypted keystore
SIGNER_TYPE=keystore KEYSTORE_PATH=./keys/deployer.json KEYSTORE_PASSWORD=... \
  node agent/with-signer.mjs --env DEPLOYER_PK -- \
  bash script/set-safe-owners.sh --safe 0xYourSafe --owners 0x
```

For interactions, swap the env var (e.g., `PROPOSER_PK`, `EXECUTOR_PK`). For signing without exporting a key, use an RPC signer proxy (`SIGNER_RPC_URL`, `SIGNER_ADDRESS`) that supports `eth_sendTransaction`.

## What the Agent Does

- **Polls for deposits**: Checks ERC20 `Transfer` logs, tracked ERC1155 `TransferSingle`/`TransferBatch` logs into the commitment, and (optionally) native balance increases. If nothing changed, no LLM/decision code runs.
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

Enable inbound user messages with signed requests (EIP-191 message signatures).
Optional bearer tokens can be layered on top as an additional gate to limit who may submit those signed requests.

Configure Message API settings in `agent-library/agents/<name>/config.json`:

```json
{
  "messageApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "requireSignerAllowlist": true,
    "signerAllowlist": [
      "0x1111111111111111111111111111111111111111"
    ],
    "signatureMaxAgeSeconds": 300,
    "maxBodyBytes": 8192,
    "maxTextLength": 2000,
    "queueLimit": 500,
    "batchSize": 25,
    "defaultTtlSeconds": 3600,
    "minTtlSeconds": 30,
    "maxTtlSeconds": 86400,
    "idempotencyTtlSeconds": 86400,
    "rateLimitPerMinute": 30,
    "rateLimitBurst": 10
  }
}
```

Supported `messageApi` fields:
- `enabled`: Set to `true` to start the API server.
- `host`: Bind host (default `127.0.0.1`).
- `port`: Bind port (default `8787`).
- `requireSignerAllowlist`: Require `signerAllowlist` membership for signed requests (`true`/`false`, default `true`).
- `signerAllowlist`: Optional array of EVM addresses allowed to sign requests. Required when `requireSignerAllowlist=true`.
- `signatureMaxAgeSeconds`: Max signature age (default `300`).
- `maxBodyBytes`: Request body limit in bytes (default `8192`).
- `maxTextLength`: Max `text` length (default `2000`).
- `queueLimit`: Max queued/in-flight messages (default `500`).
- `batchSize`: Max messages consumed per agent loop (default `25`).
- `defaultTtlSeconds`: Default message lifetime applied when `deadline` is omitted (default `3600`).
- `minTtlSeconds`: Minimum allowed remaining lifetime for `deadline` (default `30`).
- `maxTtlSeconds`: Maximum allowed remaining lifetime for `deadline` (default `86400`).
- `idempotencyTtlSeconds`: Request replay/dedup cache window (default `86400`).
- `rateLimitPerMinute`: Per-key refill rate (default `30`).
- `rateLimitBurst`: Per-key burst capacity (default `10`).

Keep bearer tokens in env via `MESSAGE_API_KEYS_JSON`; `messageApi.keys` is intentionally not supported in repo-tracked commitment config because those tokens are secret.

Use `byChain.<chainId>.messageApi` for chain-specific overrides to the shared `messageApi` object.

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

All accepted messages must include signed auth:
- `auth.type` must be `eip191`
- `requestId` is required
- `deadline` is optional and, when present, must be a Unix timestamp in milliseconds
- signature is verified against a canonical payload that includes
  `address`, `timestampMs`, `text`, `command`, `args`, `metadata`, `requestId`, and `deadline`
- when `messageApi.requireSignerAllowlist=true`, the recovered signer must also appear in `messageApi.signerAllowlist`
- signed requests keep `requestId` replay-locked for at least `messageApi.signatureMaxAgeSeconds`; replays during that window return `409` with code `request_replay_blocked`
- when `MESSAGE_API_KEYS_JSON` is configured, a valid `Authorization: Bearer ...` header is also required

Example request with optional bearer gate:

```bash
curl -sS \
  -X POST "http://127.0.0.1:8787/v1/messages" \
  -H "Authorization: Bearer k_live_replace_me" \
  -H "Content-Type: application/json" \
  -d '{"text":"Pause proposals for 2 hours","command":"pause_proposals","args":{"hours":2},"requestId":"pause-2h","auth":{"type":"eip191","address":"0x1111111111111111111111111111111111111111","timestampMs":1735689600000,"signature":"0x..."}}'
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
  --chain-id=11155111 \
  --command="pause_proposals" \
  --args-json='{"hours":2}' \
  --request-id="pause-2h"
```

Compatibility note:
- Older versions of the helper allowed `--url` by itself.
- That flow is intentionally no longer supported.
- Signed Message API requests are now chain-bound, so `--url` must be paired with `--chain-id=<id>` or `--module=<agent>` so the helper can sign the correct chain-aware payload.

If `--url` is omitted, the helper reads `messageApi.host` and `messageApi.port` from the selected agent module's merged config stack (`config.json`, optional `config.local.json`, and any `--overlay` / `--overlay-paths` files passed to the script). Use `--module=<agent-name>` and optional `--chain-id=<int>` to select the commitment config. When the module does not override those fields, the helper falls back to the built-in default `http://127.0.0.1:8787`.

If bearer gating is configured, also pass `--bearer-token="<token>"` or set `MESSAGE_API_BEARER_TOKEN`.

### IPFS Publishing (Optional)

Enable IPFS artifact publishing when agents need to store signed requests, explanations, or other artifacts offchain and refer to them by CID.

Configure non-secret IPFS settings in the module `config.json` or `byChain.<chainId>`:
- `ipfsEnabled`: Enable the `ipfs_publish` tool (`true`/`false`, default `false`).
- `ipfsApiUrl`: Base URL for a Kubo-compatible IPFS API (default `http://127.0.0.1:5001`).
- `ipfsRequestTimeoutMs`: Optional request timeout (default `15000`).
- `ipfsMaxRetries`: Optional retry count for transient IPFS failures (default `1`).
- `ipfsRetryDelayMs`: Optional retry delay in milliseconds (default `250`).

Keep `IPFS_HEADERS_JSON` in env when it contains auth headers, for example `{"Authorization":"Bearer <token>"}`.

Tool:

- `ipfs_publish`: Publish either raw string content or structured JSON content to IPFS. For tool calls, JSON content is passed as JSON text and canonicalized before upload. It pins the returned CID by default and returns `cid`, `uri`, `pinned`, `publishResult`, and `pinResult`.

### ERC1155 Tracking (Optional)

The shared runner can monitor configured ERC1155 token IDs in addition to ERC20/native monitoring.

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

When configured, the runner emits:

- `erc1155Deposit` signals when a watched token ID is transferred into the commitment Safe.
- `erc1155BalanceSnapshot` signals when a watched token ID balance changes, or on every poll when the agent enables always-on balance snapshots.

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

Set these in module config when using Polymarket functionality. Secret API credentials remain env-only:
- `polymarketConditionalTokens`: Optional CTF contract address override used by CTF actions (default is Polymarket mainnet ConditionalTokens).
- `polymarketExchange`: Optional CTF exchange override for EIP-712 order signing domain.
- `polymarketClobEnabled`: Enable CLOB tools (`true`/`false`, default `false`).
- `polymarketClobHost`: CLOB API host (default `https://clob.polymarket.com`).
- `polymarketClobAddress`: Optional address used as `POLY_ADDRESS` for CLOB auth (for proxy/funder setups). Defaults to runtime signer address.
- `polymarketClobSignatureType`: Optional default order signature type for build/sign flow (`EOA`/`POLY_PROXY`/`POLY_GNOSIS_SAFE` or `0`/`1`/`2`).
  - Per Polymarket docs: `0=EOA`, `1=POLY_PROXY`, `2=POLY_GNOSIS_SAFE`.
  - When using `POLY_PROXY` or `POLY_GNOSIS_SAFE`, set `POLYMARKET_CLOB_ADDRESS` to the proxy/funder wallet address.
- `POLYMARKET_CLOB_API_KEY`, `POLYMARKET_CLOB_API_SECRET`, `POLYMARKET_CLOB_API_PASSPHRASE`: Required for authenticated CLOB calls.
- `polymarketClobRequestTimeoutMs`, `polymarketClobMaxRetries`, `polymarketClobRetryDelayMs`: Optional request tuning.
- `polymarketRelayerEnabled`: Enable Polymarket relayer submission for ERC1155 deposits (`true`/`false`, default `false`).
- `polymarketRelayerHost`: Relayer API host (default `https://relayer-v2.polymarket.com`).
- `polymarketRelayerTxType`: Relayer wallet type (`SAFE` default, or `PROXY`).
- `polymarketRelayerFromAddress`: Optional explicit relayer proxy wallet address (if omitted, runtime auto-resolves from signer + relayer APIs / deterministic address).
- `polymarketRelayerSafeFactory`, `polymarketRelayerProxyFactory`: Optional factory overrides for deterministic SAFE/PROXY address derivation.
- `polymarketRelayerResolveProxyAddress`: Resolve proxy address via relayer API when from-address is not set (default `true`).
- `polymarketRelayerAutoDeployProxy`: Optionally create proxy wallet when absent (default `false`).
- `polymarketRelayerChainId`, `polymarketRelayerRequestTimeoutMs`, `polymarketRelayerPollIntervalMs`, `polymarketRelayerPollTimeoutMs`: Optional relayer runtime tuning.
- Builder credentials for relayer auth headers:
  - Preferred: `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`.
  - Fallbacks supported: `POLYMARKET_API_*` then `POLYMARKET_CLOB_API_*`.

#### Execution Modes

- `proposeEnabled=true` and/or `disputeEnabled=true`: onchain tools are enabled (`build_og_transactions`, `make_deposit`, `make_transfer`, `make_erc1155_deposit`, `make_erc1155_transfer`, propose/dispute tools).
- `proposeEnabled=false` and `disputeEnabled=false`: onchain tools are disabled.
- `polymarketClobEnabled=true`: CLOB tools can still run in this mode (`polymarket_clob_place_order`, `polymarket_clob_build_sign_and_place_order`, `polymarket_clob_cancel_orders`).
- `ipfsEnabled=true`: IPFS publishing tools can run in this mode (`ipfs_publish`), even if onchain/CLOB tools are disabled.
- All four disabled (`proposeEnabled=false`, `disputeEnabled=false`, `polymarketClobEnabled=false`, `ipfsEnabled=false`): monitor/opinion only.

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

Set `proposeEnabled` and `disputeEnabled` in module config to control behavior:
- Both true: propose and dispute as needed (default).
- Only `proposeEnabled=true`: propose only, never dispute.
- Only `disputeEnabled=true`: dispute only, never propose.
- Both false: monitor and log opinions only; no on-chain actions.

### Agent Modules & Commitments

Use `AGENT_MODULE` to point to an agent implementation name (e.g., `default`, `timelock-withdraw`). The runner will load `agent-library/agents/<name>/agent.js`.
Each agent directory must include a `commitment.txt` with the plain language commitment the agent is designed to serve.
An agent directory may also include an optional `config.json` for repo-tracked, non-secret configuration.
For machine-local or ephemeral overrides, the loader also supports an optional untracked `config.local.json` next to `config.json`, plus extra overlay files passed through `AGENT_CONFIG_OVERLAY_PATH` or `AGENT_CONFIG_OVERLAY_PATHS`.

The config stack is loaded and merged like this:
- `agent-library/agents/<name>/config.json`
- optional `agent-library/agents/<name>/config.local.json`
- optional overlay files from `AGENT_CONFIG_OVERLAY_PATH` and `AGENT_CONFIG_OVERLAY_PATHS`
- top-level keys apply on every chain
- `byChain.<chainId>` overrides top-level keys for the active RPC chain
- nested plain objects are merged recursively; arrays and scalar values replace the shared value
- non-secret shared runner fields come from the config stack, including `commitmentSafe`, `ogModule`, `watchAssets`, `watchErc1155Assets`, `pollIntervalMs`, `logChunkSize`, `startBlock`, `watchNativeBalance`, `defaultDepositAsset`, `defaultDepositAmountWei`, `bondSpender`, proposal/dispute toggles and retry controls, `openAiModel`, `openAiBaseUrl`, `openAiRequestTimeoutMs`, `ipfsEnabled`, `ipfsApiUrl`, `ipfsRequestTimeoutMs`, `ipfsMaxRetries`, `ipfsRetryDelayMs`, `chainlinkPriceFeed`, `uniswapV3*`, `polymarket*`, and `messageApi`
- if the file is missing, or those keys are absent or `null`, the runner uses built-in defaults for optional fields and requires config values for commitment-specific addresses like `commitmentSafe` and `ogModule`
- secrets remain env-only: signer credentials, `OPENAI_API_KEY`, `MESSAGE_API_KEYS_JSON`, Polymarket API credentials, `IPFS_HEADERS_JSON` auth headers, and similar bearer/API keys

If you still have legacy non-secret settings only in env, migrate them once into `config.local.json` with:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=<agent-name> --chain-id=<chain-id>
```

Example:

```json
{
  "policyName": "fast-withdraw",
  "pollIntervalMs": 15000,
  "proposeEnabled": true,
  "disputeEnabled": true,
  "openAiModel": "gpt-4.1-mini",
  "polymarketClobEnabled": true,
  "polymarketClobHost": "https://clob.polymarket.com",
  "byChain": {
    "11155111": {
      "commitmentSafe": "0x1111111111111111111111111111111111111111",
      "ogModule": "0x2222222222222222222222222222222222222222",
      "startBlock": "8123456",
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

The merged result is exposed to agent modules as `config.agentConfig`, while the resolved active-chain addresses and watchlists still appear at `config.commitmentSafe`, `config.ogModule`, `config.watchAssets`, and `config.watchErc1155Assets`.

#### Building A New Agentic Commitment

Recommended workflow for a new module:
1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Write the plain-language rules in `commitment.txt`.
3. Implement commitment-specific logic in `agent.js`.
4. Add `config.json` for non-secret behavior and chain-specific deployment details.
5. Add `harness.mjs` when the module needs a custom smoke flow beyond generic deploy/start/message/deposit steps.
6. Keep secrets in `agent/.env` only: signer keys, `OPENAI_API_KEY`, `MESSAGE_API_KEYS_JSON`, authenticated `IPFS_HEADERS_JSON`, Polymarket API credentials, and similar bearer tokens.

Recommended minimal module config shape:

```json
{
  "defaultDepositAmountWei": "1000000",
  "messageApi": {
    "enabled": true,
    "requireSignerAllowlist": false
  },
  "harness": {
    "deployment": {
      "bondAmount": "1000000"
    }
  },
  "byChain": {
    "11155111": {
      "commitmentSafe": "0x1111111111111111111111111111111111111111",
      "ogModule": "0x2222222222222222222222222222222222222222",
      "startBlock": "8123456"
    }
  }
}
```

Validate the module before running it:

```bash
node agent/scripts/validate-agent.mjs --module=<agent-name>
node agent-library/agents/<agent-name>/test-<agent-name>.mjs
```

The local testnet harness stores untracked session state under `agent/.state/harness/<module>/<profile>/`, including:
- `overlay.json` for ephemeral config overrides layered above the tracked module config
- `deployment.json` for the most recent commitment deployment discovered or created by the harness
- `roles.json` for deterministic local dev roles (`deployer`, `agent`, `depositor`)
- `pids.json` plus `anvil.log` / `agent.log` / `ipfs.log` for local process supervision

#### Local Harness

The fastest end-to-end loop for a new commitment module is:

```bash
node agent/scripts/testnet-harness.mjs smoke --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs status --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs down --module=<agent-name> --profile=local-mock
```

Use `local-mock` while building the module. It can auto-deploy mock Safe/OG dependencies, default the bond amount to `1` when the module omits it, and align `defaultDepositAsset` with the actual deployed collateral unless the module config already overrides that field.

Important local-mock design note:
- `local-mock` forces the session overlay `chainId` to the harness profile chain so the runner resolves the local deployment, but it does not copy source-chain `byChain.watchAssets` or `byChain.watchErc1155Assets` into the local session.
- That is intentional. Copying Sepolia or Polygon watched asset addresses into Anvil makes the runner poll contracts that do not exist locally and causes false harness failures.
- Local ERC20 assets should come from the harness deployment overlay and OG collateral defaults. If a module needs local ERC1155 tracking, wire explicit local mock ERC1155 addresses into the local overlay or module-local harness flow instead of inheriting real-network watch lists.

For step-by-step debugging, the harness also supports:

```bash
node agent/scripts/testnet-harness.mjs init --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs up --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs deploy --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs agent-up --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs run-agent --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs smoke --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs seed-erc20 --module=<agent-name> --profile=local-mock --token=0x... --amount-wei=1000000 --mint
node agent/scripts/testnet-harness.mjs deposit --module=<agent-name> --profile=local-mock --amount-wei=1000000
node agent/scripts/testnet-harness.mjs message --module=<agent-name> --profile=local-mock --text="Test signed instruction" --dry-run
node agent/scripts/testnet-harness.mjs status --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs down --module=<agent-name> --profile=local-mock
```

Available built-in profiles are `local-mock`, `fork-sepolia`, `fork-polygon`, and `remote-sepolia`. Fork and remote Sepolia profiles expect `SEPOLIA_RPC_URL`; Polygon fork expects `POLYGON_RPC_URL`.

For local harness deployment, you can optionally add non-secret defaults under `harness` in the module config:

```json
{
  "defaultDepositAmountWei": "1000000",
  "harness": {
    "deployment": {
      "collateral": "0xYourCollateral",
      "bondAmount": "1000000",
      "liveness": "7200"
    },
    "seedErc20Holders": {
      "0xYourCollateralLowercase": "0xFundedHolder"
    }
  }
}
```

`local-mock` can auto-deploy mock Safe/OG dependencies. If `harness.deployment.collateral` is omitted, it also provisions a mock collateral token. Fork profiles reuse configured dependency addresses when present, and otherwise expect `harness.deployment` to provide the non-secret deployment inputs.

`agent-up` starts the runner in the background with the harness-managed deterministic `agent` key and records it in `pids.json`; `down` now stops both the detached runner and Anvil. `run-agent` remains the foreground option.

When `ipfsEnabled=true` and `ipfsApiUrl` points to localhost, the harness now health-checks the Kubo API and starts a session-local `ipfs daemon` automatically if needed. It keeps the repo under the harness session directory and records the daemon in `pids.json`. Remote IPFS URLs are never started or stopped by the harness.

For one-command scenarios, add an optional `harness.mjs` next to the agent module. The harness loader will call `runSmokeScenario(ctx)` when present and fall back to a generic deploy + agent-start smoke when absent.

For a permanent short-name message API smoke target, use `signed-message-smoke`:

```bash
node agent/scripts/testnet-harness.mjs smoke --module=signed-message-smoke --profile=local-mock
node agent/scripts/testnet-harness.mjs status --module=signed-message-smoke --profile=local-mock
node agent/scripts/testnet-harness.mjs down --module=signed-message-smoke --profile=local-mock
```

That module ships with deterministic no-op decision logic plus `messageApi` and harness defaults in its own `agent-library/agents/signed-message-smoke/config.json`, along with a module-local `harness.mjs` smoke scenario, so local harness tests can use the short module name without ad hoc fixture paths.

For remote Sepolia smoke runs, the harness uses env-backed role keys instead of deterministic local keys. Supported secret env fallbacks are:
- deployer: `HARNESS_DEPLOYER_PRIVATE_KEY` or `DEPLOYER_PK`
- agent: `HARNESS_AGENT_PRIVATE_KEY` or `PRIVATE_KEY`
- depositor/message signer: `HARNESS_DEPOSITOR_PRIVATE_KEY` or `MESSAGE_API_SIGNER_PRIVATE_KEY`

The simplest real testnet path is:
1. make sure the module has Sepolia `byChain.11155111` config for `commitmentSafe` / `ogModule`, or enough `harness.deployment` settings for remote deployment
2. keep only the private keys and API tokens in `agent/.env`
3. run:

```bash
node agent/scripts/testnet-harness.mjs smoke --module=<agent-name> --profile=remote-sepolia
```

Example remote smoke command:

```bash
node agent/scripts/testnet-harness.mjs smoke --module=signed-message-smoke --profile=remote-sepolia
```

For remote deployment, the selected module still needs enough non-secret `harness.deployment` config for Sepolia, especially `collateral` and any chain-specific Safe/OG overrides required by that network.

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
