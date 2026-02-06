## Summary

Describe the change and why it is needed.

## Scope

- [ ] Solidity (`src/`, `script/`, `test/`)
- [ ] Shared agent runner (`agent/`)
- [ ] Agent module(s) (`agent-library/agents/*`)
- [ ] Frontend (`frontend/`)
- [ ] Docs only

## Agent Locality Checks

- [ ] If this PR adds or changes behavior for a specific agent, that behavior is implemented in `agent-library/agents/<agent-name>/`.
- [ ] If shared generalized agent files (`agent/src/lib/*`, `agent/src/index.js`) were modified, this PR includes cross-agent justification.

## Shared Runner Justification

Required when changing shared generalized agent files.

Why was an agent-local implementation insufficient?

Which existing agents are impacted?

## Testing

List commands run and key outcomes.

- [ ] `forge fmt` (if Solidity changed)
- [ ] `forge test` (if Solidity changed)
- [ ] Agent module tests/simulations (if `agent/` or `agent-library/` changed)

## Configuration Impact

Document added/changed env vars, addresses, salts, or deployment assumptions.
