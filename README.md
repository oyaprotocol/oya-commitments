# Oya Commitments

Oya Commitments are Safe-based commitments controlled by plain-language rules and enforced via an Optimistic Governor module. This repo contains the Solidity contracts, deployment scripts, an optional web UI, and an offchain agent scaffold.

## Beta Disclaimer

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose.

## How It Works (At a Glance)

- Write plain-language rules that define what the commitment may do.
- Deploy a Safe wired to an Optimistic Governor module with those rules.
- An agent or user proposes transactions via the module and posts a bond.
- If no challenge occurs during the window, the proposal is executed by the Safe.

## Quick Start

1. Install Foundry: https://book.getfoundry.sh/
2. Set required environment variables (see `docs/deployment.md`).
3. Run the deployment script:

```shell
ENV_FILE=agent/.env \
bash script/deploy-commitment.sh
```

By default this leaves the deployer as the Safe's sole owner so you can do a testing phase before finalizing ownership. Pass `--owners 0x` to remove all human owners immediately, or `--owners <a>,<b>,<c>` to finalize an `N/N` Safe.

## Build An Agentic Commitment

The fastest path to a new commitment/agent combo is:
1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Review `agent-library/RULE_TEMPLATES.md` and select the rule templates that apply to the new commitment.
3. Assemble `agent-library/agents/<agent-name>/commitment.txt` from those templates, filling the placeholders and replacing the copied default rule text. If a reusable rule pattern is missing, suggest a new template for `agent-library/RULE_TEMPLATES.md`.
4. Set `agent-library/agents/<agent-name>/agent.json` `commitmentType` to `standard` for template-based commitments. Use `freeform` only for legacy or intentionally custom rule sets. Keep the existing top-level `type` field reserved for the ERC-8004 document type. `standard` is strongly encouraged, especially for production commitments.
5. Implement commitment-specific behavior in `agent-library/agents/<agent-name>/agent.js`.
6. Put non-secret runtime settings in `agent-library/agents/<agent-name>/config.json`.
7. Keep only secrets in `agent/.env`.
8. Validate and smoke test locally:

```bash
node agent/scripts/validate-agent.mjs --module=<agent-name>
node agent/scripts/testnet-harness.mjs smoke --module=<agent-name> --profile=local-mock
node agent/scripts/testnet-harness.mjs down --module=<agent-name> --profile=local-mock
```

The detailed workflow for module structure, `config.json`, and local/remote harness profiles is in `agent/README.md` and `agent-library/README.md`.

The copied `default` module now starts as a minimal standard scaffold using the `Agent Proxy` and `Account Recovery and Rule Updates` templates. Treat it as a starter to customize, not as the final rules for a new commitment.

## Documentation

- Contribution workflow and policy: `CONTRIBUTING.md`
- Shared commitment rule templates: `agent-library/RULE_TEMPLATES.md`
- Skill for new agent/commitment combos: `skills/add-agent-commitment/SKILL.md`
- Agent module layout and new-commitment workflow: `agent-library/README.md`
- Runner config, message APIs, publication nodes, and harness usage: `agent/README.md`
- Standalone node daemons and startup commands: `node/README.md`
- Deployment and configuration: `docs/deployment.md`
- Signer options and `with-signer` helper: `docs/signers.md`
- Offchain agent usage: `docs/agent.md`
- Agent extension decision rules: `docs/agent-extension-guidelines.md`
- Web frontend: `docs/frontend.md`
- Testing and common commands: `docs/testing.md`

## Repo Layout

- `src/` Solidity contracts
- `script/` Foundry deployment and ops scripts
- `test/` Foundry tests
- `agent/` Offchain agent scaffold
- `node/` Standalone Oya node daemons and node-focused tests
- `frontend/` Web UI
- `lib/` External dependencies (Foundry)
