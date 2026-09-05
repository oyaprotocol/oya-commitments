# Contract Area Guidelines

## Scope and Purpose

These instructions apply to `contracts/` and its subdirectories. This is the home for hardened onchain Oya contracts, including Logger. Root `AGENTS.md`, `CONTRIBUTING.md`, and `PLANS.md` also apply.

## Organization

- Keep implementations under `src/`, Solidity tests under `test/`, and any future deployment tooling local to this directory.
- Keep offchain node libraries and runtime integration in `packages/` and the relevant host code.
- Keep changes small enough for focused human review.

## Validation

This is a separate Foundry project. From the repository root, run `forge fmt --root contracts`, `forge build --root contracts --sizes`, and `forge test --root contracts --offline -vv` for Solidity changes. Inspect changed public interfaces with `forge inspect --root contracts --offline <ContractName> abi`. CI runs the same project's formatting check, build, and offline tests. Build first to install the pinned compiler when needed; keep local tests offline.

Use the compiler and EVM target pinned in `foundry.toml` and the existing `lib/forge-std` test dependency. Keep build/test commands current in `README.md` and maintain the contract CI job in `.github/workflows/test.yml`. Follow the repository's Solidity formatting and testing guidelines.
