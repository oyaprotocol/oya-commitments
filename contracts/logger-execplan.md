# Implement the Logger Contract

This ExecPlan is maintained according to the repository's `PLANS.md`.

## Purpose / Big Picture

Provide the first hardened onchain contract under `contracts/`. A node can submit an IPFS content identifier (CID) using `log(string)`, and observers can discover the submission through `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)`. The event attributes the claim to the immediate caller, supports topic filtering by the exact CID's Keccak-256 hash, and preserves the supplied string. This contract completes the onchain primitive only; the existing message publisher will be connected to it in a later host-integration milestone. The CID index extension and corresponding offchain decoder are tracked in `plans/logger-abi-helpers.md`.

The user approved the minimal Logger and specifically selected the event name `Log`. The implementation includes a local Foundry project, Solidity tests, documentation, and CI validation, as required by `contracts/AGENTS.md`.

## Progress

- [x] 2026-09-04: Read root and contract guidance, `PLANS.md`, the existing Foundry project, CI workflow, and Logger design notes. Confirmed the worktree is clean.
- [x] 2026-09-04: Resolved the initial input policy and build settings below.
- [x] 2026-09-04: Added the Logger with `Log`, `log`, and `EmptyCid`, plus local Foundry configuration using the existing compiler and shared test dependency.
- [x] 2026-09-04: Added eight behavior tests and a dedicated contract CI job; updated local and root documentation for the separate project.
- [x] 2026-09-04: Formatting and compilation passed; all eight tests, including 256 fuzz cases, passed offline inside the sandbox with the CI profile. Inspected the ABI, validated the contract CI job's YAML and commands, reviewed the diff, and passed whitespace checks. Documented the offline test command.
- [x] 2026-09-04: Removed the empty-string check and error after gas review, replaced the rejection test with event assertions, and removed the fuzz assumption excluding empty strings. All eight tests, including 256 fuzz cases, passed offline. Build, formatting, ABI inspection, fixed-case gas snapshot, and diff checks passed; the measured call saves 26 gas and runtime bytecode shrank by 34 bytes.

- [x] 2026-09-05: Added `bytes32 indexed cidKeccak256Hash`, computed from the exact CID bytes, and updated event assertions. All eight tests (256 fuzz cases), formatting/build/ABI checks, and the refreshed fixed-case gas snapshot passed offline. The same CID benchmark adds 524 gas per call; the matching Ethereum decoder and fixtures also pass.

## Surprises & Discoveries

- Observation: The root Foundry project compiles root `src/` and `test/`, and its CI job does not validate a separate `contracts/` project.
  Evidence: Root `foundry.toml` configures `src = "src"`; `.github/workflows/test.yml` invokes Forge from the repository root. A dedicated CI job is needed.
- Observation: The existing `lib/forge-std` submodule can serve both projects' tests without adding a runtime contract dependency.
  Evidence: The checked-out submodule is at `1801b0541f4fda118a10798fd3486bb7051c5dd6`; `Test.sol` supports Solidity >=0.8.13. Solidity 0.8.23 is already installed locally.
- Observation: Foundry 1.5.1's online test startup constructs an optional signature-lookup client, which crashes while reading macOS proxy settings inside the sandbox. The tests themselves need no network access.
  Evidence: The initial run panicked in `system-configuration` through `OpenChainClient::new` before test execution. The escalation request was cancelled and the user questioned its necessity. `FOUNDRY_PROFILE=ci forge test --root contracts --offline -vv` then passed all eight tests, including 256 fuzz cases, inside the sandbox; outside access was unnecessary.
- Observation: Removing the empty-string branch saves a small amount of gas on ordinary calls and reduces deployment size.
  Evidence: With unchanged Solidity 0.8.23/Paris/optimizer settings, `forge test --root contracts --offline --gas-report --match-test test_LogsCallerAndExactCid -vv` reported `log` at 24,931 gas before and 24,905 after. Runtime size fell from 389 to 355 bytes; initcode fell from 421 to 387 bytes. The compared benchmark uses the same 46-character CID in both versions.

## Decision Log

- Decision: Use `event Log(address indexed node, string cid)` and `function log(string calldata cid) external`.
  Rationale: This is the API approved by the user. The indexed node permits filtering by publishing address, while the unindexed string remains directly decodable from the event data.
  Date/Author: 2026-09-04 / user and Codex.
