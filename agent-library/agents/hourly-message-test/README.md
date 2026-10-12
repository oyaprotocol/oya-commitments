# Hourly message test agent

This standalone Compose fixture generates ASCII text, signs it with its own ethers wallet, and posts `{text, signer, signature}` to `http://node:8787/v1/messages`. It sends immediately after startup and starts later requests one hour apart, without overlapping or catching up missed hours. It is not a commitment/registration module and does not use the existing agent runner, an LLM, a Safe, or a governor.

The `init KEY_FILE NODE_CONFIG` command creates the key once and adds its public address to the node allowlist. It accepts only Sepolia and disposable Anvil. Run initialization with the node stopped and private writable files. `run KEY_FILE TIMEOUT_MS` reads the existing key and logs public CIDs/transaction hashes. Any unconfirmed result stops the process without retrying; inspect the node and chain before an explicit restart. Restart begins with an immediate new message. SIGINT/SIGTERM interrupts idle waiting and drains an active HTTP request within its deadline.

Use the [Droplet testing profile](../../../node/production/deploy-droplet.md#optional-hourly-testing-profile) for setup and operation. The matching deployment bundle carries this source; the service mounts it and its key read-only, using the pinned node image's Node.js and ethers dependency.

From repository root, validate with:

```sh
npm --prefix node/production run test:testing -- --verbose
```

The fixture runs `test-agent.test.mjs` inside the runtime image, where ethers is installed, then verifies a real disposable Ledger/IPFS publication. Unit tests check private key reuse, allowlist preservation, exact hourly scheduling, signatures, failed/unknown outcomes, bounded responses, and shutdown. No real testnet funds or credentials are used.
