# Oya production node

This standalone runtime accepts an agent's signed text, publishes the signed JSON to IPFS, and submits its CID to Logger using the node's own account. A `200` response includes the CID, transaction hash, block number, and node address after the kernel verifies a successful receipt and the matching Logger event.

After signature and allowlist checks, the HTTP handler calls the kernel's `publishAndLogSignedMessage` directly. One complete operation runs at a time, from IPFS publication through the verified receipt. Additional authenticated requests receive `503 node_busy`; there is no waiting queue.

The runtime installs the four hardened `@oyaprotocol` kernels from npm at version `0.1.1` and uses ethers in `src/signer.mjs` for local transaction signing. The kernels handle publication, transaction preparation, broadcasting, and receipt verification. Kernel signing support remains future work. Reimbursement verification, Safe proposals, and DeFi actions are later integrations.

## Install and validate

Use Node 22 or newer, npm, Foundry, and Kubo/IPFS for the local smoke. From the repository root:

```sh
git submodule update --init lib/forge-std
npm --prefix node/production ci
npm --prefix node/production test
forge build --root contracts --sizes
forge test --root contracts --offline -vv
npm --prefix node/production run smoke:local
```

The smoke starts isolated Anvil and offline Kubo processes on loopback ports, deploys Logger through `contracts/script/DeployLogger.s.sol`, and exercises real signed HTTP requests. It retrieves each published envelope and checks the mined Logger event, rejects invalid signatures, and rejects startup on a wrong chain or missing contract. With automining disabled, it checks busy rejection while exactly one transaction is pending. After mining, the rejected request succeeds; repeating an earlier completed message creates a separate Logger event with the same CID. The smoke also starts the actual node CLI and verifies its health and signing address. It stops its services when finished and prints a temporary directory containing `evidence.json` and service logs.

Host tests cover failure, deadline, client-disconnect, and shutdown behavior using controlled transports, including proof that rejected requests invoke no publication or signing work. The real smoke checks that busy rejection submits no second transaction. All smoke accounts and gas balances are generated for its disposable local chain.

To leave a working local stack running:

```sh
npm --prefix node/production run smoke:local -- --keep-running
```

This prints the actual node URL, RPC URL, IPFS URL, Logger address, and temporary artifact directory. That directory contains `config.json` and a `.env` with generated local node and agent keys, written with mode `0600`; the keys are not printed. The local chain is disposable, and offline Kubo makes content available through its local API only. Press Ctrl-C to stop all three services. For deployment-script details, see [`contracts/README.md`](../../contracts/README.md).

## Configure and start

Prepare dependencies and private configuration templates from the repository root:

```sh
npm --prefix node/production run local -- setup
```

Setup installs the host and published kernels from `node/production/package-lock.json` and creates missing `config.local.json` and `.env` files with mode `0600`. No kernel source build or TypeScript installation is needed. Repeating it preserves existing files and their permissions. It uses Node.js built-ins and needs Node 22 or newer and npm; it does not deploy Logger or start services. Template addresses and empty keys must be filled before use. For different file locations, add `--config /absolute/path/to/node.json --env-file /absolute/path/to/node.env`; parent directories must already exist. Relative paths resolve from the directory where you invoked the command. Keep custom files outside the checkout or ignore them in Git.

Edit the ignored `config.local.json` (or copy `config.example.json` there when configuring manually). Replace the example Logger and agent addresses with your deployment and allowlisted signer addresses. Set `chainId`, `rpcUrl`, and `ipfsUrl` for the intended environment. `ipfsUrl` must be a Kubo-compatible API, with `/api/v0/add` support; a read-only gateway or unrelated pinning API is insufficient.

The node account must have gas funds and be dedicated to one runtime. The agent signing key is distinct; it does not need gas to sign a message. Store `OYA_NODE_PRIVATE_KEY` in the ignored `node/production/.env`, or inject it through your process supervisor. Optional `OYA_RPC_AUTHORIZATION` and `OYA_IPFS_AUTHORIZATION` contain complete HTTP Authorization header values. Keep RPC URLs containing credentials in private local config too.

Check the configuration and services from the repository root:

```sh
npm --prefix node/production run local -- check
```

Check accepts the same `--config` and `--env-file` overrides as setup. The selected environment file must be readable; it may be empty when credentials are injected. Its values override inherited environment values, including explicitly empty values; omitted entries use the inherited environment. This command requires `host` to be `127.0.0.1` or `::1` and uses the existing config validator and node signer.

The command checks the Ethereum chain ID, nonempty code at the Logger address, a positive native-currency balance for the node, and the Kubo `/api/v0/version` endpoint, in that order. Each probe has a 10-second deadline, including response reading and any RPC retries. It prints public addresses and an `OK` for each passing probe, exits 0 when all pass, or stops with a sanitized `FAIL` and exit 1 at the first failure. It submits no transactions, uploads no content, and changes no files. Code presence does not verify Logger's implementation, a positive balance does not guarantee sufficient gas for a particular transaction, and the IPFS probe does not prove publication permissions.

To start the runtime directly:

```sh
node --env-file=node/production/.env node/production/src/main.mjs node/production/config.local.json
curl http://127.0.0.1:8787/healthz
```

The direct Node.js `--env-file` command gives inherited variables precedence; clear conflicting inherited Oya values when using it after `local check`. The planned `local run` command will use the same file precedence as `check`.

Alternatively, with environment variables already loaded:

```sh
npm --prefix node/production start -- /absolute/path/to/config.json
```

Startup checks the RPC chain and deployed Logger bytecode before serving traffic. Configuration rejects unsupported fields. There is no state directory, publication journal, process lock, or startup replay.

