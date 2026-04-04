# First Proxy Agent Migration Notes

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

Common optional config:
- `watchAssets`
- `watchErc1155Assets`
- `watchNativeBalance`
- `messageApi`
- `ipfsEnabled`
- proposal/dispute toggles and timing fields

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
