## OG Deployer

Command-line tooling for deploying onchain Commitments: a Safe with an Optimistic Governor module configured with natural language rules. Use it to spin up a new Safe, connect the Optimistic Governor module, and set the rules/bond/collateral in one script run.

## What This Repo Does

- Deploys a Safe and the Optimistic Governor module in one flow.
- Encodes natural language rules into the module configuration.
- Supports env-var overrides for Safe and OG parameters.
- Uses Foundry for scripting, testing, and deployments.

## Quick Start

1. Install Foundry: https://book.getfoundry.sh/
2. Set environment variables in your shell or `.env` file (load via `direnv` or `dotenvx` if desired).
3. Run the deployment script.

```shell
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --private-key <your_private_key>
```

## Commitment Agent Tooling

Use the offchain agent scaffold in `agent/` to serve commitments by posting bonds, proposing transactions, monitoring deposits, and making deposits on behalf of the commitment. It ships only generic tools; add commitment-specific behavior in your own prompts or handlers.

### Setup & Run

```shell
cd agent
npm install
cp .env.example .env # fill in RPC_URL, PRIVATE_KEY, COMMITMENT_SAFE, OG_MODULE, WATCH_ASSETS
npm start
```

The loop polls every `POLL_INTERVAL_MS` (default 60s) for ERC20 transfers into the commitment (and optional native balance increases). If nothing changes, the LLM/decision hook is not invoked. When signals are found, `decideOnSignals` is called—extend that function to route context into your system prompt and custom tools.

### Built-in Agent Tools

- `postBondAndPropose`: Approves the Optimistic Oracle for the module bond and calls `proposeTransactions` on the Optimistic Governor.
- `makeDeposit`: Sends ERC20 or native deposits into the commitment Safe using the agent key.
- `pollCommitmentChanges`: Watches configured assets (plus the OG collateral by default) for new deposits.

Add more tools for a specific commitment beside these generics; keep the default agent lean.

## Required Environment Variables

- `DEPLOYER_PK`: Private key for the deployer.
- `OG_COLLATERAL`: Address of the ERC20 collateral token.
- `OG_BOND_AMOUNT`: Bond amount for challenges.
- `OG_RULES`: Natural language rules for the commitment.

## Optional Overrides

- `SAFE_SALT_NONCE`, `SAFE_THRESHOLD`, `SAFE_OWNERS`
- `OG_SALT_NONCE`, `OG_CHALLENGE_PERIOD`, `OG_RULES_URI`
- `OG_MASTER_COPY`, `SAFE_SINGLETON`, `SAFE_FALLBACK_HANDLER`
- `MODULE_PROXY_FACTORY`

## Web Frontend

The web frontend is a lightweight UI for filling in Safe + Optimistic Governor parameters and launching the same deployment flow as the script. It can be hosted as a static site and uses RPC endpoints to read chain state and craft the deployment payloads.

It mirrors the deploy script flow with a UI-driven parameter set.

### Dependencies

- Node.js 18+ (or newer)
- npm, pnpm, or yarn for package management

### Local Development

From the web frontend directory (if you keep it alongside this repo), install dependencies and start the dev server:

```shell
npm install
npm run dev
```

Agent setup is documented separately in `agent/README.md`.

### Required Environment Variables

Expose these values to the frontend build (for example via `.env` in the frontend project) so the UI can prefill defaults and target the correct network:

- `MAINNET_RPC_URL` or `SEPOLIA_RPC_URL` (or another network-specific RPC URL)
- Default addresses (optional but recommended for prefill):
  - `SAFE_SINGLETON`
  - `SAFE_PROXY_FACTORY`
  - `SAFE_FALLBACK_HANDLER`
  - `OG_MASTER_COPY`
  - `MODULE_PROXY_FACTORY`

### Form Fields → On-Chain Parameters

Use the same inputs as the deploy script; the UI should map them directly to the on-chain deployment parameters:

- **Safe Owners** → `SAFE_OWNERS`
- **Safe Threshold** → `SAFE_THRESHOLD`
- **Safe Salt Nonce** → `SAFE_SALT_NONCE`
- **OG Collateral Token** → `OG_COLLATERAL`
- **OG Bond Amount** → `OG_BOND_AMOUNT`
- **OG Rules (Natural Language)** → `OG_RULES`
- **OG Challenge Period** → `OG_CHALLENGE_PERIOD`
- **OG Rules URI** → `OG_RULES_URI`
- **OG Salt Nonce** → `OG_SALT_NONCE`
- **Safe Singleton** → `SAFE_SINGLETON`
- **Safe Proxy Factory** → `SAFE_PROXY_FACTORY`
- **Safe Fallback Handler** → `SAFE_FALLBACK_HANDLER`
- **OG Master Copy** → `OG_MASTER_COPY`
- **Module Proxy Factory** → `MODULE_PROXY_FACTORY`

### Deployment Note

Build output is static (e.g., `dist/` or `build/`, depending on your frontend tooling) and can be hosted on any static host (Netlify, Vercel static output, S3/CloudFront, etc.). Ensure the RPC URLs and default addresses are configured for the target network before deploying the static bundle.

## Example `.env`