`host` defaults to `127.0.0.1`, and `port` to `8787`. To host it remotely, choose the binding explicitly and provide HTTPS through your hosting environment. Other optional settings are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxBodyBytes` | 16,384 | Maximum HTTP request body size. |
| `maxTextBytes` | 8,192 | Maximum signed text size. |
| `bodyTimeoutMs` | 10,000 | Deadline for reading the request body. |
| `receiptTimeoutMs` | 60,000 | Deadline for observing a transaction receipt. |
| `operationTimeoutMs` | 180,000 | Overall deadline for the combined publication and logging operation. |
| `pollIntervalMs` | 1,000 | Interval between receipt polls. |
| `gasLimit` | 200,000 | Maximum transaction gas limit. |
| `maxFeePerGasWei` | `"30000000000"` | Maximum fee per gas, as a decimal string. |

Gas and fee values are ceilings; requests above them stop before signing. Transport attempts have a 10-second timeout and up to two kernel-managed retries. Transaction preparation has the kernel's 30-second deadline. The overall operation deadline bounds all stages together, including those retries; the host does not retry the complete operation.

## Submit a message

`POST /v1/messages` accepts `Content-Type: application/json` and exactly:

```json
{ "text": "Your exact ASCII message", "signer": "0x...", "signature": "0x..." }
```

The signature must be EIP-191 over exactly `text`; the signer must be in `allowedSigners`. The node caps bytes while reading the HTTP stream, and the kernel validates JSON, message size, schema, signature, and authorization before publication. The signed text should contain any context that its readers need; this first runtime does not interpret commitment-specific fields.

Put ASCII text in a file, load the agent's key as `OYA_AGENT_PRIVATE_KEY`, and run:

```sh
node --env-file=node/production/.env node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt
```

The script signs the complete file, including any final newline. A successful response looks like:

```json
{
  "status": "logged",
  "signer": "0x...",
  "publication": {
    "status": "logged",
    "cid": "bafk...",
    "uri": "ipfs://bafk...",
    "transactionHash": "0x...",
    "blockNumber": "2",
    "nodeAddress": "0x...",
    "loggerContract": "0x..."
  }
}
```

Retrieve the original signed JSON with `ipfs cat <cid>` against the relevant Kubo repository, or `POST <ipfsUrl>/api/v0/cat?arg=<cid>`. Logger's indexed node address identifies the node transaction signer, while the JSON retains the agent's separate signature.

## Results, retries, and shutdown

Every admitted valid request is an independent operation. Repeating the same signed envelope can return the same IPFS CID while producing a new Logger transaction and another gas charge. There is no durable deduplication, exactly-once guarantee, or automatic restart recovery. Even a previously completed message receives `node_busy` while another operation is active.

| HTTP result | Meaning |
| --- | --- |
| `200`, `status: "logged"` | IPFS publication and successful mined Logger execution were verified. |
| `503 node_busy` | Another operation is active. This request did not start; retry later using `Retry-After: 5`. |
| `503 shutting_down` | The node is draining. This request did not start. |
| `503 transaction_outcome_unknown` | An earlier transaction outcome is unresolved; the node is unavailable pending operator reconciliation. |
| `502 publication_failed` | An upstream publication or logging step failed; inspect the outcome and available CID/hash. |
| `504 operation_timeout` or `504 receipt_timeout` | The overall operation or receipt deadline elapsed; effects may already have occurred. |
| `500 internal_error` | An unexpected fault occurred; a started operation with an unknown outcome blocks further work. |

Validation errors retain their HTTP statuses, including `401` for invalid signatures, `403` for disallowed signers, and `413` for oversized requests. These requests cause no publication or signing. Signature and allowlist checks also run when the node is busy or unavailable.

Busy, shutdown, and unavailable rejections include `started: false`. Attempted failures include `started: true` and `loggingOutcome`, with a partial `publication` containing any known CID, URI, transaction hash, and mined block number:

- `not_submitted`: No Logger transaction was submitted. IPFS publication may still have occurred. The node can accept another operation.
- `failed`: A validated mined receipt was observed, but execution reverted or Logger verification failed. The nonce was consumed, so the node can accept another operation.
- `unknown`: The node cannot establish the logging outcome. A known transaction hash is not proof of acceptance or mining. Further authenticated requests receive `503 transaction_outcome_unknown` with no automatic retry advice.

An HTTP failure or lost connection cannot undo IPFS publication or transaction submission. Inspect the returned identifiers and the node account on the configured chain before retrying attempted work. For an unknown outcome, reconcile the transaction externally and deliberately restart only once it is resolved. Restart loses the in-memory unavailable flag; it does not reconcile transactions or recover a lost response. The signing account must be used exclusively by this one process, including across restarts.

`GET /healthz` returns `200` with `status: "ready"` or `"busy"`, or `503` with `"transaction_outcome_unknown"` or `"shutting_down"`. It includes `busy`, chain ID, Logger address, and node address. It describes local lifecycle state and does not continuously probe RPC or IPFS.

A disconnected client does not cancel an admitted operation or release its guard. The operation finishes or reaches its deadline, and the node emits a sanitized `message_result` log containing its final public result. SIGINT/SIGTERM stops admission and waits for active work, including work whose client disconnected. Logs never include raw provider errors or signed transaction bytes; the host persists no intermediate progress.

A successful response confirms mined execution as reported by the configured RPC, without additional confirmation depth or protection against later chain reorganizations. IPFS content is public once published, including the signed text. Logger records CID claims; consumers still verify retrieved content and the agent signature.
