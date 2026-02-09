# Contributing

This repository uses two kinds of contribution guidance:

- `AGENTS.md` for machine-targeted, normative instructions.
- `README.md` for human-oriented architecture and workflow context.

## Precedence Rules

When instructions conflict:

1. The closest file to the code you are editing wins.
2. `AGENTS.md` is authoritative for agent behavior.
3. Root-level guidance applies when there is no closer override.

## Directory Guidance

- `src/`, `script/`, `test/`: Solidity contracts, scripts, and tests.
- `agent/`: shared offchain runner and reusable agent infrastructure.
- `agent-library/agents/<name>/`: agent-specific implementations.
- `docs/`: operational and architecture docs.

## Required Contributor Workflow

1. Read relevant local docs before editing (`AGENTS.md`, `README.md`).
2. Keep changes scoped to the correct area.
Agent-specific behavior belongs in `agent-library/agents/<name>/`.
Shared runner changes in `agent/` require cross-agent justification.
3. Run the minimum required checks.
Solidity changes: `forge fmt`, `forge test`.
Agent changes: relevant module tests/simulations.
4. In PRs, document:
What changed and why.
Tests run.
Any config or environment variable impacts.

## Agent Extension Policy

New agent behavior must be added to that agent's own library files instead of shared generalized files.

- Preferred location: `agent-library/agents/<agent-name>/agent.js` and related files in that directory.
- Shared files such as `agent/src/lib/*` and `agent/src/index.js` should only change for multi-agent abstractions or shared bug fixes.
- If shared files are changed, the PR must include:
Why an agent-local implementation was insufficient.
Which existing agents are impacted.

See `docs/agent-extension-guidelines.md` for the decision framework and examples.
