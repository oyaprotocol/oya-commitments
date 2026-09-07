# Oya Contracts

This directory is the home for hardened onchain Oya contracts. It contains the Logger for recording claims about published IPFS CIDs.

Contract source, tests, and deployment tooling belong here. The offchain libraries consumed by nodes live in `packages/`; nodes interact with deployed contracts through their addresses and ABIs.

## Logger

[`src/Logger.sol`](src/Logger.sol) exposes:

```solidity
event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid);

function log(string calldata cid) external;
```

Any caller can submit a string, including an empty string. Each successful call emits exactly one `Log(msg.sender, keccak256(bytes(cid)), cid)` event, preserving the string exactly. The function is nonpayable. When a contract wallet or forwarder calls Logger, the event records that contract's address as the node.

Logger treats the CID as an opaque claim: it does not validate CID syntax, fetch content, check signatures, or prove availability. Empty strings, whitespace, and other strings are accepted without normalization or an application-specific length limit. Hosts should validate the artifact and its CID before submitting a transaction, and consumers should verify content when reading it.

The offchain kernel enforces a narrower policy without adding onchain checks: `@oyaprotocol/ipfs` and the Logger helpers in `@oyaprotocol/ethereum` require CIDv1 in lowercase unpadded Base32 with a 32-byte SHA-256 digest. `hashLoggerCid(cid)` computes the lookup topic, and `decodeLoggerEvent` rejects matching events outside this format or with a mismatched hash. This policy leaves the Solidity ABI and accepted strings unchanged.

Repeated submissions emit separate events. Consumers can filter by the indexed node address or `cidKeccak256Hash` and decode the full CID from event data. The hash is Keccak-256 of the exact CID string bytes, separate from the content hash embedded in a CID. Equivalent CIDs with different text encodings have different lookup hashes; no normalization is performed.

The event has three topics: `keccak256("Log(address,bytes32,string)")`, the padded node address, and `cidKeccak256Hash`. An `eth_getLogs` request can filter by the Logger address and `[eventSignatureTopic, null, cidKeccak256Hash]` to find a known CID from any node. Specify the block range to search. This event replaces the earlier `Log(address,string)` ABI; consumers must use the updated event signature and decoder.

The chain's canonical block and log positions establish recording order; consumers choose a confirmation policy and handle reorganizations. Logger keeps no onchain storage history or sequence counter.

Node integration will compose the existing `publishSignedMessage(...)` IPFS publisher with transaction submission and receipt handling from `@oyaprotocol/ethereum`. Hosts supply deployment addresses and transaction signing.

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

For gas-related changes, refresh the fixed-case test snapshot from the repository root:

```sh
forge snapshot --root contracts --offline --no-match-test testFuzz_ --snap contracts/.gas-snapshot
```

This snapshot excludes randomized fuzz cases so gas comparisons use fixed inputs.

Tests run in Forge's local EVM without an RPC endpoint or private key. The first build may download the pinned compiler; subsequent tests run offline. `--offline` also avoids optional signature lookups that can trigger a Foundry 1.5.1 macOS proxy-settings crash inside a sandbox. Generated `out/` and `cache/` directories are ignored. See [`logger-execplan.md`](logger-execplan.md) for implementation decisions and validation evidence.

See [AGENTS.md](AGENTS.md) for local agent instructions and [CONTRIBUTING.md](../CONTRIBUTING.md) for the shared contributor workflow.

## Deploy Logger

[`script/DeployLogger.s.sol`](script/DeployLogger.s.sol) deploys Logger and requires an explicit expected chain ID. Load `LOGGER_DEPLOYER_PK` securely into the environment, set `LOGGER_CHAIN_ID` to the target network ID, and set `LOGGER_RPC_URL` to its RPC endpoint. The deployer needs native currency for deployment gas. From the repository root, simulate first:

```sh
forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --rpc-url "$LOGGER_RPC_URL" --offline
```

After checking the intended chain and simulation, deploy:

```sh
forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --rpc-url "$LOGGER_RPC_URL" --broadcast --offline
```

The script rejects a chain that differs from `LOGGER_CHAIN_ID`. Record the contract address and successful receipt from `contracts/broadcast/DeployLogger.s.sol/<chainId>/run-latest.json`; reuse that address in the node's `loggerContract` config. Each fresh deployment creates another Logger. `--offline` disables compiler downloads, not RPC access, so run the build first.

For a complete local deployment plus signed-message/IPFS/Logger verification, run `npm --prefix node/production run smoke:local` after following the [production node setup](../node/production/README.md). This deploys only to its isolated Anvil chain (31337), using generated local accounts.
