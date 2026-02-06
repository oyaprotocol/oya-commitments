---
name: add-agent-commitment
description: Use when creating a new commitment/agent combo in this repo. Scaffolds a new module under agent-library/agents/<name>, keeps commitment-specific logic local to that module, and validates the module without adding one-off behavior to shared runner files.
---

# Add Agent/Commitment Combo

## When To Use

Use this skill when a user asks to:

- Add a new agent to `agent-library/agents/`
- Add a new commitment-specific behavior
- Create a new commitment + agent module pair for registration/testing

## Repository Rules This Skill Enforces

- Put commitment-specific logic in `agent-library/agents/<agent-name>/`.
- Do not add single-agent behavior to shared generalized files like `agent/src/index.js` and `agent/src/lib/*`.
- Only change shared runner files for cross-agent infrastructure or shared bug fixes.

## Required Inputs

Collect these before editing:

1. `agent_name` (kebab-case directory name)
2. Commitment text/rules for `commitment.txt`
3. Behavior constraints (what the agent may and may not do)
4. Metadata inputs needed for `agent.json` (name/description/network pointers)

## Workflow

1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Update `agent-library/agents/<agent-name>/commitment.txt`.
3. Implement commitment-specific logic in `agent-library/agents/<agent-name>/agent.js`.
4. Update `agent-library/agents/<agent-name>/agent.json`.
5. Add or update module-local test/simulation scripts in that same module folder.
6. Validate with `node agent/scripts/validate-agent.mjs --module=<agent-name>` and module-specific tests/simulations under `agent-library/agents/<agent-name>/`.
7. Summarize changed files and validation commands.

## Pull Request Expectations

When opening a PR for a new module:

- State that agent-specific behavior is isolated to `agent-library/agents/<agent-name>/`.
- If shared runner files were changed, explain why an agent-local implementation was insufficient and list impacted agents.
- Include exact validation commands run.

## Local Setup For Codex And Claude Code

This repository stores the skill at:

- `skills/add-agent-commitment/SKILL.md`

To use it locally, register this folder in your assistant's skills path.

Codex option (symlink into your local skills directory):

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME/skills"
ln -sfn "$(pwd)/skills/add-agent-commitment" "$CODEX_HOME/skills/add-agent-commitment"
```

Claude Code option:

- Add or symlink `skills/add-agent-commitment/` into the skills directory configured in your Claude Code setup.
- If your team uses a shared Claude config path, point that path at this repo skill folder.

After setup, invoke by name (`add-agent-commitment`) or ask to "create a new agent/commitment combo".
