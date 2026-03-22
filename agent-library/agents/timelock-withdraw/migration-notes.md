# Timelock-Withdraw Migration Notes

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
- `watchNativeBalance`
- `startBlock`
- `proposeEnabled`
- `disputeEnabled`

Legacy non-secret env vars to migrate:
- `COMMITMENT_SAFE`
- `OG_MODULE`
- `WATCH_ASSETS`
- `WATCH_NATIVE_BALANCE`
- `START_BLOCK`
- `PROPOSE_ENABLED`
- `DISPUTE_ENABLED`

One-time helper:

```bash
node agent/scripts/migrate-agent-config-from-env.mjs --module=timelock-withdraw --chain-id=<chainId>
```

Secrets stay in `agent/.env`, including signer keys and `OPENAI_API_KEY`.
