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

## Deploy the Oya ERC1155 Test Token

Deploy a repo-owned mintable ERC1155 for Sepolia or Anvil:

```shell
DEPLOYER_PK=0xabc123... \
TEST_ERC1155_NAME="Oya Test ERC1155" \
TEST_ERC1155_SYMBOL="OYAT1155" \
TEST_ERC1155_URI="https://example.invalid/oya-test-erc1155/{id}.json" \
forge script script/DeployOyaTestERC1155.s.sol:DeployOyaTestERC1155 \
  --rpc-url <your_rpc_url> \
  --broadcast
```

Optional deploy overrides:

- `TEST_ERC1155_OWNER`: Owner address allowed to mint. Defaults to the deployer address derived from `DEPLOYER_PK`.
- `TEST_ERC1155_NAME`: Display name. Defaults to `Oya Test ERC1155`.
- `TEST_ERC1155_SYMBOL`: Display symbol. Defaults to `OYAT1155`.
- `TEST_ERC1155_URI`: Base ERC1155 metadata URI returned by `uri(id)`. Defaults to `https://example.invalid/oya-test-erc1155/{id}.json`.

Mint a test balance after deployment:

```shell
MINTER_PK=0xabc123... \
TEST_ERC1155_TOKEN=0xYourDeployedToken \
TEST_ERC1155_TO=0xRecipientOrSafe \
TEST_ERC1155_TOKEN_ID=1 \
TEST_ERC1155_AMOUNT=10 \
TEST_ERC1155_DATA=0x \
forge script script/MintOyaTestERC1155.s.sol:MintOyaTestERC1155 \
  --rpc-url <your_rpc_url> \
  --broadcast
```

Mint script inputs:

- `MINTER_PK`: Private key for the token owner. If omitted, the script falls back to `DEPLOYER_PK`.
- `TEST_ERC1155_TOKEN`: Deployed `OyaTestERC1155` contract address.
- `TEST_ERC1155_TO`: Recipient wallet or Safe address.
- `TEST_ERC1155_TOKEN_ID`: ERC1155 token id to mint.
- `TEST_ERC1155_AMOUNT`: Amount to mint for that token id.
- `TEST_ERC1155_DATA`: Optional mint callback data. Defaults to `0x`.
