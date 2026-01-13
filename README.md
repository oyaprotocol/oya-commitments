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

## Example `.env`

```ini
# Required
DEPLOYER_PK=0xabc123...
OG_COLLATERAL=0x1111111111111111111111111111111111111111
OG_BOND_AMOUNT=1000000000000000000
OG_RULES="Contributors must submit weekly updates. Funds are releasable after 7 days of no challenge."

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

## Network Env Files

You can keep per-network env files and load them with a tool like `dotenvx` or `direnv`.

Mainnet fork example (`.env.mainnet`):

```ini
MAINNET_RPC_URL=...
DEPLOYER_PK=0x...
OG_COLLATERAL=0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
OG_BOND_AMOUNT=1000000
OG_RULES="Contributors must submit weekly updates. Funds are releasable after 7 days of no challenge."
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
OG_RULES="..."
```

Load the file before running the script:

```shell
dotenvx run -f .env.mainnet -- forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PK
```
