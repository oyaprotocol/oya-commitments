# Oya Commitments

Oya combines commitments governed by written rules, agents that act on those rules, and nodes that publish signed messages. This repository contains several related applications and libraries. Start with the task you want to perform; each area has its own setup and dependencies.

## Start here

| I want to… | Start with | What I need |
| --- | --- | --- |
| **Run a node on my own device** | [Node setup](#run-a-node), preferably [with a coding agent](node/production/deploy-with-agent.md) | Docker; an inbox host and DNS hostname for external messages. IPFS-only mode needs no funded wallet. |
| **Deploy a commitment** | [Commitment deployment](#deploy-a-commitment) | Foundry, a chain RPC endpoint, deployment parameters, and a funded deployer account. |
| **Build or run a commitment-serving agent** | [Agent setup](#build-or-run-a-commitment-serving-agent) | The shared Node.js runner, an agent module, and that module's configuration and credentials. |
| **Deploy a commitment from a browser wallet** | [Web frontend](frontend/README.md) | Node.js/npm to run the UI and a wallet for deployment transactions. |
| **Use Oya libraries in another application** | [Kernel packages](packages/README.md) | The published packages for signed messages, IPFS, and Ethereum integration. |
| **Develop or test this repository** | [Contributing](CONTRIBUTING.md) and [testing by area](docs/testing.md) | The tools for the area you are changing; there is no single install step for the whole repo. |

## How the parts fit together

- A **commitment** is a Safe account connected to an Optimistic Governor module. Written rules describe permitted actions; users or agents propose transactions and post a bond. Undisputed proposals can execute after the challenge window.
- A **commitment-serving agent** monitors a commitment and runs module-specific decision logic. The shared runner lives in `agent/`; individual implementations live in `agent-library/`.
- A **publication node** verifies authorized senders' signed messages and stores them in IPFS. Its optional Ledger mode also records the content identifier (CID) onchain. The node's Ledger contract is separate from a commitment's Safe and Optimistic Governor.

You can run an IPFS-only node independently of any commitment or commitment-serving agent. A coding agent helping you install the software is also separate from the agents that submit messages or serve commitments.

## Run a node

The recommended first setup is **IPFS-only**, with Oya and Kubo (the IPFS service) on your local device, plus a separately hosted HTTPS inbox backed by PostgreSQL. The inbox accepts signed messages from approved addresses and queues them while your device is offline. Your local worker polls over outbound HTTPS, checks authorization again, and publishes accepted messages. It needs no inbound message port, router forwarding, or tunnel.

- **For agent-assisted setup, open [Deploy with an agent](node/production/deploy-with-agent.md).** It has a task prompt, the inputs you supply, secure credential instructions, and the checks the agent must complete. If you have no hosting or hostname yet, the prompt lets you ask for options within a budget.
- **For manual setup, start with [Run locally](node/production/run-locally.md).** It walks through local configuration and sends you to [Host the inbox](node/production/host-inbox.md) when the remote role is needed.

Either path finishes by submitting a signed message and retrieving its CID. The guides also cover offline delivery, monitoring, restart, and backup verification.

| Node mode | Result | Additional requirements |
| --- | --- | --- |
| **IPFS-only** | Signed message published and pinned in local IPFS | No Ethereum RPC, Ledger deployment, funded account, or gas. |
| **Full / Ledger** | IPFS publication plus a verified Ledger transaction | Ethereum RPC access, a deployed Ledger contract, and a dedicated funded node account. This does not run an Ethereum full node. |

The [released image and deployment bundle](node/production/release-image.md#published-deployment-release) provide the runtime and deployment assets. The manual release path needs no source build, host Node.js, or Foundry. The optional macOS Keychain startup helper needs Python 3. Follow the current guides' release compatibility notes, including any helper files absent from an older bundle.

Default client jobs have a 24-hour deadline; queued work does not wait indefinitely. If your local device holds the only IPFS copy, continuous content retrieval also requires replication elsewhere. Advanced options include the [direct HTTP API without an inbox](node/production/run-direct.md). The [node directory guide](node/README.md) distinguishes the production runtime from experimental daemons.

## Deploy a commitment

This path creates a Safe and Optimistic Governor on your selected chain. Start with the [commitment deployment guide](docs/deployment.md), which explains prerequisites, required settings, and the command to run from the repository root.

1. Select the chain, collateral token, bond, and rules. Use the [shared rule templates](agent-library/RULE_TEMPLATES.md) when drafting a commitment for an agent.
2. Install Foundry, initialize the repository's contract dependencies, and configure a funded deployer and RPC access using the guide. See [signer options](docs/signers.md) for credential handling.
3. Deploy, record the resulting addresses, and verify ownership before configuring an agent to serve the commitment.

The deployment script broadcasts transactions. By default, the deployer remains the Safe's sole owner for testing. The guide explains how to finalize ownership later or choose a different owner set at deployment. The [web frontend](frontend/README.md) provides a browser-wallet alternative.

## Build or run a commitment-serving agent

To run an existing module, follow the [agent setup guide](docs/agent.md) and that module's instructions. Configure the commitment addresses and non-secret behavior in `agent-library/agents/<name>/config.json`; use the runner's supported secret/signing configuration for credentials.

To build a new module, follow [Building a new agentic commitment](agent-library/README.md#building-a-new-agentic-commitment): copy the default scaffold, select [rule templates](agent-library/RULE_TEMPLATES.md), implement local behavior, and validate it with the local harness before live use. The guide includes the exact validation and smoke-test commands. Coding agents can use the [add-agent-commitment skill](skills/add-agent-commitment/SKILL.md).

Use the [runner reference](agent/README.md) for configuration, signing, signals, and APIs. Keep behavior for one commitment in its own module; see the [extension policy](docs/agent-extension-guidelines.md) before modifying shared infrastructure.

## Repository map

| Path | Responsibility and entry point |
| --- | --- |
| [`node/production/`](node/production/README.md) | Production publication runtime, local worker, PostgreSQL inbox, Docker assets, and operator guides. |
| [`node/`](node/README.md) | Node overview plus experimental message/proposal/control daemons and their tests. New production deployments start in `node/production/`. |
| [`agent/`](agent/README.md) | Shared commitment-serving runner, signer integrations, APIs, and local harness tools. |
| [`agent-library/`](agent-library/README.md) | Individual agent modules, commitment text, configuration, and shared rule templates. |
| [`src/`](src/), [`script/`](script/), [`test/`](test/) | Root Foundry project: existing application contracts, commitment deployment/management scripts, and Solidity tests. |
| [`contracts/`](contracts/README.md) | Separate Foundry project for hardened onchain components, currently Ledger. Use its own build/test commands. |
| [`packages/`](packages/README.md) | Reusable offchain kernels published as `@oyaprotocol/*` packages. |
| [`frontend/`](frontend/README.md) | Web UI for deploying commitments through a browser wallet. |
| [`docs/`](docs/) | Commitment, agent, signer, frontend, and testing guides. Node operations guides live with `node/production/`. |
| [`skills/`](skills/) | Workflows coding agents can follow for deployment and new commitment/agent modules. |
| [`plans/`](plans/) | Design and implementation records. Use the task guides above for current setup instructions. |
| [`lib/`](lib/) | External Solidity dependencies used by Foundry. |

## Contribute or release software

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the applicable [AGENTS.md](AGENTS.md) before changing code. [Testing and common commands](docs/testing.md) points to checks for each area. Substantial work uses an execution plan following [PLANS.md](PLANS.md).

Maintainers publish node images and matching bundles through the [node release guide](node/production/release-image.md). Installing or operating a released node does not require publishing anything. Kernel library releases have a separate [package workflow](packages/README.md#validate-a-release).

## Contributors

Thanks to the people and automation helping Oya Commitments grow:

- **[John Shutt (@pemulis)](https://github.com/pemulis)** is an Oya Protocol co-founder and contributor across this repository's commitments, agents, and node infrastructure.
- **[drk (@dkuthoore)](https://github.com/dkuthoore)** contributes limit-order agents, commitment rules, and their testing and simulation tools.
- **[Dependabot](https://github.com/apps/dependabot)** is GitHub's dependency-update bot, contributing automated dependency maintenance pull requests.
- **[Oya Gardener (@oyagardener)](https://github.com/oyagardener)** is a Hermes AI coding agent joining the project to grow, test, and document software for Oya Commitments and the wider Oya ecosystem in collaboration with its human builders.

See the [contributor history](https://github.com/oyaprotocol/oya-commitments/graphs/contributors) for commit-based credits; contributions beyond commits are welcome too, and this list can grow with the project.

## Project status

This is beta software provided “as is.” Use at your own risk. No guarantees of safety, correctness, or fitness for any purpose. Keep credentials and private installation records out of Git; follow the selected guide's secure credential setup.
