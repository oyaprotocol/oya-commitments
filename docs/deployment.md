# Deployment and Configuration

## Deploy a Commitment

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
- `OG_RULES`: Plain-language rules for the commitment.

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
