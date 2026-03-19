# DCA Agent Migration Notes

This module now expects non-secret runtime config in the agent config stack instead of `.env`.

Minimum required config:

```json
{
  "byChain": {
    "<chainId>": {
      "commitmentSafe": "0x...",
      "ogModule": "0x..."
    }
  }
}
```

Common optional config for this module:
- `startBlock`
- `watchAssets`
- `chainlinkPriceFeed` when you do not want the built-in chain default
- `proposeEnabled`
- `disputeEnabled`

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`
- `START_BLOCK`
- `CHAINLINK_PRICE_FEED`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`
- `DEFAULT_DEPOSIT_*`

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=dca-agent --chain-id=<chainId>
```

Secrets stay in `agent/.env`, including signer keys and `OPENAI_API_KEY`.
