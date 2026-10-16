# Publish a production node image

Maintainers use `scripts/publish-image.sh` to publish a Linux amd64 image to GitHub Container Registry (GHCR). The same image contains the local worker, PostgreSQL inbox service, sender client, and advanced direct runtime. Operators use the matching bundle to [run locally](run-locally.md) and [host the inbox](host-inbox.md) wherever they choose. Docker/Compose runs on each selected host. Publication is an explicit release command, not an automatic push on every commit. v0.3.0 is the first published inbox-capable release; v0.2.0 supports only the direct API.

## Published deployment release

The deployment guides use [node-v0.3.0](https://github.com/oyaprotocol/oya-commitments/releases/tag/node-v0.3.0), built from commit `07acda6b247b34f5061275904d209ad071b80029`. Its public Linux amd64 image is `ghcr.io/oyaprotocol/oya-node:v0.3.0`; deployments use the immutable reference recorded in the release's `image.txt`:

```text
ghcr.io/oyaprotocol/oya-node@sha256:848806de43f0afa056d1dea533320bfc1b503cb4409a96abb3101d7cedbb69de
```

The matching `oya-node-v0.3.0.tar.gz` has SHA-256:

```text
8c8cd6f5ecf4c9de1b0704b8f81a7be05d574a68af8ce6eef45a17e2f8c4ae73
```

Check the downloaded archive with `sha256sum` on Linux or `shasum -a 256` on macOS and compare it with this value before extraction. The release also includes `release.txt` recording the tag, commit, and image reference. Follow the current [local-worker](run-locally.md) and [inbox-host](host-inbox.md) guides with these released Compose assets. Documentation embedded in the immutable v0.3.0 archive still describes a source build; the current guides supply the published-image instructions. Both IPFS-only and full Ledger modes are included.

## Version control and release preparation

Review and merge the runtime, Dockerfile, dependency lockfile, deployment scripts, and documentation before releasing. Inspect the complete release contents for sensitive information. Run the production tests and Docker integration checks documented in the [runtime guide](README.md#validate-the-docker-flow), including the amd64 HTTPS check and `npm --prefix node/production run test:ipfs -- --platform linux/amd64` for IPFS-only operation. Also run `test:inbox` for database/recovery tests and `test:inbox:docker` for both packaged worker modes against PostgreSQL, HTTPS, Kubo, and Anvil. Build the contracts first with `forge build --root contracts`. CI runs these checks without publishing images.

Use a Git tag such as `node-v0.1.0` for the reviewed commit. The script publishes the corresponding image tag `v0.1.0` and labels it with the full Git commit ID. This version identifies the complete Docker deployment release, independently of the private runtime's npm package version and published kernel versions. Use patch versions for compatible fixes and dependency refreshes, minor versions for compatible features, and major versions for breaking operator/configuration changes; document migrations explicitly, including during `0.x` development.

From a clean checkout of the reviewed commit, after validation:

```sh
git tag -a node-v0.1.0 -m "Production node v0.1.0"
git push origin node-v0.1.0
```

Replace the example version for each release. Commit and push the reviewed source first. Never move a published Git tag or reuse an image version for different contents. Serialize publications of a version: image tags are mutable registry names, not a lock against concurrent publishers. Protect `node-v*` tags against updates/deletion with repository rules where available.

## Publish and distribute

The maintainer needs Bash, Git, tar, Node.js 24, Docker with Buildx and Linux amd64 build support, and permission to publish packages in the selected GHCR namespace. The script requires the release tag to point at a clean HEAD, including no untracked files, and builds a Git archive of that commit. Ignored local settings never enter the archive; the Dockerfile and `.dockerignore` further limit image contents. Keep credentials out of tracked source and build arguments.

Authenticate interactively with a GitHub personal access token (classic) with `write:packages`, authorizing organization SSO if required. Paste it at Docker's password prompt, not into a command or committed file. Public image downloads need no authentication. See [GitHub's GHCR instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

```sh
docker login ghcr.io --username YOUR_GITHUB_USERNAME
mkdir -p "$HOME/oya-releases"
bash node/production/scripts/publish-image.sh \
  ghcr.io/oyaprotocol/oya-node node-v0.1.0 "$HOME/oya-releases/node-v0.1.0"
```

Use a new output directory outside the checkout; its parent must exist. The registry repository is configurable for forks. The source label identifies this GitHub repository; forks should update that label in the publisher. The script pushes the image and creates three public release assets:

- `image.txt`: the exact `ghcr.io/OWNER/IMAGE@sha256:...` reference returned by this build.
- `release.txt`: the Git tag, full commit ID, and pinned image reference.
- `oya-node-v0.1.0.tar.gz`: matching Compose/Caddy files, inbox/worker configuration examples, local hosting and PostgreSQL guides, API and release documentation, compatibility guides/helpers for older direct nodes, and `node/production/image.txt`. It contains no operator settings, signing keys, database passwords, source checkout, or build tools.

The bundle also carries the `testing` Compose overlay and `agent-library/agents/hourly-message-test/agent.mjs` from the same Git tag. The test agent uses the node image's existing Node.js/ethers installation with its source mounted read-only. Generated agent keys are private operator state and never belong in a release. Validate this optional service with `npm --prefix node/production run test:testing -- --platform linux/amd64` before release.

Operators should extract a trusted release bundle into a new directory with `tar -xzpf ARCHIVE -C BUNDLE_DIRECTORY`, replacing the placeholders with their paths. The `-p` flag preserves the archived public read/traversal permissions under `umask 077`, so bind-mounted Caddy configuration and agent source remain readable by container users. Keep private operator settings in a separate directory with owner-only permissions. Older v0.2.0 bundles also need the scoped permission repair in the [direct-node extraction instructions](run-direct.md#1-download-the-matching-release-files).

The digest comes from [Buildx build metadata](https://docs.docker.com/reference/cli/docker/buildx/build/#write-build-result-metadata-to-a-file---metadata-file), rather than looking up the version tag later. Deployments use that immutable digest. Building the same source again can yield a different digest; retain the original assets and record a new version for a new publication.

On the first publication, change the GHCR package visibility to **public** in its package settings; a public source repository does not automatically make a newly published package public. Verify that a host without GHCR credentials can pull the exact reference from `image.txt`. GitHub documents [package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility). An authenticated maintainer pull alone does not test anonymous access.

Create a GitHub Release attached to the same Git tag, attach all three assets, and include the contents of `release.txt` plus changes, checks performed, and any upgrade instructions in the release notes. Inspect the assets before uploading. The generated archive and digest records are release assets, not additional source commits; the digest is only known after building the tagged commit. No registry credentials, `node.json`, or `node.env` belong in Git or these assets.

If publishing fails, inspect the output directory and registry before another attempt: a push can succeed before bundle creation fails. The script refuses an existing output directory and does not undo a public push. Keep completed assets; do not delete an image used by existing deployments. This script does not create Git tags, push Git changes, change package visibility, or create GitHub Releases for you.

## Publish an update

Make and review the source/dependency/Dockerfile changes, run validation, merge, and create the next `node-vMAJOR.MINOR.PATCH` tag. Repeat publication into a new output directory and attach its assets to a new GitHub Release. A base-image or dependency security fix also needs a new build and release; the Dockerfile's digest and lockfile do not update themselves.

Existing nodes keep their recorded digest until an operator deliberately updates them. Keep old images and release assets for rollback. Follow [local worker recovery and upgrades](run-locally.md#monitor-stop-and-resume) and the [database backup/migration procedure](host-inbox.md#retention-recovery-and-migration). Release notes must call out changed Compose files, private configuration, timeouts, or storage compatibility; an old image cannot reverse incompatible database state. Existing direct deployments must drain and reconcile before migration, and their hourly sender requires adaptation to the inbox protocol. Never point an old direct image at the new worker configuration.
