# Contract Area Guidelines

## Scope and Purpose

These instructions apply to `contracts/` and its subdirectories. This is the home for hardened onchain Oya contracts, including the planned Logger. Root `AGENTS.md`, `CONTRIBUTING.md`, and `PLANS.md` also apply.

## Organization

- Keep contract implementations, Solidity tests, and contract deployment tooling local to this directory.
- Keep offchain node libraries and runtime integration in `packages/` and the relevant host code.
- Keep changes small enough for focused human review.

## Validation

This directory currently contains documentation only. When adding the first contract, establish its Foundry configuration, document exact build/test commands in `README.md`, and add the corresponding CI checks. Follow the repository's Solidity formatting and testing guidelines.
