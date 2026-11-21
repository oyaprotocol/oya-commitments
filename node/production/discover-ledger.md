# Find Ledger records to verify

From the repository root, give the command the first and last block numbers (inclusive, in decimal) and your existing [verifier settings](inbox-api.md). For example:

```sh
node node/production/src/discover-ledger.mjs 1000 1099 evidence.json
```

The command prints a JSON array in block and log order. Save one object from the array as `log.json` and run `node node/production/src/verify-ledger.mjs log.json evidence.json` to check its receipt and retrieve its content. Discovery reports candidate locations from your configured RPC. It does not contact IPFS. A matching log may contain unsupported content, and a chain reorganization may invalidate a candidate. An empty array means the RPC returned no matching logs for this query, not proof that history is complete.

Use at most 1,024 mined blocks per query. If the provider refuses a range or the response exceeds the verifier’s 128 KiB limit, divide the range and retry. A failed query exits nonzero without printing partial results. If even a single block exceeds the limit this command cannot enumerate that block. Keep verifier settings private.
