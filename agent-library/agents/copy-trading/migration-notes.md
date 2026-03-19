# Copy-Trading Migration Notes

This module now expects non-secret runtime config in the agent config stack instead of `.env`.

Minimum required config:

```json
{
  "byChain": {
    "<chainId>": {
      "commitmentSafe": "0x...",
      "ogModule": "0x...",
      "copyTrading": {
        "sourceUser": "0x...",
        "market": "market-slug-or-id",
        "yesTokenId": "123",
        "noTokenId": "456"
      }
    }
  }
}
```

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`
- `START_BLOCK`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`
- `POLYMARKET_CONDITIONAL_TOKENS`
- `POLYMARKET_EXCHANGE`
- `POLYMARKET_CLOB_ENABLED`
- `POLYMARKET_CLOB_HOST`
- `POLYMARKET_CLOB_ADDRESS`
- `POLYMARKET_CLOB_SIGNATURE_TYPE`
- `POLYMARKET_RELAYER_*`
- `UNISWAP_V3_*`
- `MESSAGE_API_*` non-secret fields
- `COPY_TRADING_SOURCE_USER`
- `COPY_TRADING_MARKET`
- `COPY_TRADING_YES_TOKEN_ID`
- `COPY_TRADING_NO_TOKEN_ID`
- `COPY_TRADING_COLLATERAL_TOKEN`
- `COPY_TRADING_CTF_CONTRACT`

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=copy-trading --chain-id=<chainId>
```

Secrets stay in `agent/.env`:
- signer keys
- `OPENAI_API_KEY`
- `POLYMARKET_CLOB_API_*`
- `POLYMARKET_API_*`
- `POLYMARKET_BUILDER_*`
- `MESSAGE_API_KEYS_JSON`
- authenticated `IPFS_HEADERS_JSON`
