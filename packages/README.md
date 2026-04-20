# Oya Kernel Packages

`packages/` contains the production-kernel package surfaces for Oya.

## Package Shells

- `packages/utils` -> `@oyaprotocol/utils`
- `packages/messages` -> `@oyaprotocol/messages`
- `packages/publishing` -> `@oyaprotocol/publishing`
- `packages/transactions` -> `@oyaprotocol/transactions`
- `packages/verification` -> `@oyaprotocol/verification`

## Import Strategy

- Internal repo consumers should add a normal package dependency and import from the package name, not from a repo-relative deep path.
- External consumers can use the same package names once they are installed through a local path, git dependency, or future published release path.
- Public examples should import from package roots only, such as `@oyaprotocol/messages`.

## Current Constraints

- These package shells do not define functional ownership yet.
