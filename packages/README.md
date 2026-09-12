# Oya Kernel Packages

`packages/` contains the production-kernel package surfaces for Oya.

## Packages

- `packages/utils` -> `@oyaprotocol/utils`
- `packages/messages` -> `@oyaprotocol/messages`
- `packages/ipfs` -> `@oyaprotocol/ipfs`
- `packages/ethereum` -> `@oyaprotocol/ethereum`

All four packages are licensed under MIT, copyright 2026 John Shutt. Each package includes its own `LICENSE` file. Their repository metadata points to [oyaprotocol/oya-commitments](https://github.com/oyaprotocol/oya-commitments) and the corresponding package directory.

## Import Strategy

- Internal repo consumers should add a normal package dependency and import from the package name, not from a repo-relative deep path.
- External consumers can use the same package names once they are installed through a local path, git dependency, or future published release path.
- Public examples should import from package roots only, such as `@oyaprotocol/messages`.

## Source and Build

- Package source files live under `src/`, including subdirectories for individual message handlers.
- Package manifests export built files from `dist/`, not raw source paths.
- `packages/package.json` owns the local TypeScript toolchain for this area.
- Kernel packages target ECMAScript 2025 and expect an ECMAScript 2025-compatible execution environment.
- Node.js 24 is the CI baseline for building and testing. The kernels do not require Node.js or declare a Node.js engine version; compatibility with other runtimes needs runtime-specific validation.
- Build the kernel packages with `npm --prefix packages run build`.

## Validate a Release

From the repository root, using Node.js 24 and npm:

```sh
npm --prefix packages ci --include=dev
npm --prefix packages run build
npm --prefix packages run test:release
```

The release test packs all four kernels and installs their archives together in a new temporary project outside the checkout. It uses Node.js built-ins and the existing TypeScript compiler. Installation disables lifecycle scripts and requires npm registry access for the pinned Noble dependencies. Signature, IPFS publication, and Logger checks use existing fixtures and an injected transport; they need no keys, blockchain, or IPFS service.

The test checks archive file lists, SHA-512 hashes, metadata, licenses, source maps, dependency versions, package-root imports, and TypeScript declarations. Only compiled JavaScript, declarations, source maps, package metadata, READMEs, and licenses ship; TypeScript's incremental build caches are excluded.

Each run prints its temporary artifact directory and preserves the four `.tgz` archives, `inventory.json`, and the consumer project with its installation lockfile. Successful validation records `"validation": "passed"` in the inventory. Review those files and retain the exact archives and hashes for publication; temporary directories may be removed by the operating system. This command does not publish packages. Complete the existing kernel tests and type checks listed in the [release ExecPlan](../plans/kernel-packages-release-execplan.md) before approving a release.

After publishing the reviewed archives, verify the registry installation from the same checkout:

```sh
OYA_RELEASE_SOURCE=registry OYA_RELEASE_INVENTORY=/absolute/path/to/reviewed-artifacts/inventory.json npm --prefix packages run test:release
```

Replace the inventory path with the retained file from the passing archive run; keep its four `.tgz` files beside it. Registry mode verifies those archive hashes, checks npm's exact versions and integrity values, installs by name and version, and repeats the same content, dependency, runtime, and declaration checks. It creates a separate evidence directory containing the reference inventory path and registry results. It does not repack or publish. Missing versions or mismatched hashes fail validation.

## Current Constraints

- `@oyaprotocol/ipfs`, `@oyaprotocol/ethereum`, and `@oyaprotocol/utils` expose functional kernel APIs.
- `@oyaprotocol/messages` exposes signed text message schema validation, EIP-191 signature verification, allowlist authorization, HTTP-shaped ingress handling, and host-configured accepted-message callbacks. `publishSignedMessage(...)` publishes the signed envelope to IPFS; `publishAndLogSignedMessage(...)` then logs its CID and verifies the transaction receipt. It depends on `@oyaprotocol/ipfs` and `@oyaprotocol/ethereum` for those operations; the host supplies transaction preparation/signing.
- Proposal or proof verification packages are intentionally not represented here yet; those may be implemented later in a lower-level language while TypeScript packages focus on network interactions.
