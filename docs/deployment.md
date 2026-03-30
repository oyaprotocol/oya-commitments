# Deployment and Configuration

## Deploy a Commitment

```shell
ENV_FILE=agent/.env \
bash script/deploy-commitment.sh
```

The standard deployment path now keeps the deployer as the Safe's sole owner. That gives you a testing window where the deployer can still execute direct Safe owner-management changes before finalizing ownership.

Owner modes:

- Omit `--owners`: final Safe owner is the deployer address.
- Pass `--owners 0x`: final Safe owner is `0x000000000000000000000000000000000000dEaD`.
- Pass `--owners <a>,<b>,<c>`: final Safe owners are exactly those addresses with threshold `3`.

Examples:

```shell
# Default testing posture: deployer remains the sole owner
ENV_FILE=agent/.env \
bash script/deploy-commitment.sh

# Immediately remove all human owners
ENV_FILE=agent/.env \
bash script/deploy-commitment.sh --owners 0x

# Finalize directly to a 2/2 or 3/3 Safe
ENV_FILE=agent/.env \
bash script/deploy-commitment.sh --owners 0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222
```

## Required Environment Variables

- `DEPLOYER_PK`: Private key for the deployer.
- `RPC_URL` or `SEPOLIA_RPC_URL`: RPC used by the wrapper unless you pass `--rpc-url` through to Forge yourself.
- `OG_COLLATERAL`: Address of the ERC20 collateral token.
- `OG_BOND_AMOUNT`: Bond amount for challenges.
- `OG_RULES`: Plain-language rules for the commitment.

## Optional Overrides

- `SAFE_SALT_NONCE`, `SAFE_OWNERS`
- `OG_SALT_NONCE`, `OG_LIVENESS`, `OG_IDENTIFIER_STR`
- `OG_MASTER_COPY`, `SAFE_SINGLETON`, `SAFE_FALLBACK_HANDLER`
- `MODULE_PROXY_FACTORY`

## Example `.env`

```ini
# Required
DEPLOYER_PK=0xabc123...
OG_COLLATERAL=0x1111111111111111111111111111111111111111
OG_BOND_AMOUNT=250000000
OG_RULES="Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."
RPC_URL=https://sepolia.infura.io/v3/your-key

# Safe overrides
SAFE_SALT_NONCE=12345

# Optimistic Governor overrides
OG_LIVENESS=604800
OG_IDENTIFIER_STR=ASSERT_TRUTH
OG_SALT_NONCE=67890

# Optional factory / master copy overrides
MODULE_PROXY_FACTORY=0x4444444444444444444444444444444444444444
OG_MASTER_COPY=0x5555555555555555555555555555555555555555
SAFE_SINGLETON=0x6666666666666666666666666666666666666666
SAFE_FALLBACK_HANDLER=0x7777777777777777777777777777777777777777
```

`SAFE_OWNERS` is still supported for direct Forge usage, but the recommended operator UX is to pass `--owners` to the wrapper scripts.

## Change Safe Owners Later

While the deployer still controls the Safe with threshold `1`, you can change the final owner set from the command line:

```shell
# Restore or keep deployer-only ownership
ENV_FILE=agent/.env \
bash script/set-safe-owners.sh --safe 0xYourSafe

# Rotate to the dead-address posture
ENV_FILE=agent/.env \
bash script/set-safe-owners.sh --safe 0xYourSafe --owners 0x

# Add stakeholder owners and finalize to N/N
ENV_FILE=agent/.env \
bash script/add-safe-owners.sh --safe 0xYourSafe --owners 0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222

# Remove one or more owners; if none remain, the Safe is rotated to the dead address
ENV_FILE=agent/.env \
bash script/remove-safe-owners.sh --safe 0xYourSafe --owners 0x1111111111111111111111111111111111111111
```

Important limitation:

- These scripts use only `DEPLOYER_PK` to sign the Safe transaction, so they are intended for the phase where the deployer still satisfies the Safe threshold alone.
- Once you finalize to a multi-owner `N/N` Safe that the deployer cannot satisfy unilaterally, future owner changes must be executed by the Safe owners together or through the Optimistic Governor path.

## Direct Forge Usage

If you prefer to call Forge directly instead of the wrapper, set `SAFE_OWNERS` yourself:

