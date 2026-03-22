# Deterministic DCA Agent Migration Notes

This module now expects non-secret runtime config in the agent config stack instead of `.env`.

Minimum required config:

```json
{
  "deterministicDcaPolicyPreset": "testnet",
  "byChain": {
    "<chainId>": {
      "commitmentSafe": "0x...",
      "ogModule": "0x..."
    }
  }
}
```

Common optional config for this module:
- `deterministicDcaLogChunkSize`
- `startBlock`
- `watchAssets`
- `chainlinkPriceFeed`
- `proposeEnabled`
- `disputeEnabled`

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `START_BLOCK`
- `WATCH_ASSETS`
- `CHAINLINK_PRICE_FEED`
- `DETERMINISTIC_DCA_POLICY_PRESET`
- `DETERMINISTIC_DCA_LOG_CHUNK_SIZE`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=deterministic-dca-agent --chain-id=<chainId>
```

Secrets stay in `agent/.env`, including signer keys and `OPENAI_API_KEY`.
