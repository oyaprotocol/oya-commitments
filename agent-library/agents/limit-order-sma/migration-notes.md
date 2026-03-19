# Limit-Order SMA Migration Notes

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
- `watchAssets`
- `uniswapV3Factory`
- `uniswapV3Quoter`
- `uniswapV3FeeTiers`
- `startBlock`

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`
- `START_BLOCK`
- `UNISWAP_V3_FACTORY`
- `UNISWAP_V3_QUOTER`
- `UNISWAP_V3_FEE_TIERS`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=limit-order-sma --chain-id=<chainId>
```

Secrets stay in `agent/.env`, including signer keys, `OPENAI_API_KEY`, and `COINGECKO_API_KEY`.
