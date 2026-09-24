#!/usr/bin/env bash
# Sent to the Droplet over SSH by deploy-droplet.sh; never receives secrets as arguments.
set -euo pipefail
fail() { echo "$1" >&2; exit 1; }
deploy_dir=${OYA_DEPLOY_DIR:-"$HOME/oya"}
[[ $# == 1 && ( $1 == check || $1 == start ) ]] || fail 'Expected check or start.'
[[ $(id -u) != 0 ]] || fail 'Use a non-root operator account with Docker access.'
[[ $(uname -s) == Linux ]] || fail 'The remote host must run Linux.'
architecture=$(docker info --format '{{.OSType}}/{{.Architecture}}')
[[ $architecture == linux/amd64 || $architecture == linux/x86_64 ]] || fail 'The remote Docker daemon must run Linux amd64.'
version=$(docker compose version --short)
[[ $version =~ ^v?([0-9]+)\.([0-9]+) ]] || fail 'Cannot determine the Compose version.'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 30) )) || fail 'Compose 2.30 or newer is required.'
containers=$(docker ps --all --quiet --filter label=com.docker.compose.project=oya)
volumes=$(docker volume ls --quiet --filter 'name=^oya_')
[[ -z $containers && -z $volumes ]] || fail 'Existing Oya containers or volumes found. Use the documented recovery/update procedure.'
if [[ $1 == check ]]; then
    [[ ! -e $deploy_dir && ! -L $deploy_dir ]] || fail 'Deployment directory already exists. Inspect it before any recovery or update.'
    exit 0
fi

cd "$deploy_dir"
# Record the resolved directory so later operator sessions can use the same settings.
printf 'export OYA_DEPLOY_DIR=%q\n' "$PWD" >> compose.env
cat >> compose.env <<'EOF'
export OYA_CONFIG_FILE="$OYA_DEPLOY_DIR/node.json"
export OYA_ENV_FILE="$OYA_DEPLOY_DIR/node.env"
export OYA_CONTAINER_USER="$(id -u):$(id -g)"
export COMPOSE_PROJECT_NAME=oya
export COMPOSE_FILE="$OYA_DEPLOY_DIR/compose.yaml:$OYA_DEPLOY_DIR/docker/compose.http.yaml:$OYA_DEPLOY_DIR/image.yaml"
EOF
source ./compose.env
docker compose config --quiet
response_seconds=$(docker compose run --rm --no-deps -T --entrypoint node node --input-type=module -e '
import { loadConfig } from "./src/config.mjs";
import { createLocalSigner } from "./src/signer.mjs";
try {
    const config = await loadConfig("/config/node.json");
    createLocalSigner(process.env.OYA_NODE_PRIVATE_KEY);
    if (config.host !== "0.0.0.0" || config.port !== 8787 ||
        new URL(config.ipfs.url).href !== "http://ipfs:5001/") throw new Error();
    console.log(Math.ceil(config.operationTimeoutMs / 1000) + 60);
} catch {
    console.error("Invalid node settings or key. Check the Docker configuration instructions.");
    process.exit(1);
}')
[[ $response_seconds =~ ^[0-9]+$ ]] || fail 'Could not calculate operation deadlines.'
printf 'export OYA_PROXY_RESPONSE_TIMEOUT=%ss\nexport OYA_STOP_GRACE_PERIOD=%ss\nexport OYA_PROXY_STOP_GRACE_PERIOD=%ss\n' \
    "$response_seconds" "$response_seconds" "$((response_seconds + 60))" >> compose.env
source ./compose.env
docker compose config --quiet
docker compose pull ipfs proxy
docker compose run --rm --no-deps -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Never retry/recreate a signing node after an uncertain result. Leave failed state for inspection.
docker compose up --detach --no-build --pull never --wait --wait-timeout 180
docker compose ps
