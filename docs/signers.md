# Signers and Key Management

You can avoid storing raw private keys in `.env` by using the agent’s signer helper and injecting the key at runtime for Forge scripts.

## Supported Signer Types

- `env`: `PRIVATE_KEY`
- `keystore`: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`
- `keychain`: `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT`
- `vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH`, optional `VAULT_SECRET_KEY`
- `kms` / `vault-signer` / `rpc`: `SIGNER_RPC_URL`, `SIGNER_ADDRESS` (RPC signer that accepts `eth_sendTransaction`)

## Use With Forge Scripts

Install the [runner dependencies](../agent/README.md#configure) and configure an `env`, `keystore`, `keychain`, or `vault` signer as described above. From the repository root, check that the helper passes a nonempty key to its child process:

```sh
node agent/with-signer.mjs --env DEPLOYER_PK -- node -e 'process.exitCode = process.env.DEPLOYER_PK ? 0 : 1'
```

The check exits silently on success. It does not print the key, verify the signer address, or submit a transaction.

When ready to deploy, follow the [commitment deployment guide](deployment.md#deploy-a-commitment) to choose the chain and Safe owners. Replace the command after `--` with the intended Forge command or wrapper. Set `--env` to the variable that script reads, such as `DEPLOYER_PK`, `PROPOSER_PK`, or `EXECUTOR_PK`.

RPC signers (`kms`, `vault-signer`, and `rpc`) sign remotely for the agent. They cannot supply a private key to `with-signer.mjs`.
