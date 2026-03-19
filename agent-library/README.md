# Agent Library

Each agent lives under `agent-library/agents/<agent-name>/` and must include:
- `agent.js`: decision logic and prompt construction.
- `commitment.txt`: plain language commitment that the agent is designed to serve.
- `agent.json`: registration/metadata document for external indexing and ERC-8004 flows.

Optional module-local files:
- `config.json`: non-secret commitment/runtime config for that module.
- `config.local.json`: untracked machine-local overrides layered above `config.json`.
- `harness.mjs`: local testnet harness smoke scenario entrypoint used by `node agent/scripts/testnet-harness.mjs smoke --module=<agent-name>`.
- `test-*.mjs`: module-local validation and smoke scripts.

The runner loads the agent module via `AGENT_MODULE` (agent name) and reads the adjacent `commitment.txt`.

## Building A New Agentic Commitment

Recommended workflow:
1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Write the commitment rules in `commitment.txt`.
3. Implement commitment-specific behavior in `agent.js`.
4. Add `config.json` for non-secret commitment/runtime config:
   - `byChain.<chainId>.commitmentSafe` and `byChain.<chainId>.ogModule` for real deployments
   - `messageApi` when the commitment accepts signed user messages
   - `harness.deployment` and optional `harness.seedErc20Holders` for local/remote smoke flows
5. Add `harness.mjs` when the module needs a custom one-command smoke scenario.
6. Keep secrets in `agent/.env` only: signer keys, bearer/API tokens, `OPENAI_API_KEY`, authenticated `IPFS_HEADERS_JSON`, and similar credentials.
7. Validate the module and run the harness:

```bash
node agent/scripts/validate-agent.mjs --module=<agent-name>
node agent/scripts/testnet-harness.mjs smoke --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs down --module=<agent-name> --profile=local-mock
```

For interactive local debugging instead of one-command smoke:

```bash
node agent/scripts/testnet-harness.mjs up --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs agent-up --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs deposit --module=<agent-name> --profile=local-mock --amount-wei=1000000
node agent/scripts/testnet-harness.mjs message --module=<agent-name> --profile=local-mock --text="Test instruction"
node agent/scripts/testnet-harness.mjs down --module=<agent-name> --profile=local-mock
```

Use `signed-message-smoke` as the simplest reference module for a harness-ready agent with local message ingress.

Example agents:
- `agent-library/agents/default/`: generic agent using the commitment text.
- `agent-library/agents/signed-message-smoke/`: deterministic smoke target for local message API and harness testing.
- `agent-library/agents/timelock-withdraw/`: timelock withdrawal agent that only withdraws to its own address after the timelock.
- `agent-library/agents/copy-trading/`: copy-trading agent for one configured source trader + market; it reacts to BUY trades only, submits a 99%-of-Safe collateral CLOB order from the configured trading wallet, waits for fill/token receipt, deposits YES/NO tokens to the Safe (direct onchain or via Polymarket relayer), then proposes reimbursement to that same trading wallet for the full Safe collateral snapshot captured at trigger time (1% implied agent fee via reduced copy size).
- `agent-library/agents/deterministic-dca-agent/`: deterministic single-active-campaign DCA reimbursement agent that reconstructs campaign state from chain history each run and executes tranches on a fixed schedule.
