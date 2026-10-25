# Testing and Common Commands

Choose checks for the area you are changing. Commands below run from the repository root; install that area's dependencies first using its linked guide. Operating a released node uses the [deployment acceptance checks](../node/production/deploy-with-agent.md#acceptance-before-handoff), rather than requiring a source development environment.

| Area | Setup and validation guide |
| --- | --- |
| Root Solidity application (`src/`, `script/`, `test/`) | Foundry commands below; initialize dependencies with `git submodule update --init --recursive`. |
| Ledger (`contracts/`) | [Separate Foundry project](../contracts/README.md#build-and-test): `forge build --root contracts`, then `forge test --root contracts --offline`. |
| Production node (`node/production/`) | [Install and validate](../node/production/README.md#install-and-validate) for Node.js tests; [Docker validation](../node/production/README.md#validate-the-docker-flow) for publication and inbox flows. |
| Experimental node daemons | [Node commands and focused tests](../node/README.md#commands). |
| Commitment agents | [Module validation and local harness](../agent-library/README.md#building-a-new-agentic-commitment), plus the selected module's tests. |
| Kernel libraries (`packages/`) | [Package build and validation](../packages/README.md#validate-a-release). |
| Web frontend | [Dependency tests and build](../frontend/README.md#dependency-validation). |

The node and package development guides use Node.js 24 as the validation baseline. The production node unit suite also needs Python 3 for mocked Keychain lifecycle tests. Docker integration tests have additional service/tool prerequisites listed in their guide. No single command below tests every subsystem.

## Root Solidity project

```shell
forge build
forge test
forge fmt
forge snapshot
```

Add `-vv` for logs or `--mt <pattern>` to target specific tests.

These commands target the root Foundry project. They do not replace the `--root contracts` checks for Ledger. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and applicable `AGENTS.md` instructions for required checks and review.