```ini
# Required
DEPLOYER_PK=0xabc123...
OG_COLLATERAL=0x1111111111111111111111111111111111111111
OG_BOND_AMOUNT=250000000
OG_RULES="Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."

# Safe overrides
SAFE_OWNERS=0x2222222222222222222222222222222222222222,0x3333333333333333333333333333333333333333
SAFE_THRESHOLD=2
SAFE_SALT_NONCE=12345

# Optimistic Governor overrides
OG_CHALLENGE_PERIOD=604800
OG_RULES_URI=ipfs://bafy...
OG_SALT_NONCE=67890

# Optional factory / master copy overrides
MODULE_PROXY_FACTORY=0x4444444444444444444444444444444444444444
OG_MASTER_COPY=0x5555555555555555555555555555555555555555
SAFE_SINGLETON=0x6666666666666666666666666666666666666666
SAFE_FALLBACK_HANDLER=0x7777777777777777777777777777777777777777
```

### Signer Options (CLI Scripts)

Forge scripts still require a private key env var (e.g., `DEPLOYER_PK`, `PROPOSER_PK`, `EXECUTOR_PK`). If you don't want to store raw keys in `.env`, use `agent/with-signer.mjs` to resolve a signer at runtime and inject the env var:

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

# OS keychain
SIGNER_TYPE=keychain KEYCHAIN_SERVICE=og-deployer KEYCHAIN_ACCOUNT=deployer \
  node agent/with-signer.mjs --env DEPLOYER_PK -- \
  forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast

# Vault KV (private key stored as a secret)
SIGNER_TYPE=vault VAULT_ADDR=https://vault.example.com VAULT_TOKEN=... VAULT_SECRET_PATH=secret/data/og-deployer \
  node agent/with-signer.mjs --env DEPLOYER_PK -- \
  forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast
```

For KMS/Vault signing without exporting private keys, use an RPC signer proxy that exposes `eth_sendTransaction` (set `SIGNER_RPC_URL` and `SIGNER_ADDRESS`). The agent supports this directly (see `agent/README.md`); Forge scripts need a proxy that can export or inject keys.

## Common Commands

```shell
forge build
forge test
forge fmt
```

## Local Testing

Dry-run (no broadcast):

```shell
anvil
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <your_private_key>
```

Broadcast on Anvil:

```shell
anvil
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast \
  --private-key <your_private_key>
```

## Propose & Execute Transfers

Propose a transfer (posts the UMA bond via the Optimistic Governor):

```shell
export PROPOSER_PK=<private_key>
export OG_MODULE=<optimistic_governor_module>
export TRANSFER_ASSET=<erc20_token_address>
export TRANSFER_AMOUNT=<amount_in_token_units>
export TRANSFER_DESTINATION=<recipient_address>

forge script script/ProposeCommitmentTransfer.s.sol:ProposeCommitmentTransfer \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --private-key $PROPOSER_PK
```

Execute a proposal after it passes:

```shell
export EXECUTOR_PK=<private_key>
export OG_MODULE=<optimistic_governor_module>
export PROPOSAL_HASH=<proposal_hash>
export TRANSFER_ASSET=<erc20_token_address>
export TRANSFER_AMOUNT=<amount_in_token_units>
export TRANSFER_DESTINATION=<recipient_address>

forge script script/ExecuteCommitmentTransfer.s.sol:ExecuteCommitmentTransfer \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --private-key $EXECUTOR_PK
```

Optional overrides:

- `TRANSFER_OPERATION` (default `0` for `CALL`)
- `TRANSFER_VALUE` (default `0`)

### Anvil Test Key + USDC Funding (Fork)

Start Anvil with the default test mnemonic and grab one of the printed private keys:

```shell
anvil --fork-url $MAINNET_RPC_URL --mnemonic "test test test test test test test test test test test junk"
```

Fund the test account with USDC by impersonating a whale on the fork:

```shell
cast rpc anvil_impersonateAccount <whale_address>
cast rpc anvil_setBalance <whale_address> 0x3635C9ADC5DEA00000
cast send <usdc_contract> "transfer(address,uint256)" <your_account> <amount> --from <whale_address>
cast rpc anvil_stopImpersonatingAccount <whale_address>
```

## Network Env Files

You can keep per-network env files and load them with a tool like `dotenvx` or `direnv`.

Mainnet fork example (`.env.mainnet`):

```ini
MAINNET_RPC_URL=...
DEPLOYER_PK=0x...
OG_COLLATERAL=0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
OG_BOND_AMOUNT=250000000
OG_RULES="Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."
OG_IDENTIFIER_STR=ASSERT_TRUTH2
```

A ready-to-edit template is available at `.env.mainnet.example`.

Sepolia example (`.env.sepolia`):

```ini
SEPOLIA_RPC_URL=...
DEPLOYER_PK=0x...
SAFE_SINGLETON=0x...
SAFE_PROXY_FACTORY=0x...
SAFE_FALLBACK_HANDLER=0x...
OG_MASTER_COPY=0x...
OG_COLLATERAL=0x...
OG_BOND_AMOUNT=...
OG_RULES="Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."
```

Load the file before running the script:

```shell
dotenvx run -f .env.mainnet -- forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PK
```
