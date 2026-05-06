# Oya Kernel Packages

`packages/` contains the production-kernel package surfaces for Oya.

## Package Shells

- `packages/utils` -> `@oyaprotocol/utils`
- `packages/messages` -> `@oyaprotocol/messages`
- `packages/ipfs` -> `@oyaprotocol/ipfs`
- `packages/ethereum` -> `@oyaprotocol/ethereum`

## Import Strategy

- Internal repo consumers should add a normal package dependency and import from the package name, not from a repo-relative deep path.
- External consumers can use the same package names once they are installed through a local path, git dependency, or future published release path.
- Public examples should import from package roots only, such as `@oyaprotocol/messages`.

## Source and Build

- Package source files live in `src/*.ts`.
- Package manifests export built files from `dist/`, not raw source paths.
- `packages/package.json` owns the local TypeScript toolchain for this area.
- Build the kernel packages with `npm --prefix packages run build`.

## Current Constraints

- `@oyaprotocol/ipfs`, `@oyaprotocol/ethereum`, and `@oyaprotocol/utils` expose functional kernel APIs.
- `@oyaprotocol/messages` is still a placeholder package shell.
- Proposal or proof verification packages are intentionally not represented here yet; those may be implemented later in a lower-level language while TypeScript packages focus on network interactions.
