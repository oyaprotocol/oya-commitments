#!/usr/bin/env bash
set -euo pipefail

usage() { echo 'Usage: bash publish-image.sh ghcr.io/OWNER/IMAGE node-vMAJOR.MINOR.PATCH OUTPUT_DIRECTORY [--dry-run]'; }
fail() { echo "$1" >&2; exit 1; }
if [[ ${1:-} == --help && $# == 1 ]]; then usage; exit 0; fi
if [[ $# != 3 && $# != 4 ]]; then usage >&2; exit 1; fi
[[ $# == 3 || $4 == --dry-run ]] || fail 'The only optional argument is --dry-run.'
build_mode=--push
if [[ ${4:-} == --dry-run ]]; then build_mode=--load; fi
repository=$1
release=$2
[[ $repository =~ ^ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*$ ]] || fail 'Use a lowercase GHCR owner/image repository, without a tag.'
[[ $release =~ ^node-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Use a release tag such as node-v0.1.0.'
for executable in git docker node tar; do command -v "$executable" >/dev/null || fail "Missing dependency: $executable"; done
runtime=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root=$(git -C "$runtime" rev-parse --show-toplevel)
revision=$(git -C "$root" rev-parse --verify "refs/tags/$release^{commit}")
[[ $revision == "$(git -C "$root" rev-parse HEAD)" ]] || fail 'Check out the release tag before publishing.'
[[ -z $(git -C "$root" status --porcelain --untracked-files=all) ]] || fail 'Commit or remove pending changes before publishing.'
output=$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")
[[ $output != "$root" && $output != "$root/"* ]] || fail 'Choose an output directory outside the checkout.'
umask 077
mkdir "$output" # Refuse existing release output, including partial attempts.
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$staging/source"
# Preserve public source modes inside private staging: the image runs as non-root.
# Stage the archive so a tar reader closing at EOF cannot SIGPIPE git on macOS.
git -C "$root" -c tar.umask=0022 archive --output="$staging/source.tar" "$revision:node/production"
tar -xpf "$staging/source.tar" -C "$staging/source"
version=${release#node-}
echo "Building $repository:$version from $revision for Linux amd64 ($build_mode)."
docker buildx build --platform linux/amd64 "$build_mode" --tag "$repository:$version" \
    --label "org.opencontainers.image.source=https://github.com/oyaprotocol/oya-commitments" \
    --label "org.opencontainers.image.revision=$revision" --label "org.opencontainers.image.version=$version" \
    --metadata-file "$output/build.json" "$staging/source"
# Use this build's digest, never a later lookup of the mutable version tag.
digest=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
console.log(JSON.parse(readFileSync(process.argv[1], "utf8"))["containerimage.digest"]);
' "$output/build.json")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Build did not return a valid image digest; inspect the registry before retrying.'
printf '%s@%s\n' "$repository" "$digest" > "$output/image.txt"
printf 'Git tag: %s\nGit commit: %s\nImage: %s@%s\n' "$release" "$revision" "$repository" "$digest" > "$output/release.txt"
bundle="$staging/bundle/node/production"
mkdir -p "$bundle/docker" "$bundle/scripts" "$bundle/inbox" "$bundle/peers"
cp "$staging/source/compose.yaml" "$staging/source/README.md" \
    "$staging/source/deploy-droplet.md" "$staging/source/run-locally.md" "$staging/source/run-direct.md" \
    "$staging/source/host-inbox.md" "$staging/source/inbox-api.md" "$staging/source/deploy-with-agent.md" \
    "$staging/source/batch-logging.md" "$staging/source/release-image.md" "$staging/source/testnet-ledger.md" "$staging/source/upgrade-node.md" "$bundle/"
cp "$staging/source/docker/compose.http.yaml" "$staging/source/docker/Caddyfile" \
    "$staging/source/docker/compose.testing.yaml" \
    "$staging/source/docker/config.example.json" "$staging/source/docker/runtime.env.example" "$bundle/docker/"
for file in compose.yaml compose.postgres.yaml compose.https.yaml compose.worker.yaml compose.keychain-worker.yaml Caddyfile inbox.example.json worker.example.json; do
    cp "$staging/source/inbox/$file" "$bundle/inbox/"
done
mkdir -p "$staging/bundle/agent-library/agents/hourly-message-test"
git -C "$root" show "$revision:agent-library/agents/hourly-message-test/agent.mjs" \
    > "$staging/bundle/agent-library/agents/hourly-message-test/agent.mjs"
cp "$staging/source/scripts/deploy-droplet.sh" "$staging/source/scripts/deploy-droplet-remote.sh" "$bundle/scripts/"
cp "$staging/source/scripts/keychain-worker.py" "$staging/source/scripts/upgrade-node.py" "$bundle/scripts/"
cp "$output/image.txt" "$bundle/image.txt"
cp "$staging/source/peers/testnet-directory.json" "$staging/source/peers/README.md" "$bundle/peers/"
cp "$staging/source/scripts/peer-directory.mjs" "$bundle/scripts/"
# Source guides resolve the latest release; immutable bundles select their own tag.
node --input-type=module - "$bundle" "$release" <<'NODE'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [directory, tag] = process.argv.slice(2);
const releases = 'https://github.com/oyaprotocol/oya-commitments/releases';
for (const name of readdirSync(directory).filter(name => name.endsWith('.md'))) {
    const path = join(directory, name);
    const text = readFileSync(path, 'utf8')
        .replaceAll(`${releases}/latest)`, `${releases}/tag/${tag})`)
        .replace(/^export OYA_NODE_RELEASE=.*$/gm, `export OYA_NODE_RELEASE="${tag}"`);
    writeFileSync(path, text);
}
NODE
# Public bundle files must be readable by hardened containers after extraction.
# Keep the surrounding staging/output directories private, not the archived files.
chmod -R a+rX "$staging/bundle"
# The upgrader accepts only public files with portable, metadata-free headers.
COPYFILE_DISABLE=1 tar --format=ustar -C "$staging/bundle" -czf "$output/oya-node-$version.tar.gz" .
if [[ $build_mode == --load ]]; then
    echo "Preview files written to $output; no image was pushed."
else
    echo "Release files written to $output. Verify anonymous access before sharing."
fi
