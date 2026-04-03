# Agent Library Guidelines

## Scope

This file applies to `agent-library/` and `agent-library/agents/*`.

## Purpose

This directory is the home for agent-specific behavior and commitment-specific decision logic.

## Rules

- Each agent lives under `agent-library/agents/<agent-name>/`.
- Keep commitment logic, prompt strategy, and behavior specialization in that agent's local files.
- When drafting or revising `commitment.txt`, treat `agent-library/RULE_TEMPLATES.md` as the primary source. Reuse and fill existing templates before inventing new rule prose.
- If a new commitment needs a reusable rule pattern that is missing from `agent-library/RULE_TEMPLATES.md`, suggest adding a new template there.
- Prefer adding new modules over branching shared runner code for one-off behavior.

## Locality Rule

When creating a new agent, place functionality in that agent's own files (`agent.js` and adjacent module files). Do not implement single-agent behavior in shared generalized files under `agent/src/lib/` or `agent/src/index.js`.

## Validation

- Run module-specific tests/simulations for the changed agent.
- Document test commands in the PR description.
