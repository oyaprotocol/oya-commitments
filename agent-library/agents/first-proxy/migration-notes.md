# First Proxy Agent Migration Notes

This module now expects non-secret runtime config in the agent config stack instead of `.env`.
It implements a deterministic six-hour momentum strategy as an `Agent Proxy`: the agent deposits the winning token into the Safe from its own wallet, then proposes reimbursement transfers out of the Safe.

Minimum required config:

```json
{
  "firstProxy": {
    "tradeAmountUsd": "25",
    "epochSeconds": 21600,
    "daySeconds": 86400
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
        },
        "valuationPools": {
          "WETH": {
            "pool": "0x..."
          },
          "cbBTC": {
            "pool": "0x..."
          }
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

Secrets stay in `agent/.env`, including signer keys, `OPENAI_API_KEY`, `MESSAGE_API_KEYS_JSON`, and authenticated `IPFS_HEADERS_JSON`.
