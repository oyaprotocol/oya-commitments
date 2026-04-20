# Package Area Guidelines

## Scope

This file applies to `packages/` and `packages/*`.

## Purpose

`packages/` is the home for the hardened production-kernel packages for Oya commitment functionality. These packages are intended to be importable both from this repository and from external codebases.

## Rules

- Treat the existing repo implementation as reference material only for this area. Do not import production-kernel code from `agent/`, `agent-library/`, `node/`, or `frontend/`.
- Keep each package importable through its package root and `exports` surface. Do not rely on deep-import paths as a public interface.
- Keep package shells intentionally small until the user approves concrete functionality for a package.
- Do not turn `packages/` into a grab bag for app wiring, CLI code, environment loading, or repo-specific startup logic.
- Reference root `AGENTS.md`, `CONTRIBUTING.md`, and `PLANS.md` for repository-wide expectations.
- All changes will be closely reviewed by human engineers before being merged, so diffs should be small enough to accommodate human review within a reasonable length of time.

## Locality Rule

If a change only affects one hardened package, keep it local to that package instead of introducing shared code prematurely.

## Validation

- Smoke-import any changed package entrypoint with Node.
- If package metadata changes, verify the package root still exposes the intended `exports` entrypoint.
