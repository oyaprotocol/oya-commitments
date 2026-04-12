# Agent Library

Each agent lives under `agent-library/agents/<agent-name>/` and must include:
- `agent.js`: decision logic and prompt construction.
- `commitment.txt`: plain language commitment that the agent is designed to serve. For new commitments, this should usually be assembled from `agent-library/RULE_TEMPLATES.md` plus any truly commitment-specific rules.
- `agent.json`: registration/metadata document for external indexing and ERC-8004 flows. Keep the top-level `type` as the ERC-8004 document type, and set `commitmentType` to `standard` or `freeform` to classify the rule set. `standard` is strongly encouraged for new commitments, especially for production.

Optional module-local files:
- `config.json`: non-secret commitment/runtime config for that module.
- `config.local.json`: untracked machine-local overrides layered above `config.json`.
- `migration-notes.md`: module-local notes for moving legacy non-secret env config into the config stack.
- `harness.mjs`: local testnet harness smoke scenario entrypoint used by `node agent/scripts/testnet-harness.mjs smoke --module=<agent-name>`.
- `test-*.mjs`: module-local validation and smoke scripts.

The runner loads the agent module via `AGENT_MODULE` (agent name) and reads the adjacent `commitment.txt`.

## Building A New Agentic Commitment

Recommended workflow:
1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Review `agent-library/RULE_TEMPLATES.md` and identify the rule templates that apply to the new commitment.
3. Replace the copied `commitment.txt` contents with rules assembled from those templates. Fill each `[ ]` placeholder with commitment-specific values, add custom rules only for behavior not covered by the shared templates, and note any reusable missing rule patterns as candidate additions to `agent-library/RULE_TEMPLATES.md`.
4. Update `agent.json`. Keep its top-level `type` unchanged, and set `commitmentType` to `standard` for template-based commitments. Use `freeform` only for legacy or intentionally custom rule sets.
5. Implement commitment-specific behavior in `agent.js`.
6. Add `config.json` for non-secret commitment/runtime config:
   - `byChain.<chainId>.commitmentSafe` and `byChain.<chainId>.ogModule` for real deployments
   - `messageApi` when the commitment accepts signed user messages
   - `messagePublishApi` when the agent or its companion node archives signed agent-authored messages to IPFS
   - `harness.deployment` and optional `harness.seedErc20Holders` for local/remote smoke flows
7. Add `harness.mjs` when the module needs a custom one-command smoke scenario.
8. Keep secrets in `agent/.env` only: signer keys, bearer/API tokens, `OPENAI_API_KEY`, authenticated `IPFS_HEADERS_JSON`, and similar credentials.
9. Validate the module and run the harness:

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

The default module's `commitment.txt` is a minimal standard starter example copied by step 1. It currently assembles the `Agent Proxy` and `Account Recovery and Rule Updates` templates with obvious placeholder values. Replace or extend that starter with the templates and values selected for the actual commitment you are creating.

The copied default `agent.json` starts with `commitmentType: "standard"` because the default starter is template-based. Change that field to `freeform` only if you intentionally move away from the shared rule-template approach.

Example agents:
- `agent-library/agents/default/`: generic standard starter using the commitment text, with `Agent Proxy` plus `Account Recovery and Rule Updates` as the initial scaffold.
- `agent-library/agents/signed-message-smoke/`: deterministic smoke target for local message API and harness testing.
- `agent-library/agents/timelock-withdraw/`: timelock withdrawal agent that only withdraws to its own address after the timelock.
- `agent-library/agents/copy-trading/`: copy-trading agent for one configured source trader + market; it reacts to BUY trades only, submits a 99%-of-Safe collateral CLOB order from the configured trading wallet, waits for fill/token receipt, deposits YES/NO tokens to the Safe (direct onchain or via Polymarket relayer), then proposes reimbursement to that same trading wallet for the full Safe collateral snapshot captured at trigger time (1% implied agent fee via reduced copy size).
- `agent-library/agents/deterministic-dca-agent/`: deterministic single-active-campaign DCA reimbursement agent that reconstructs campaign state from chain history each run and executes tranches on a fixed schedule.
