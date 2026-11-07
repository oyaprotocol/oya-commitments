# Make the verified Sepolia Ledger the new-node default

This living ExecPlan follows `PLANS.md` and the repository instruction hierarchy.

## Purpose / Big Picture

A newly configured production node should verify authorized signed messages, publish them to IPFS, and then log their CIDs to the existing Ledger on Ethereum Sepolia. A CID is the content identifier returned by IPFS. The default network is chain ID `11155111`, and its verified Ledger is `0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3`. Operators should not have to deploy another contract or discover its address. Explicit IPFS-only operation remains supported. This change prepares a pull request; it does not upgrade any live installation or authorize public-chain transactions.

## Progress

- [x] 2026-11-07 00:33Z: Inspected current configuration parsers, example files, publication pipeline and operator guides; created an isolated feature branch from `main`.
- [x] 2026-11-07 00:33Z: Confirmed the existing contract matches an independent compilation of the repository's Ledger source, including all runtime metadata; installed locked runtime development dependencies.
- [x] 2026-11-07 00:45Z: Implemented consistent node/inbox defaults, explicit override validation, templates, setup output and public-RPC credential safeguards.
- [x] 2026-11-07 00:45Z: Aligned active onboarding and deployment documentation with the verified existing Sepolia deployment and older-release compatibility.
- [x] 2026-11-07 00:45Z: Added regression coverage; all 271 production tests, 9 PostgreSQL integration tests and 8 Ledger contract tests pass.
- [x] 2026-11-07: Rebuilt packaged inbox/worker integration passed across IPFS, explicit Anvil Ledger and default Sepolia identity using real HTTPS, PostgreSQL and Kubo with isolated local chains.
- [x] 2026-11-07 00:55Z: Completed independent review; fixed its omitted-chain hourly-initializer finding with a failing-before/passing-after deployment regression. Final production suite: 272 passed.
- [x] 2026-11-07 00:55Z: Both optional-hourly Ledger and IPFS-only Docker fixtures passed, including hourly-agent unit tests inside the runtime image.
- [x] 2026-11-07 00:57Z: Published upstream PR #139 from `oyagardener:feature/sepolia-ledger-defaults` to `oyaprotocol:main`; verified the open, non-draft PR, description and exact remote Git blob hashes for all 31 changed files. GitHub CI started; its pending results are not claimed as passed.

## Surprises & Discoveries

The runtime already defaults an omitted `mode` to `ledger`; the contradictory first-install guides and inbox example instead recommend IPFS-only. The host template selects a placeholder on Anvil, while the Docker template selects a placeholder on Ethereum mainnet. Both need consistent Sepolia settings. The worker already validates signatures/allowlists, publishes the signed envelope to IPFS, saves its CID, prepares and checkpoints a transaction, broadcasts it, and verifies its receipt/event. No duplicate pipeline is needed.

Regression tests exposed coercion of array-valued addresses/URLs and acceptance of incorrect mixed-case address checksums; the parser now rejects these rather than treating them as valid explicit overrides. A provider authorization header also cannot accompany an omitted RPC URL, avoiding implicit disclosure to the public default.

The Docker context uses a strict source allowlist. The first packaged run failed with `ERR_MODULE_NOT_FOUND` for `src/defaults.mjs`; explicitly allowlisting that public module fixed the build-input omission, and the complete rebuilt integration fixture passed on rerun. Host tests alone could not detect this packaging failure.

The existing deployment test assumed the Docker template selected mainnet; it now explicitly sets its unsupported test chain instead. Node 26/npm 12 also produced extra package-manager notices that conflict with an existing stderr assertion; validation uses the available Node 24/npm 11 toolchain, matching the documented development environment.

Independent review found the standalone hourly test initializer still rejected an omitted chain ID. It now resolves only an omitted value to Sepolia, preserving explicit invalid/unsupported-chain rejection and the saved configuration shape. The new deployment regression failed before this two-line fix and passed afterward; the hourly unit tests and both real hourly Docker profiles also pass.

