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
forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
  --rpc-url <your_rpc_url> \
  --broadcast \
  --private-key <your_private_key>
```

## Documentation

- Contribution workflow and policy: `CONTRIBUTING.md`
- Skill for new agent/commitment combos: `skills/add-agent-commitment/SKILL.md`
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
- `frontend/` Web UI
- `lib/` External dependencies (Foundry)
