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

RPC_URL_VALUE="${RPC_URL:-${SEPOLIA_RPC_URL:-${MAINNET_RPC_URL:-}}}"
CHAIN_VALUE="${CHAIN:-sepolia}"

: "${RPC_URL_VALUE:?RPC_URL, SEPOLIA_RPC_URL, or MAINNET_RPC_URL is required}"
: "${DEPLOYER_PK:?DEPLOYER_PK is required}"
: "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY is required to verify the deployment}"

cd "$ROOT_DIR"

forge script "$@" script/DeployOyaTestERC1155.s.sol:DeployOyaTestERC1155 \
  --rpc-url "$RPC_URL_VALUE" \
  --broadcast \
  --verify \
  --chain "$CHAIN_VALUE" \
  --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