```shell
# Default deployer-owner posture
DEPLOYER_PK=0xabc123... \
OG_COLLATERAL=0x1111111111111111111111111111111111111111 \
OG_BOND_AMOUNT=250000000 \
OG_RULES="..." \
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast

# Dead-address posture
DEPLOYER_PK=0xabc123... \
SAFE_OWNERS=0x \
OG_COLLATERAL=0x1111111111111111111111111111111111111111 \
OG_BOND_AMOUNT=250000000 \
OG_RULES="..." \
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast

# Explicit owner set
DEPLOYER_PK=0xabc123... \
SAFE_OWNERS=0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222 \
OG_COLLATERAL=0x1111111111111111111111111111111111111111 \
OG_BOND_AMOUNT=250000000 \
OG_RULES="..." \
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast
```

## Local Testing (Anvil)

Dry-run (no broadcast):

```shell
anvil
RPC_URL=http://127.0.0.1:8545 \
DEPLOYER_PK=0x<your_private_key> \
OG_COLLATERAL=0x<collateral> \
OG_BOND_AMOUNT=1 \
OG_RULES="Testing rules" \
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url http://127.0.0.1:8545
```

Broadcast on Anvil:

```shell
anvil
RPC_URL=http://127.0.0.1:8545 \
DEPLOYER_PK=0x<your_private_key> \
OG_COLLATERAL=0x<collateral> \
OG_BOND_AMOUNT=1 \
OG_RULES="Testing rules" \
bash script/deploy-commitment.sh --owners 0x
```

## Deploy the Oya ERC1155 Test Token

Deploy a repo-owned mintable ERC1155 for Sepolia or Anvil.

The recommended CLI path now uses the wrapper script below. It reads `RPC_URL` first, then falls back to `SEPOLIA_RPC_URL`, and always requires `DEPLOYER_PK`. It does not implicitly consume `MAINNET_RPC_URL`. If `ETHERSCAN_API_KEY` is set, it also verifies the deployment on Etherscan after broadcast; otherwise it deploys without verification.

Deploy only:

```shell
ENV_FILE=agent/.env \
TEST_ERC1155_NAME="Oya Test ERC1155" \
TEST_ERC1155_SYMBOL="OYAT1155" \
TEST_ERC1155_URI="https://example.invalid/oya-test-erc1155/{id}.json" \
bash script/deploy-oya-test-erc1155.sh
```

Deploy and verify:

```shell
ENV_FILE=agent/.env \
ETHERSCAN_API_KEY=your_etherscan_api_key \
TEST_ERC1155_NAME="Oya Test ERC1155" \
TEST_ERC1155_SYMBOL="OYAT1155" \
TEST_ERC1155_URI="https://example.invalid/oya-test-erc1155/{id}.json" \
bash script/deploy-oya-test-erc1155.sh
```

Optional deploy overrides:

- `ENV_FILE`: Optional env file to source before deployment, for example `agent/.env`.
- `ETHERSCAN_API_KEY`: Optional. If set, the wrapper verifies on Etherscan after broadcast.
- `CHAIN`: Optional chain name or chain id passed to Forge verification. Defaults to `sepolia` when verification is enabled.
- `TEST_ERC1155_OWNER`: Owner address allowed to mint. Defaults to the deployer address derived from `DEPLOYER_PK`.
- `TEST_ERC1155_NAME`: Display name. Defaults to `Oya Test ERC1155`.
- `TEST_ERC1155_SYMBOL`: Display symbol. Defaults to `OYAT1155`.
- `TEST_ERC1155_URI`: Base ERC1155 metadata URI returned by `uri(id)`. Defaults to `https://example.invalid/oya-test-erc1155/{id}.json`.

If you prefer to call Forge directly instead of the wrapper, include verification flags explicitly:

```shell
DEPLOYER_PK=0xabc123... \
ETHERSCAN_API_KEY=your_etherscan_api_key \
TEST_ERC1155_NAME="Oya Test ERC1155" \
TEST_ERC1155_SYMBOL="OYAT1155" \
TEST_ERC1155_URI="https://example.invalid/oya-test-erc1155/{id}.json" \
forge script script/DeployOyaTestERC1155.s.sol:DeployOyaTestERC1155 \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --verify \
  --chain sepolia \
  --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
```

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