## Decision Log

- 2026-11-07 / Oya Gardener: Reuse the independently verified existing contract rather than deploy a replacement. All 395 runtime bytes at Sepolia block 12080087 match `contracts/src/Ledger.sol` compiled from main commit `a8dee241c5a26e7124c6d99af7f1bc212f0dcd75` using Solidity 0.8.23, optimizer 200, EVM `paris`.
- 2026-11-07 / Oya Gardener: Default only omitted settings. Explicit invalid/null values still fail validation. Selecting a non-Sepolia chain requires an explicit Ledger and RPC, so the Sepolia address is not silently applied to another network.
- 2026-11-07 / Oya Gardener: Offer `https://ethereum-sepolia-rpc.publicnode.com` as the overrideable Sepolia RPC default. This public endpoint was checked for the expected chain ID; it provides no project-controlled availability guarantee. Tests inject transports or use an isolated local RPC instead.
- 2026-11-07 / Oya Gardener: Require the inbox's real public `nodeAddress`; never infer a transaction-signing identity or ship a shared key. Existing explicit IPFS configurations and saved execution identities are not automatically migrated.
- 2026-11-07 / Oya Gardener: Keep canonical deployment documentation in the already-packaged production README. Existing immutable releases retain their old defaults; source and older-release instructions must distinguish explicit configuration from a future matching release.

## Outcomes & Retrospective

