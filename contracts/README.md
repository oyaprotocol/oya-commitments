# Oya Contracts

This directory is the home for hardened onchain Oya contracts. It contains the Logger for recording claims about published IPFS CIDs.

Contract source, tests, and deployment tooling belong here. The offchain libraries consumed by nodes live in `packages/`; nodes interact with deployed contracts through their addresses and ABIs.

## Logger

[`src/Logger.sol`](src/Logger.sol) exposes:

```solidity
event Log(address indexed node, string cid);

function log(string calldata cid) external;
```

Any caller can submit a nonempty string. Each successful call emits exactly one `Log(msg.sender, cid)` event, preserving the string exactly. An empty string reverts with `EmptyCid()`. The function is nonpayable. When a contract wallet or forwarder calls Logger, the event records that contract's address as the node.

Logger treats the CID as an opaque claim: it does not validate CID syntax, fetch content, check signatures, or prove availability. Nonempty whitespace and other strings are accepted without normalization or an application-specific length limit. Hosts should validate the artifact and its CID before submitting a transaction, and consumers should verify content when reading it.

Repeated submissions emit separate events. Consumers can filter by the indexed node address and decode the CID from event data. The chain's canonical block and log positions establish recording order; consumers choose a confirmation policy and handle reorganizations. Logger keeps no onchain storage history or sequence counter.

Node integration will compose the existing `publishSignedMessage(...)` IPFS publisher with transaction submission to a deployed Logger. Deployment addresses, transaction signing, and receipt handling are a later milestone.

## Build and Test

This is a separate Foundry project configured by `foundry.toml`, pinned to Solidity 0.8.23 and the Paris EVM target with optimization enabled at 200 runs. Tests reuse the repository's pinned `lib/forge-std` submodule; Logger itself has no runtime imports.

For a fresh checkout, install Foundry and initialize the submodule from the repository root:

```sh
git submodule update --init --recursive
```

Run these commands from the repository root:

```sh
forge fmt --root contracts --check
forge build --root contracts --sizes
forge test --root contracts --offline -vv
forge inspect --root contracts --offline Logger abi
```

Use `forge fmt --root contracts` to apply formatting. Equivalently, run Forge from `contracts/` without `--root`. The root project's plain `forge build` and `forge test` commands cover the existing root Solidity application; use the commands above for this project. A dedicated CI job runs its formatting, build, and tests.

Tests run in Forge's local EVM without an RPC endpoint or private key. The first build may download the pinned compiler; subsequent tests run offline. `--offline` also avoids optional signature lookups that can trigger a Foundry 1.5.1 macOS proxy-settings crash inside a sandbox. Generated `out/` and `cache/` directories are ignored. See [`logger-execplan.md`](logger-execplan.md) for implementation decisions and validation evidence.

See [AGENTS.md](AGENTS.md) for local agent instructions and [CONTRIBUTING.md](../CONTRIBUTING.md) for the shared contributor workflow.
