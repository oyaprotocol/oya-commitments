# First Proxy Agent Migration Notes

This module now expects non-secret runtime config in the agent config stack instead of `.env`.
It implements a deterministic six-hour momentum strategy as an `Agent Proxy`: the agent deposits the winning token into the Safe from its own wallet, then proposes reimbursement transfers out of the Safe.

Minimum required config:

```json
{
  "firstProxy": {
    "tradeAmountUsd": "25",
    "epochSeconds": 21600,
    "daySeconds": 86400,
    "priceFeed": {
      "provider": "alchemy",
      "apiBaseUrl": "https://api.g.alchemy.com/prices/v1",
      "quoteCurrency": "USD",
      "symbols": {
        "WETH": "ETH",
        "cbBTC": "BTC",
        "USDC": "USDC"
      }
    }
  },
  "byChain": {
    "<chainId>": {
      "commitmentSafe": "0x...",
      "ogModule": "0x...",
      "watchAssets": [
        "0x...USDC",
        "0x...WETH",
        "0x...cbBTC"
      ],
      "firstProxy": {
        "tokens": {
          "USDC": "0x...",
          "WETH": "0x...",
          "cbBTC": "0x..."
        }
      }
    }
  }
}
```

Common optional config:
- `watchAssets`
- `watchErc1155Assets`
- `watchNativeBalance`
- `messageApi`
- `ipfsEnabled`
- proposal/dispute toggles and timing fields
- `firstProxy.pendingEpochTtlMs`
- `firstProxy.priceFeed.*`
- `firstProxy.stateFile`
- `firstProxy.tieBreakAssetOrder`

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`
- `WATCH_ERC1155_ASSETS_JSON`
- `WATCH_NATIVE_BALANCE`
- `START_BLOCK`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`
- `MESSAGE_API_*` non-secret fields
- `IPFS_*` non-secret fields

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=first-proxy --chain-id=<chainId>
```

Runtime notes:
- Prices and six-hour momentum are now sourced from Alchemy Prices API, not onchain AMM pools.
- The module uses Alchemy's by-symbol and historical-price endpoints.
- It resolves the Alchemy Prices API key from `ALCHEMY_PRICES_API_KEY`, then `ALCHEMY_API_KEY`, and finally by parsing an Alchemy `rpcUrl`.
- Wrapped testnet assets are intentionally priced against their underlying symbols (`WETH` -> `ETH`, `cbBTC` -> `BTC`) so Sepolia testing does not depend on testnet-token-specific price support.

Secrets stay in `agent/.env`, including signer keys, `OPENAI_API_KEY`, `MESSAGE_API_KEYS_JSON`, and authenticated `IPFS_HEADERS_JSON`.