Implementation and documentation are complete. Configuration, ordering/failure-path, PostgreSQL recovery, contract and packaged Docker integration tests all pass. Independent review is complete and its compatibility finding is resolved. All 272 production tests pass; the optional hourly agent was additionally verified in both Ledger and IPFS Docker profiles. The completed change is published as [PR #139](https://github.com/oyaprotocol/oya-commitments/pull/139), with remote source hashes verified. GitHub CI and maintainer review remain external gates; this change has not been merged, released or deployed. The existing message pipeline required no behavior changes; the deliverable is consistent defaults, fail-closed overrides and operator documentation, not a new chain deployment.

## Context and Orientation

`node/production/src/config.mjs` parses worker and direct-runtime settings. `node/production/src/inbox/config.mjs` validates the inbox's expected public execution identity. `executionIdentity` in `src/inbox/protocol.mjs` must produce the same normalized identity on the worker. `src/inbox/processor.mjs` owns the durable IPFS-to-Ledger pipeline. Its existing signature checks, checkpoints, receipt validation and retry behavior must remain intact.

Host setup copies `node/production/config.example.json`; Docker deployments copy `node/production/docker/config.example.json`; inbox hosting starts from `node/production/inbox/inbox.example.json`. Runtime secrets and real signer allowlists are operator inputs, not source defaults. An inbox is never given the node's private transaction key. Operator docs live in `node/production/`, with entry links in root/node/contract READMEs and repository deployment workflow documentation.

## Plan of Work

Introduce a small shared set of public Sepolia defaults. Resolve omitted mode/network/contract/RPC fields in the node parser while preserving strict IPFS-only rejection of Ethereum fields. Resolve omitted Ledger execution settings in the inbox without guessing its required node address or mutating caller inputs. Keep explicit overrides usable for Anvil and other operator-selected chains.

Update the three templates and local setup output. Reorient current onboarding toward funded, dedicated Sepolia node signing, while retaining a clearly marked IPFS-only opt-out. Document the existing contract, reproducible verification, signer separation, gas requirements, existing-installation boundaries and older release behavior.

Add literal-value tests to detect target drift, cross-chain fallback mistakes, invalid settings, lost identity isolation and accidental changes to the IPFS-only path. Exercise the real message authorizers, transaction preparation and receipt parsing with controlled transports. Extend the packaged integration fixture with a disposable local chain using Sepolia's chain ID and the compiled Ledger at the documented address, never a public RPC, to prove omitted defaults work through PostgreSQL, HTTPS, Kubo and the worker.

## Concrete Steps

All commands below run from the repository root unless stated otherwise:

1. `npm --prefix node/production ci --ignore-scripts --no-audit --no-fund` installs only locked development dependencies.
2. Run `node --test node/production/test/sepolia-defaults.test.mjs` for focused parser and pipeline regressions, once that file exists.
3. Run `npm --prefix node/production test` for the complete production suite, including setup, packaged assets, mocked Keychain lifecycle and explicit IPFS-only behavior.
4. Build the existing contract fixture with `forge build --root contracts` after initializing `lib/forge-std`, or run that exact build using the repository's pinned Foundry Docker image with an isolated build context.
5. Run `npm --prefix node/production run test:inbox` and `npm --prefix node/production run test:inbox:docker` using a reachable Docker daemon. The fixtures own unique project names and disposable volumes. Never stop, prune, or recreate a live project's containers or volumes.
6. Run `npm --prefix node/production run test:testing -- --verbose` and `npm --prefix node/production run test:ipfs -- --verbose` for the standalone hourly initializer, its unit tests and both real publication modes. The Ledger fixture needs Forge on the host; the pinned native release can be used without changing repository dependencies.
7. Run `git diff --check`, inspect the complete intended commit and PR text, commit, push the feature branch to the agent fork, and open the upstream PR. Read back the remote PR and check status.

## Validation and Acceptance

A minimal Ledger node configuration with a real allowlist and IPFS API resolves to ledger mode, chain `11155111`, the exact documented Ledger and the default public Sepolia RPC. Explicit custom settings survive unchanged; another chain without its own contract or RPC fails. Invalid explicit values fail rather than become defaults. Explicit IPFS-only settings neither acquire nor use Ethereum configuration.

A minimal inbox execution object containing a valid public node address resolves to the same identity as the default worker. Missing/invalid/zero node addresses and unrecognized execution settings fail. Input objects remain unchanged. All three distributed examples agree with the documented defaults; the inbox example deliberately requires operator replacement of its node-address placeholder.

Default-path tests must show validation and IPFS publication precede signing/broadcast, incorrect signatures or allowlists never publish/sign, IPFS failure never signs/broadcasts, and success requires the existing receipt/event checks. The packaged fixture must queue a signed job while the worker is offline, survive an inbox restart, publish exact bytes to Kubo, observe a mined transaction to the expected Ledger, and preserve the completed result across worker restart. Public Sepolia sends are forbidden during tests.

## Idempotence and Recovery

Work in an isolated worktree and preserve all pre-existing working directories. Setup continues to preserve existing private files. Do not rewrite existing operator configurations, change inbox execution identities in place, or infer permission to broadcast from the new defaults. Tests use fresh generated accounts and local-chain funds only. Their cleanup is restricted to their unique fixture resources. If a test fails, retain sanitized evidence, fix the implementation or identify an environmental blocker, and rerun; do not weaken assertions to obtain a pass. PR publication may be retried only after checking whether the branch/PR already exists.

## Artifacts and Notes

The public deployment verification used read-only RPC, Sourcify and Blockscout corroboration, and an independent local compiler comparison. Its exact runtime match is the evidence for the address, not merely nonempty code. The historical deployment receipt was unavailable from the queried RPC and is not claimed as independently verified. No secrets, private installation records, local-only paths or real signing material belong in this plan or PR.

## Interfaces and Dependencies

The node exposes `parseConfig(input, { env })`; the inbox exposes `parseInboxConfig(input)`. Both must use the same public Sepolia target defaults. `executionIdentity(config, nodeAddress)` continues its existing lowercase wire representation. The Ledger ABI remains `log(string)` and `Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)`. No Solidity behavior, published kernel versions, dependency locks, public APIs, signing algorithms, checkpoint schemas or deployment credentials need to change.
