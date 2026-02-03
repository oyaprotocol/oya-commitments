# Oya Commitments

This repo contains everything needed to set up **Oya commitments**: smart contracts controlled by plain language rules and the agents that serve them. It includes the Solidity contracts, deployment scripts, an optional web UI, and an offchain agent scaffold.

## Beta Disclaimer

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose.

## What Is a Commitment?

A commitment is a Safe controlled by an Optimistic Governor module. The commitment rules are written in plain language (stored onchain or via a URI) and enforced through the Optimistic Governor challenge process. Agents (which can be either AI-driven or deterministic) can interpret onchain and offchain signals and propose valid transactions baed on the commitment's rules.

## Concepts (How It Works)

1. **Rules**: You define plain language rules for what the commitment may do.
2. **Control**: A Safe is deployed and wired to an Optimistic Governor module with those rules.
3. **Proposals**: An agent (or user) proposes transfers via the module and posts the bond.
4. **Challenge Window**: If no one challenges during the period, the proposal can be executed.
5. **Execution**: The Safe executes the approved transfer.

## Repo Layout

- `src/` Solidity contracts
- `script/` Foundry deployment and ops scripts
- `test/` Foundry tests
- `agent/` Offchain agent scaffold
- `frontend/` Web UI for configuring and deploying commitments
- `lib/` External dependencies (Foundry)

## Quick Start (Deploy a Commitment)

1. Install Foundry: https://book.getfoundry.sh/
2. Set required environment variables.
3. Run the deployment script.

```shell
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --private-key <your_private_key>
```

## Required Environment Variables

- `DEPLOYER_PK`: Private key for the deployer.
- `OG_COLLATERAL`: Address of the ERC20 collateral token.
- `OG_BOND_AMOUNT`: Bond amount for challenges.
- `OG_RULES`: Plain language rules for the commitment.

## Alternative Signing Methods

You can avoid storing raw private keys in `.env` by using the agent’s signer helpers and injecting the key at runtime for Forge scripts.

Supported signer types:

- `env`: `PRIVATE_KEY`
- `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
- `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT`
- `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY`
- `kms` / `vault-signer` / `rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (RPC signer that accepts `eth_sendTransaction`)

### Use With Forge Scripts (Deployments + Interactions)

The `agent/with-signer.mjs` helper resolves a signer and injects it as an env var (e.g., `DEPLOYER_PK`, `PROPOSER_PK`, `EXECUTOR_PK`) for any Forge script.

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

For interactions, swap the env var:

```shell
# Propose a transfer with a non-env signer
SIGNER_TYPE=keystore KEYSTORE_PATH=./keys/proposer.json KEYSTORE_PASSWORD=... \
  node agent/with-signer.mjs --env PROPOSER_PK -- \
  forge script script/ProposeCommitmentTransfer.s.sol:ProposeCommitmentTransfer \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast
```

Forge scripts still expect a private key env var, so for KMS/Vault signing without exporting private keys you’ll need an RPC signer proxy that can provide `eth_sendTransaction` (set `SIGNER_RPC_URL` and `SIGNER_ADDRESS`).

## Optional Overrides

- `SAFE_SALT_NONCE`, `SAFE_THRESHOLD`, `SAFE_OWNERS`
- `OG_SALT_NONCE`, `OG_CHALLENGE_PERIOD`, `OG_RULES_URI`
- `OG_MASTER_COPY`, `SAFE_SINGLETON`, `SAFE_FALLBACK_HANDLER`
- `MODULE_PROXY_FACTORY`

## Offchain Agent (Serve a Commitment)

The agent in `agent/` can propose and execute transactions via the Optimistic Governor module. It ships with generic tools; customize the decision logic, signal monitoring, and overall behavior to match your commitment rules.

```shell
cd agent
npm install
cp .env.example .env # fill in RPC_URL, PRIVATE_KEY, COMMITMENT_SAFE, OG_MODULE, WATCH_ASSETS
npm start
```

Built-in tools include:

- `postBondAndPropose`
- `makeDeposit`
- `pollCommitmentChanges`

We will be building a library of agents showcasing different types of commitments, and welcome community contributions!

## Web Frontend

`frontend/` provides a lightweight UI for entering Safe + Optimistic Governor parameters and generating the same deployment flow as the script. It uses the connected wallet to submit transactions.

```shell
cd frontend
npm install
npm run dev
```

Environment overrides are minimal today. The UI supports `MODULE_PROXY_FACTORY` (optionally with `VITE_` or `NEXT_PUBLIC_` prefixes). Other defaults are currently hardcoded in `frontend/src/App.jsx` and can be edited there or wired to env vars.

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

## Common Commands

```shell
forge build
forge test
forge fmt
```

## Local Testing (Anvil)

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
