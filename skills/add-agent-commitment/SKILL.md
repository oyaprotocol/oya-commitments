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
- Treat `agent-library/RULE_TEMPLATES.md` as the primary source when drafting `commitment.txt` for a new commitment.
- Do not add single-agent behavior to shared generalized files like `agent/src/index.js` and `agent/src/lib/*`.
- Only change shared runner files for cross-agent infrastructure or shared bug fixes.

## Required Inputs

Collect these before editing:

1. `agent_name` (kebab-case directory name)
2. Applicable rule templates from `agent-library/RULE_TEMPLATES.md` and the filled values needed to use them
3. Any commitment-specific rules that are not covered by the existing templates
4. Behavior constraints (what the agent may and may not do)
5. Metadata inputs needed for `agent.json` (name/description/network pointers and whether `commitmentType` should be `standard` or `freeform`)

## Workflow

1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Review `agent-library/RULE_TEMPLATES.md` and identify which rule templates apply to the commitment.
3. Build `agent-library/agents/<agent-name>/commitment.txt` from those templates, filling placeholders and replacing the copied default rule text.
4. If the commitment needs reusable rule language that is missing from `agent-library/RULE_TEMPLATES.md`, draft a suggested new template title plus body and include that suggestion in your summary or plan.
5. Implement commitment-specific logic in `agent-library/agents/<agent-name>/agent.js`.
6. Update `agent-library/agents/<agent-name>/agent.json`, keeping the top-level ERC-8004 `type` and setting `commitmentType` to `standard` for template-based commitments or `freeform` for legacy/custom rule sets. `standard` is strongly encouraged, especially for production.
7. Add or update module-local test/simulation scripts in that same module folder.
8. Validate with `node agent/scripts/validate-agent.mjs --module=<agent-name>` and module-specific tests/simulations under `agent-library/agents/<agent-name>/`.
9. Summarize changed files, validation commands, and any suggested new shared rule templates.

## Pull Request Expectations

When opening a PR for a new module:

- State that agent-specific behavior is isolated to `agent-library/agents/<agent-name>/`.
- State which rule templates from `agent-library/RULE_TEMPLATES.md` were used to draft `commitment.txt`, and mention any suggested new templates if reusable gaps were found.
- State whether `agent.json` is marked `standard` or `freeform`, and explain any `freeform` choice for a new production-facing commitment.
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
