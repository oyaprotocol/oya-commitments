# Agent Runner Guidelines

## Scope

This file applies to `agent/`.

## Purpose

`agent/` contains shared offchain runner infrastructure (config, signer handling, polling, transaction helpers, and runtime wiring).

## Rules

- Keep this directory generalized and reusable across multiple agent modules.
- Do not add behavior that is only relevant to one agent module.
- If a shared runner change is required, preserve backward compatibility for existing modules where practical.

## Locality Rule

If behavior is specific to one agent, implement it in `agent-library/agents/<agent-name>/` instead of `agent/`.

## Validation

- Run relevant Node checks and scripts for changed code paths.
- Run at least one affected module test/simulation from `agent-library/agents/<name>/`.
