# Publish a production node image

Maintainers use `scripts/publish-image.sh` to publish a Linux amd64 image to GitHub Container Registry (GHCR). Operators use the resulting deployment bundle; they do not need Git, Node.js, or Docker on their laptop. Docker/Compose remains required on the server. This is an explicit release command, not an automatic push on every commit.

## Version control and release preparation

Review and merge the runtime, Dockerfile, dependency lockfile, deployment scripts, and documentation before releasing. Inspect the complete release contents for sensitive information. Run the production tests and Docker integration checks documented in the [runtime guide](README.md#validate-the-docker-flow), including the amd64 HTTPS check. Existing CI runs those checks; it does not publish images.

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
  ghcr.io/oyachat/oya-node node-v0.1.0 "$HOME/oya-releases/node-v0.1.0"
```

Use a new output directory outside the checkout; its parent must exist. The registry repository is configurable for forks. The source label identifies this GitHub repository; forks should update that label in the publisher. The script pushes the image and creates three public release assets:

- `image.txt`: the exact `ghcr.io/OWNER/IMAGE@sha256:...` reference returned by this build.
- `release.txt`: the Git tag, full commit ID, and pinned image reference.
- `oya-node-v0.1.0.tar.gz`: matching Compose/Caddy files, deployment helpers, configuration examples, documentation, and `node/production/image.txt`. It contains no operator settings, source checkout, or build tools.

The digest comes from [Buildx build metadata](https://docs.docker.com/reference/cli/docker/buildx/build/#write-build-result-metadata-to-a-file---metadata-file), rather than looking up the version tag later. Deployments use that immutable digest. Building the same source again can yield a different digest; retain the original assets and record a new version for a new publication.

On the first publication, change the GHCR package visibility to **public** in its package settings; a public source repository does not automatically make a newly published package public. Verify that a host without GHCR credentials can pull the exact reference from `image.txt`. GitHub documents [package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility). An authenticated maintainer pull alone does not test anonymous access.

Create a GitHub Release attached to the same Git tag, attach all three assets, and include the contents of `release.txt` plus changes, checks performed, and any upgrade instructions in the release notes. Inspect the assets before uploading. The generated archive and digest records are release assets, not additional source commits; the digest is only known after building the tagged commit. No registry credentials, `node.json`, or `node.env` belong in Git or these assets.

If publishing fails, inspect the output directory and registry before another attempt: a push can succeed before bundle creation fails. The script refuses an existing output directory and does not undo a public push. Keep completed assets; do not delete an image used by existing deployments. This script does not create Git tags, push Git changes, change package visibility, or create GitHub Releases for you.

## Publish an update

Make and review the source/dependency/Dockerfile changes, run validation, merge, and create the next `node-vMAJOR.MINOR.PATCH` tag. Repeat publication into a new output directory and attach its assets to a new GitHub Release. A base-image or dependency security fix also needs a new build and release; the Dockerfile's digest and lockfile do not update themselves.

Existing nodes keep their recorded digest until an operator deliberately updates them. Keep old images and release assets for rollback. Follow the [Droplet upgrade procedure](deploy-droplet.md#update-an-existing-node) to drain requests and reconcile transactions before recreating a signing node. Release notes must call out any changed Compose files, private configuration schema, timeouts, or storage compatibility; restoring an old image alone cannot reverse incompatible state changes.
