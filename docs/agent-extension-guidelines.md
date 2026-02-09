# Agent Extension Guidelines

This document defines where new behavior should be implemented when adding or updating an agent.

## Core Rule

Implement agent-specific behavior in that agent's own files under `agent-library/agents/<agent-name>/`.

Do not place agent-specific logic in shared generalized runner files unless the change is clearly cross-agent.

## Decision Tree

1. Does the behavior apply to exactly one agent?
Yes: implement in `agent-library/agents/<agent-name>/`.
No: continue.
2. Does the behavior represent reusable infrastructure needed by multiple agents?
Yes: implement in shared files (`agent/src/lib/*` or `agent/src/index.js`) with compatibility checks.
No: keep it agent-local.
3. Is this a bug in shared infrastructure affecting multiple agents?
Yes: patch shared code and note impacted modules in the PR.
No: keep it agent-local.

## Allowed Agent-Local Changes

- Prompt logic and tool-choice strategy in a single agent.
- Parsing rules unique to one commitment format.
- Agent-specific scheduling or timelock behavior.
- Agent-specific metadata generation, tests, and fixtures.

## Allowed Shared-Runner Changes

- Common transport/signer/config helpers used by multiple agents.
- Shared proposal/dispute plumbing with no commitment-specific assumptions.
- Defect fixes in existing shared logic that impact more than one agent.

## Anti-Patterns

- Adding `if (agentName === "...")` branches in shared runner code for new behavior.
- Hardcoding commitment-specific policy in `agent/src/lib/`.
- Reusing shared modules as a shortcut for single-agent feature work.

## Pull Request Checklist

- [ ] Agent-specific behavior is implemented in `agent-library/agents/<agent-name>/`.
- [ ] Shared runner files were changed only for cross-agent infrastructure or shared bug fixes.
- [ ] If shared files changed, PR includes:
Rationale for why agent-local implementation was insufficient.
List of existing agents affected.
- [ ] Relevant tests/simulations were run and listed.
