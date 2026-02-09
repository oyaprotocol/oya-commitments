# Repository Guidelines

## Documentation Hierarchy
- Keep contribution guidance in both human docs and machine-readable instructions.
- `AGENTS.md`: normative instructions for coding agents and automation.
- `README.md`: architecture, intent, and operational context for humans.
- `CONTRIBUTING.md`: shared contributor workflow and policy across the repo.
- `skills/add-agent-commitment/SKILL.md`: reusable workflow for adding new agent/commitment combos.
- Precedence when instructions conflict:
1. Closest file to the changed code path wins.
2. `AGENTS.md` is authoritative for agent behavior.
3. Root-level files apply unless overridden by a closer area-level file.

## Project Structure & Module Organization
- **`src/`**: Core Solidity contracts (e.g., `Counter.sol`). Keep new modules grouped by domain and include SPDX + pragma headers.
- **`script/`**: Deployment and automation scripts (e.g., `Counter.s.sol`, `DeploySafeWithOptimisticGovernor.s.sol`). Favor reusable helpers and parameterize via environment variables.
- **`test/`**: Forge tests using `forge-std`’s `Test` base. Mirror contract names (`<Name>.t.sol`) and co-locate fixtures with the subject under test.
- **`lib/`**: External dependencies (currently `forge-std`) managed through Foundry.
- **`agent/`**: Shared offchain runner, signer integrations, and reusable tooling.
- **`agent-library/`**: Agent-specific implementations under `agent-library/agents/<name>/`.

## Build, Test, and Development Commands
- `forge build`: Compile all contracts.
- `forge test`: Run the full test suite; add `-vv` for logs or `--mt <pattern>` to target specific tests.
- `forge fmt`: Apply canonical Solidity formatting before committing.
- `forge snapshot`: Record gas snapshots for regression checks.
- `anvil`: Start a local Ethereum node for interactive testing.
- `forge script script/Counter.s.sol:CounterScript --rpc-url <url> --private-key <key> --broadcast`: Example minimal deployment.
- `forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor --rpc-url <url> --broadcast --private-key <key>`: Deploy Safe + Optimistic Governor; requires env vars like `DEPLOYER_PK`, `OG_COLLATERAL`, `OG_BOND_AMOUNT`, `OG_RULES` and optional overrides (`SAFE_*`, `OG_*`, `MODULE_PROXY_FACTORY`).

## Coding Style & Naming Conventions
- Solidity ^0.8.x, 4-space indentation, camelCase for functions/variables, PascalCase for contracts/interfaces.
- Keep files focused and small; prefer internal helpers over inline duplication.
- Run `forge fmt` to enforce style; include SPDX identifiers and explicit visibility where practical.
- Use descriptive variable names (avoid single letters outside of loop counters or hashes).
- For Node.js code in `agent/` and `agent-library/`, keep modules small and isolate side effects at the edges.

## Agent Locality Rule
- New functionality for a specific agent must be implemented in that agent's own files under `agent-library/agents/<agent-name>/`.
- Do not add agent-specific behavior to shared generalized files in `agent/src/lib/` or `agent/src/index.js`.
- Shared generalized files should only change when:
1. The change is required for multiple agents.
2. The change fixes a bug in shared infrastructure.
- If a pull request changes shared generalized agent files, include a brief cross-agent rationale in the PR description and link impacted agents.

## Testing Guidelines
- Use `forge-std/Test` utilities for assertions, fuzzing (`testFuzz_*`), and logging.
- Name tests with behavior-first patterns (`test_IncrementsCounter`, `testFuzz_SetNumberMaintainsState`).
- Cover success, failure, and access-control paths; add revert expectation tests when changing critical flows.
- When modifying gas-sensitive code, refresh `forge snapshot` and include notes in PRs.
- For `agent-library` changes, run the relevant agent test/simulation scripts and note commands in the PR.

## Commit & Pull Request Guidelines
- Write imperative, concise commit messages (e.g., "Add OG deployment script"); group related changes together.
- PRs should summarize intent, list main changes, note testing performed (`forge test`, `forge snapshot`, scripts run), and flag any config or env var impacts.
- Include relevant issue links and, if user-visible, attach logs or gas deltas for reviewers.

## Security & Configuration Tips
- Never commit private keys; load them via `.env`/CI secrets. `DEPLOYER_PK` should only be set locally or in secure pipelines.
- Double-check network-specific addresses (`SAFE_*`, `OG_MASTER_COPY`) before broadcasting; prefer dry-runs against Anvil or testnets.
- Keep salt nonces unique (`SAFE_SALT_NONCE`, `OG_SALT_NONCE`) to avoid deployment collisions, especially in shared environments.
