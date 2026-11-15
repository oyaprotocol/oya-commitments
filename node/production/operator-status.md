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

Relative config paths resolve against the profile directory, not the current working directory. Mode, chain, Ledger and operation timeout use the runtime's public settings projection and defaults. The target comes from worker configuration. Runtime startup still validates full configuration, including address checksums and authorization. Status compares public addresses case-insensitively. For direct nodes, set `role` to `direct` and omit `workerConfig`. For IPFS-only mode, omit `nodeAddress` and keep Ethereum settings out of node JSON. Credentials, signing settings and state directories are not accepted in this profile version.

The local port must reach the worker/direct node, not the inbox. Keep its Docker port mapping bound to loopback. A successful identity match is a local observation, not cryptographic attestation: a process controlled by the same host user can impersonate health.

```sh
export OYA_OPERATOR_PROFILE="$OYA_LOCAL_DIR/operator.json"
node node/production/scripts/operator-node.mjs status --json
```

`--profile` overrides the environment selection. JSON always contains `version`, selected public `role`, `mode`, `target`, `chainId`, `ledgerContract`, `nodeAddress`, and observation fields `reachable`, `verified`, `healthy`, `status`, `message`. Inapplicable identity fields are null. Paths, endpoint URLs, arbitrary health fields, job results and exception details are omitted.

## Results and recovery

- Exit **0**: matching direct `ready`/`busy`, or matching worker `idle`/`processing` with a fresh poll.
- Exit **1**: unhealthy, unreachable, malformed, mismatched or unverified observation. Unreachable does **not** prove the process is stopped.
- Exit **2**: invalid arguments, profile permissions or public configuration.

The request, including its body, has one five-second deadline, a 64-KiB response limit and no redirects. Worker polls must be younger than `operationTimeoutMs + 60000` milliseconds. Timestamps more than five seconds ahead are rejected. Check clock synchronization for `future` and worker logs for `stale`, `retrying` or `inbox_unavailable`. Starting, shutting down and explicitly reported stopped states remain distinct. Reconcile a prior transaction for `transaction_outcome_unknown`, or durable batch state for `batch_blocked`, before restarting or retrying work.

Older Ledger workers without public health identity return `legacy_unverified`, exit 1, and upgrade guidance even when reachable. Upgrade to a release containing the additive worker health identity. Legacy direct health without a `role` field is recognized by its direct state/busy schema; an explicit wrong role fails. Existing local-node and runtime APIs remain available.

For releases containing new public files, use the reviewed matching [upgrade helper](upgrade-node.md). Older helpers reject unfamiliar bundle files. Status does not modify installation records or private settings.