- Decision: Emit `Log(msg.sender, cid)` once for each successful call; allow all callers and repeated submissions.
  Rationale: A Logger records claims attributed to their actual caller. It does not need administrative authority, a deduplication map, a supplied node address, or a sequence counter. For a contract wallet, the recorded node is that contract's address. Observers use canonical chain block/log positions for ordering and apply their own confirmation policy.
  Date/Author: 2026-09-04 / Codex, following the accepted design.
- Decision: Reject only a zero-byte string with `EmptyCid()`; otherwise preserve the string exactly. Superseded by the gas review below.
  Rationale: CID codec, multibase, syntax, and content validation belong to offchain consumers. A full onchain parser or an arbitrary maximum length would add policy beyond this logging primitive. Nonempty whitespace, non-ASCII data, and invalid CID encodings are recorded as opaque claims; callers pay the transaction's data/log gas costs. The event does not establish content validity or availability.
  Date/Author: 2026-09-04 / Codex.
- Decision: Use a standalone `contracts/foundry.toml`, pinned Solidity 0.8.23, Paris EVM target, and optimizer with 200 runs. Reuse `../lib/forge-std` through an explicit remapping.
  Rationale: An explicit compiler/target makes local and CI builds consistent, uses the existing installed compiler, and avoids depending on a deployment chain's newer opcode support. Logger requires no production imports. Chain selection and deployment remain future work.
  Date/Author: 2026-09-04 / Codex.
- Decision: Run contract tests with `--offline` locally and in CI after the build step.
  Rationale: Local EVM tests need no network service, and offline mode avoids optional signature lookup and the sandbox proxy-settings crash. The preceding build can install the compiler on a fresh CI runner.
  Date/Author: 2026-09-04 / user and Codex.
- Decision: Accept every string, including empty strings, and remove `EmptyCid()` and its branch.
  Rationale: The user questioned spending gas on a check that establishes no CID-validity guarantee. All claim validation belongs to consumers; an empty claim is recorded using the same semantics as other opaque strings.
  Date/Author: 2026-09-04 / user and Codex.

- Decision: Add `bytes32 indexed cidKeccak256Hash` between the indexed node and unindexed CID, superseding the original two-topic event above.
  Rationale: The user approved exact-CID lookups through RPC topic filters and chose the explicit name. The contract computes Keccak-256 of the CID bytes; the full string remains in event data for discovery. No normalization or content validation is added.
  Date/Author: 2026-09-05 / user and Codex.

## Outcomes & Retrospective

Logger is implemented and validated with the approved `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` event and nonpayable `log(string)` function. It preserves all string data, including empty strings, attributes events to the immediate caller, and permits repeated submissions. Its body is solely `emit Log(msg.sender, keccak256(bytes(cid)), cid)`. The contract has no custom error, production imports, or storage state.

The standalone Foundry configuration, eight behavior tests, dedicated contract CI job, and documentation are complete. Solidity 0.8.23 compiles the indexed-CID Logger to 395 bytes of runtime code and 427 bytes of initcode with the pinned settings. All eight tests passed, including 256 fuzz cases, using `forge test --root contracts --offline -vv` inside the sandbox. Formatting, build, ABI inspection, and diff checks also passed. The fixed 46-character CID benchmark now costs 25,429 gas versus 24,905 before indexing (+524). `contracts/.gas-snapshot` records the seven deterministic test cases and excludes random fuzz inputs; test-level deltas include the additional event assertions. The unchanged CI job was validated locally during the initial implementation; a hosted CI run has not been triggered.

The initial test command hit a Foundry macOS proxy-settings crash before executing tests. Offline mode resolved it without elevated access, and both local guidance and the new CI test step now use that mode. No required work remains in this milestone. Deployment and the host's publish-then-log integration remain separate future work.

## Context and Orientation

Before this milestone, `contracts/` contained only `README.md` and `AGENTS.md`. The existing Solidity app lives in root `src/`, `test/`, and `script/`. Logger source and tests now live in `contracts/src/Logger.sol` and `contracts/test/Logger.t.sol` respectively, with their own `foundry.toml`. The new project does not compile the existing application as part of its own test suite.

