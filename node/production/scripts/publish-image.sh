#!/usr/bin/env bash
set -euo pipefail

usage() { echo 'Usage: bash publish-image.sh ghcr.io/OWNER/IMAGE node-vMAJOR.MINOR.PATCH OUTPUT_DIRECTORY'; }
fail() { echo "$1" >&2; exit 1; }
if [[ ${1:-} == --help && $# == 1 ]]; then usage; exit 0; fi
if [[ $# != 3 ]]; then usage >&2; exit 1; fi
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
git -C "$root" -c tar.umask=0022 archive "$revision:node/production" | tar -xpf - -C "$staging/source"
version=${release#node-}
echo "Publishing $repository:$version from $revision for Linux amd64."
docker buildx build --platform linux/amd64 --push --tag "$repository:$version" \
    --label "org.opencontainers.image.source=https://github.com/OyaChat/oya-commitments" \
    --label "org.opencontainers.image.revision=$revision" --label "org.opencontainers.image.version=$version" \
    --metadata-file "$staging/build.json" "$staging/source"
# Use this build's digest, never a later lookup of the mutable version tag.
digest=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
console.log(JSON.parse(readFileSync(process.argv[1], "utf8"))["containerimage.digest"]);
' "$staging/build.json")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Build did not return a valid image digest; inspect the registry before retrying.'
bundle="$staging/bundle/node/production"
mkdir -p "$bundle/docker" "$bundle/scripts"
cp "$staging/source/compose.yaml" "$staging/source/README.md" \
    "$staging/source/deploy-droplet.md" "$staging/source/release-image.md" "$bundle/"
cp "$staging/source/docker/compose.http.yaml" "$staging/source/docker/Caddyfile" \
    "$staging/source/docker/config.example.json" "$staging/source/docker/runtime.env.example" "$bundle/docker/"
cp "$staging/source/scripts/deploy-droplet.sh" "$staging/source/scripts/deploy-droplet-remote.sh" "$bundle/scripts/"
printf '%s@%s\n' "$repository" "$digest" > "$bundle/image.txt"
cp "$bundle/image.txt" "$output/image.txt"
printf 'Git tag: %s\nGit commit: %s\nImage: %s@%s\n' "$release" "$revision" "$repository" "$digest" > "$output/release.txt"
tar -C "$staging/bundle" -czf "$output/oya-node-$version.tar.gz" .
echo "Release files written to $output. Make the GHCR package public and verify anonymous access before sharing."
