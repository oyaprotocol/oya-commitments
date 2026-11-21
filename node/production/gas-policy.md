# Inspect configured gas limits

With Node.js 24 or newer on macOS or Linux, run from the root of a checkout or extracted release archive containing this command. Select the direct node's or worker's **node config**, not its worker/inbox settings:

```sh
node node/production/scripts/gas-policy.mjs --config "$OYA_LOCAL_DIR/node.json"
node node/production/scripts/gas-policy.mjs --config "$OYA_LOCAL_DIR/node.json" --json
```

To use the installation selected by a [private operator profile](operator-status.md#private-profile), run:

```sh
node node/production/scripts/operator-node.mjs gas-policy --profile "$OYA_LOCAL_DIR/operator.json" --json
```

Omit `--json` for human output. `--profile` overrides `OYA_OPERATOR_PROFILE`; if using the environment selector, scope it to this command. Both entrypoints print the same policy. The profile command opens the private v1 profile (at most 16 KiB) and its `nodeConfig`, resolving relative paths from the profile directory. A worker profile must name its worker config, but gas inspection does not open it or contact `healthUrl`. Invalid arguments or configuration return exit 2 with a sanitized operator diagnostic.

The standalone command reads only the selected regular JSON file (maximum 64 KiB; file symlinks rejected). It needs no npm install, Docker, environment-secret file, Keychain, RPC or IPFS. It writes only its result to stdout, with sanitized errors on stderr. Exit 0 means the projection succeeded; exit 2 means invalid arguments, input or projected settings.

Ledger output reports `gasLimit`, `maxFeePerGasWei`, each field's `default` or `override` origin, and their exact product `executionGasCeilingWei`. JSON uses decimal strings for all quantities and identifies `scope: "offline-config-projection"`. Defaults are 200000 gas and 30000000000 wei/gas (30 gwei), giving 6000000000000000 wei (0.006 native units). An explicitly supplied default value is still an override. Omitted or null `gasLimit` selects the default; null `maxFeePerGasWei` is invalid. IPFS reports `applicable: false` with null caps/product/origins and rejects explicitly present gas fields, including null.

This projects only mode and gas fields. Other settings are ignored: success is **not full runtime config validation**, readiness, or evidence of the policy a running process loaded. The runtime fee parser accepts up to 78 positive decimal digits; transaction preparation additionally requires uint256-compatible values. The exact product is a configured execution-gas ceiling per new transaction, not an actual fee estimate, daily budget, or complete fee bound on every chain.

Default direct and worker logging uses one transaction per message. Opt-in [direct batching](batch-logging.md) applies the caps to the whole batch transaction, not each member. Existing preparation rejects estimates exceeding either cap before signing or broadcasting. Changing the config file takes effect in a runtime only after its normal reload/restart procedure. **Lowering caps below a saved signed transaction can pause reconciliation.** Preserve that checkpoint and resolve it deliberately; inspection never changes limits, restarts services or replaces transactions.

The command, shared module and this guide travel together in release bundles. Older upgrade helpers reject unfamiliar archive entries; use a reviewed helper from a release containing these assets as described in [Verified release upgrades](upgrade-node.md). Balance checks and monitoring are separate integrations.
