#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo 'Usage: bash deploy-droplet.sh SSH_TARGET PUBLIC_HOSTNAME CONFIG_JSON NODE_ENV [IMAGE@sha256:DIGEST]'
    echo 'First deployment only; requires verified SSH access and Docker/Compose on a Linux amd64 host.'
    echo 'Uses image.txt from the release bundle unless an explicit pinned GHCR image is supplied.'
}
fail() { echo "$1" >&2; exit 1; }
if [[ ${1:-} == --help && $# == 1 ]]; then usage; exit 0; fi
if [[ $# != 4 && $# != 5 ]]; then usage >&2; exit 1; fi
target=$1
hostname=$2
[[ $target =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]] || fail 'Use a user@host or SSH config alias, without shell options.'
[[ ${#hostname} -le 253 && $hostname =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]] || fail 'Supply a public DNS hostname without a scheme, port, or path.'
[[ -f $3 && -r $3 && -f $4 && -r $4 ]] || fail 'Supply readable configuration and environment files.'
for executable in ssh tar; do command -v "$executable" >/dev/null || fail "Missing dependency: $executable"; done
runtime=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${5:-}
if [[ $# == 4 ]]; then
    [[ -r $runtime/image.txt ]] || fail 'Use a published release bundle or supply a pinned GHCR image as the fifth argument.'
    image=$(cat "$runtime/image.txt")
fi
[[ $image =~ ^ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$ ]] || fail 'Supply a GHCR image pinned by its full SHA-256 digest, without a mutable tag.'
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10)

echo 'Checking the existing Droplet before deployment.'
ssh "${ssh_options[@]}" "$target" 'bash -s -- check' < "$runtime/scripts/deploy-droplet-remote.sh"

umask 077
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$staging/docker"
cp "$runtime/compose.yaml" "$staging/compose.yaml"
cp "$runtime/docker/compose.http.yaml" "$runtime/docker/Caddyfile" "$staging/docker/"
# Caddy drops DAC override capabilities and must be able to read its public config.
chmod 644 "$staging/docker/Caddyfile"
# stdin redirection supports input filenames beginning with a dash, without copying their names.
cat < "$3" > "$staging/node.json"
cat < "$4" > "$staging/node.env"
chmod 600 "$staging/node.json" "$staging/node.env"
printf 'services:\n  node:\n    build: !reset null\n    image: %s\n' "$image" > "$staging/image.yaml"
printf 'export OYA_PUBLIC_HOSTNAME=%s\n' "$hostname" > "$staging/compose.env"

echo 'Copying the deployment files into a new private directory.'
# mkdir claims the directory atomically; concurrent or repeated installs cannot overwrite it.
tar -C "$staging" -cf - . | ssh "${ssh_options[@]}" "$target" \
    'umask 077; deploy_dir=${OYA_DEPLOY_DIR:-"$HOME/oya"}; mkdir "$deploy_dir" && tar -xpf - -C "$deploy_dir"'

echo 'Validating settings and starting services.'
ssh "${ssh_options[@]}" "$target" 'bash -s -- start' < "$runtime/scripts/deploy-droplet-remote.sh"
echo "Containers are running. Verify public HTTPS and a signed message at https://$hostname."
echo 'On the host, source compose.env from the deployment directory before using docker compose.'
