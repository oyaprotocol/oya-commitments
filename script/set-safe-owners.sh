#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${ENV_FILE:-}" ]]; then
  ENV_PATH="$ENV_FILE"
  if [[ ! -f "$ENV_PATH" && -f "$ROOT_DIR/$ENV_PATH" ]]; then
    ENV_PATH="$ROOT_DIR/$ENV_PATH"
  fi
  if [[ ! -f "$ENV_PATH" ]]; then
    echo "ENV_FILE not found: $ENV_FILE" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_PATH"
  set +a
fi

print_usage() {
  cat <<'EOF'
Usage:
  bash script/set-safe-owners.sh --safe <safe-address> [--owners <csv|0x>] [forge script args...]

Examples:
  ENV_FILE=agent/.env bash script/set-safe-owners.sh --safe 0xSafe
  ENV_FILE=agent/.env bash script/set-safe-owners.sh --safe 0xSafe --owners 0x
  ENV_FILE=agent/.env bash script/set-safe-owners.sh --safe 0xSafe --owners 0x1111...,0x2222...

Notes:
  - If --owners is omitted, the Safe is reconciled back to deployer-only ownership.
  - Use --owners 0x to remove all human owners and finalize to the dead address.
EOF
}

SAFE_ADDRESS=""
OWNERS_VALUE=""
FORGE_EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --safe)
      [[ $# -ge 2 ]] || { echo "--safe requires a value" >&2; exit 1; }
      SAFE_ADDRESS="$2"
      shift 2
      ;;
    --safe=*)
      SAFE_ADDRESS="${1#--safe=}"
      shift
      ;;
    --owners)
      [[ $# -ge 2 ]] || { echo "--owners requires a value" >&2; exit 1; }
      OWNERS_VALUE="$2"
      shift 2
      ;;
    --owners=*)
      OWNERS_VALUE="${1#--owners=}"
      shift
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      FORGE_EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

RPC_URL_VALUE="${RPC_URL:-${SEPOLIA_RPC_URL:-}}"

: "${DEPLOYER_PK:?DEPLOYER_PK is required}"
[[ -n "$SAFE_ADDRESS" ]] || { echo "--safe is required" >&2; exit 1; }

export COMMITMENT_SAFE="$SAFE_ADDRESS"
export SAFE_OWNER_ACTION="set"
if [[ -n "$OWNERS_VALUE" ]]; then
  export SAFE_OWNERS="$OWNERS_VALUE"
else
  export SAFE_OWNERS=""
fi

FORGE_ARGS=(
  script
  script/ManageSafeOwners.s.sol:ManageSafeOwners
)

HAS_RPC_URL=false
for arg in "${FORGE_EXTRA_ARGS[@]}"; do
  if [[ "$arg" == "--rpc-url" || "$arg" == --rpc-url=* ]]; then
    HAS_RPC_URL=true
    break
  fi
done

if [[ "$HAS_RPC_URL" == false ]]; then
  : "${RPC_URL_VALUE:?RPC_URL or SEPOLIA_RPC_URL is required when --rpc-url is not passed explicitly}"
  FORGE_ARGS+=(--rpc-url "$RPC_URL_VALUE")
fi

FORGE_ARGS+=(--broadcast)
FORGE_ARGS+=("${FORGE_EXTRA_ARGS[@]}")

cd "$ROOT_DIR"
forge "${FORGE_ARGS[@]}"
