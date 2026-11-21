# Check host node status without a key

Use Node.js 24 or newer on macOS or Linux. From a checkout or an extracted release bundle containing this command:

```sh
node node/production/scripts/operator-node.mjs status --profile "$OYA_LOCAL_DIR/operator.json"
```

Status needs no Docker, host npm installation, environment-secret file, Keychain access, RPC or IPFS connection. It observes the selected local health endpoint; it does not preflight all runtime settings or prove upstream availability.

## Private profile

Keep `operator.json` outside Git in an owned mode-0700 directory, with file mode 0600. Profile and configuration files must be regular files, not symlinks. Start from [operator.example.json](operator.example.json), preserve any existing profile, and replace the public-address placeholder with the dedicated node address recorded at installation. Do not derive it by unlocking a key for status.

Version 1 accepts exactly these fields:

| Field | Meaning |
| --- | --- |
| `version` | Integer `1`. |
| `role` | `worker` or `direct`. |
| `nodeConfig` | Existing public node JSON. |
| `workerConfig` | Existing worker JSON, required only for workers. |
| `healthUrl` | `/healthz` on `127.0.0.1`, `::1`, or `localhost`, using HTTP or HTTPS. No credentials, query or fragment. `localhost` is pinned to `127.0.0.1`. |
| `nodeAddress` | Expected nonzero public Ethereum address, required only in Ledger mode. |
| `balanceRpc` | Optional Ledger RPC URL and authorization for balance queries. See below. |

Relative config paths resolve against the profile directory, not the current working directory. Mode, chain, Ledger and operation timeout use the runtime's public settings projection and defaults. The target comes from worker configuration. Runtime startup still validates full configuration, including address checksums and authorization. Status compares public addresses case-insensitively. For direct nodes, set `role` to `direct` and omit `workerConfig`. For IPFS-only mode, omit `nodeAddress` and keep Ethereum settings out of node JSON. The optional `balanceRpc` field below is for balance queries only. Keep signing keys and runtime credentials out of the profile.

The local port must reach the worker/direct node, not the inbox. Keep its Docker port mapping bound to loopback. A successful identity match is a local observation, not cryptographic attestation: a process controlled by the same host user can impersonate health.

Scope the environment selector to the status command so later upgrade commands retain their saved Compose environment:

```sh
OYA_OPERATOR_PROFILE="$OYA_LOCAL_DIR/operator.json" \
  node node/production/scripts/operator-node.mjs status --json
```

If you previously exported `OYA_OPERATOR_PROFILE`, run `unset OYA_OPERATOR_PROFILE` before upgrading.

`--profile` overrides the environment selection. JSON always contains `version`, selected public `role`, `mode`, `target`, `chainId`, `ledgerContract`, `nodeAddress`, and observation fields `reachable`, `verified`, `healthy`, `status`, `message`. Inapplicable identity fields are null. Paths, endpoint URLs, arbitrary health fields, job results and exception details are omitted.

### Read the native balance

Run `node node/production/scripts/operator-node.mjs balance --profile FILE --json`. For a Ledger installation, set `rpcUrl` explicitly in the selected node JSON. Use HTTPS, or HTTP on loopback. The query checks the chain ID before sending the public node address. It reports exact decimal `balanceWei` and `blockNumber` plus `observedAt` (local UTC observation time). The block is not a finality guarantee.

For an authenticated RPC service, set `balanceRpc` in the private profile to an object containing `url` and `authorization` (the full read-only Authorization header value). The URL must exactly match the configured `rpcUrl`. Do not put the header on the command line. Older operator CLIs reject profiles containing this field; remove it before using an older CLI.

Zero is an observed balance. A timeout, wrong chain or invalid reply returns exit 1 and a null balance. An IPFS installation returns `not_applicable` without contacting RPC. Invalid configuration returns exit 2. The command neither unlocks the node key nor uses the runtime’s authorization header.

For offline gas caps from the same selected installation, use [`gas-policy`](gas-policy.md) instead of `status`.

## Results and recovery

- Exit **0**: matching direct `ready`/`busy`, or matching worker `idle`/`processing` with a fresh poll.
- Exit **1**: unhealthy, unreachable, malformed, mismatched or unverified observation. Unreachable does **not** prove the process is stopped.
- Exit **2**: invalid arguments, profile permissions or public configuration.

The request, including its body, has one five-second deadline, a 64-KiB response limit and no redirects. Worker polls must be younger than `operationTimeoutMs + 60000` milliseconds. Timestamps more than five seconds ahead are rejected. Check clock synchronization for `future` and worker logs for `stale`, `retrying` or `inbox_unavailable`. Starting, shutting down and explicitly reported stopped states remain distinct. Reconcile a prior transaction for `transaction_outcome_unknown`, or durable batch state for `batch_blocked`, before restarting or retrying work.

Older Ledger workers without public health identity return `legacy_unverified`, exit 1, and upgrade guidance even when reachable. Upgrade to a release containing the additive worker health identity. Legacy direct health without a `role` field is recognized by its direct state/busy schema; an explicit wrong role fails. Existing local-node and runtime APIs remain available.

For releases containing new public files, use the reviewed matching [upgrade helper](upgrade-node.md). Older helpers reject unfamiliar bundle files. Status does not modify installation records or private settings.
