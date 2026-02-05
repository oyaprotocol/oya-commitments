# Signers and Key Management

You can avoid storing raw private keys in `.env` by using the agent’s signer helper and injecting the key at runtime for Forge scripts.

## Supported Signer Types

- `env`: `PRIVATE_KEY`
- `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
- `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT`
- `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY`
- `kms` / `vault-signer` / `rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (RPC signer that accepts `eth_sendTransaction`)

## Use With Forge Scripts

The `agent/with-signer.mjs` helper resolves a signer and injects it as an env var (for example `DEPLOYER_PK`, `PROPOSER_PK`, `EXECUTOR_PK`) for any Forge script.

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
SIGNER_TYPE=keystore KEYSTORE_PATH=./keys/proposer.json KEYSTORE_PASSWORD=... \
  node agent/with-signer.mjs --env PROPOSER_PK -- \
  forge script script/ProposeCommitmentTransfer.s.sol:ProposeCommitmentTransfer \
    --rpc-url $MAINNET_RPC_URL \
    --broadcast
```

Forge scripts still expect a private key env var. For KMS/Vault signing without exporting private keys, use an RPC signer proxy that supports `eth_sendTransaction` (set `SIGNER_RPC_URL` and `SIGNER_ADDRESS`).