Foundry's `forge` command compiles and tests Solidity in a local EVM. `forge-std/Test.sol` provides assertions and simulated callers. Its `recordLogs`/`getRecordedLogs` utilities let tests inspect emitted event topics, data, and emitter. Event topics contain the event signature and indexed fields; event data contains the ABI-encoded unindexed CID string. The ABI (application binary interface) tells node code how to encode calls and decode events.

`packages/messages` already verifies, publishes, and pins signed JSON envelopes to IPFS. The future host flow will take the returned CID and submit a Logger transaction. This milestone adds no transaction signer, RPC helper, ABI distribution package, or deployment script.

## Plan of Work

Create `contracts/foundry.toml` with local source/test/output paths and the existing shared test dependency. Implement the small nonpayable `Logger` contract with SPDX and pragma headers, the approved event, and the approved function. Its body emits the event without validating the string.

Add focused tests for exact event ABI encoding, attribution to unrelated callers and a forwarding contract, empty-input acceptance, duplicate acceptance, event ordering, exact opaque-string preservation, fuzzed inputs, and rejection of native-token value. Add a separate CI job that runs formatting, build, and tests using the local project configuration and the recursively checked-out test dependency.

Update local and root documentation so contributors can find the Logger and run its checks without confusing the two Foundry projects. Validate locally and record results here before finishing.

## Concrete Steps

Run from the repository root:

    forge fmt --root contracts
    forge fmt --root contracts --check
    forge build --root contracts --sizes
    forge test --root contracts --offline -vv
    forge inspect --root contracts --offline Logger abi
    forge snapshot --root contracts --offline --no-match-test testFuzz_ --snap contracts/.gas-snapshot
    git diff --check

CI runs the equivalent commands from `contracts/` with the repository's existing `FOUNDRY_PROFILE=ci`. A fresh checkout requires `git submodule update --init --recursive` and Foundry; Forge can download the pinned compiler if it is not installed. Local validation uses the existing compiler and test dependency. No secrets, RPC URL, Anvil daemon, testnet, mainnet, or environment file is required.

## Validation and Acceptance

Compilation must succeed with the pinned compiler. ABI inspection must show exactly `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)` and the nonpayable `log(string)` function. Tests must verify the Logger emitter, event signature topic, indexed immediate caller, indexed Keccak-256 hash of the exact CID bytes, and exact CID data, including empty strings and duplicate calls as separate events in order. Fuzz tests must preserve any string and caller address. The contract source has no runtime imports or storage state.

The CI job must run all three contract checks from the right directory and initialize the shared test submodule. Root app and offchain package jobs retain their current scope. Record any checks that cannot run and their cause; do not claim a live deployment or network test.

## Idempotence and Recovery

Local builds and tests are repeatable. Generated `contracts/out/` and `contracts/cache/` are ignored by the root ignore rules. Re-running `log` onchain intentionally emits another event, so later transaction retry policy must distinguish resubmitting an identical signed transaction from creating a new transaction. Reorganizations and confirmation depth are handled by future offchain consumers.

This change broadcasts no transactions. Source, tests, configuration, CI, and documentation can be reverted together without affecting existing deployments.

## Artifacts and Notes

Approved interface:

    event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid);
    function log(string calldata cid) external;

Runtime call:

    emit Log(msg.sender, keccak256(bytes(cid)), cid);

Observed ABI after CID indexing: `Log(address,bytes32,string)` (indexed node and `cidKeccak256Hash`) and `log(string) nonpayable`. Observed test result: `8 tests passed, 0 failed, 0 skipped`; the fuzz test ran 256 cases, with a separate explicit empty-string test. Gas baseline: `contracts/.gas-snapshot`.

## Interfaces and Dependencies

New files: `contracts/src/Logger.sol`, `contracts/test/Logger.t.sol`, and `contracts/foundry.toml`. Local docs: `contracts/README.md`, `contracts/AGENTS.md`, and this plan. CI lives in `.github/workflows/test.yml`; root `README.md`, `AGENTS.md`, and `CONTRIBUTING.md` describe the project and validation scope.

Use the existing Foundry toolchain and `lib/forge-std` submodule. Logger has no third-party production dependency and is not part of the TypeScript/npm workspace.
