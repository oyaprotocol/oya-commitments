# Agent Library

Each agent lives under `agent-library/agents/<agent-name>/` and must include:
- `agent.js`: decision logic and prompt construction.
- `commitment.txt`: plain language commitment that the agent is designed to serve.

The runner loads the agent module via `AGENT_MODULE` (agent name) and reads the adjacent `commitment.txt`.

To add a new agent:
1. Copy `agent-library/agents/default/` to a new folder.
2. Update `agent.js` and `commitment.txt`.
3. Set `AGENT_MODULE=<agent-name>`.

Example agents:
- `agent-library/agents/default/`: generic agent using the commitment text.
- `agent-library/agents/timelock-withdraw/`: timelock withdrawal agent that only withdraws to its own address after the timelock.
