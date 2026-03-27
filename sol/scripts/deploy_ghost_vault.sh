#!/usr/bin/env bash
# Deploy GhostVault via Foundry and verify on Etherscan (Sepolia).
#
# Usage (from anywhere):
#   bash scripts/deploy_ghost_vault.sh
#   bash scripts/deploy_ghost_vault.sh --skip-verify   # broadcast only
#
# Requires `sol/.env` (or pre-exported variables) with:
#   PRIVATE_KEY              — deployer (hex, with or without 0x)
#   PK_MINT_X_IMAG           — BLS pk limb (uint256 string, decimal or 0x hex)
#   PK_MINT_X_REAL
#   PK_MINT_Y_IMAG
#   PK_MINT_Y_REAL
#   MINT_AUTHORITY           — address allowed to call announce()
#   RPC_URL          — JSON-RPC HTTPS for the selected network
#   ETHERSCAN_API_KEY        — for verification (omit with --skip-verify)
#
# Solidity entrypoint: script/GhostVault.s.sol — GhostVaultScript

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SOL_ROOT"

VERIFY=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-verify)
      VERIFY=false
      shift
      ;;
    -h | --help)
      sed -n '1,25p' "$0" | tail -n +2
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done

if [[ -f "$SOL_ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$SOL_ROOT/.env"
  set +a
else
  echo "warning: no $SOL_ROOT/.env — using already-exported env vars only" >&2
fi

required=(
  PRIVATE_KEY
  PK_MINT_X_IMAG
  PK_MINT_X_REAL
  PK_MINT_Y_IMAG
  PK_MINT_Y_REAL
  MINT_AUTHORITY
  RPC_URL
)

for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "error: required env $v is empty or unset" >&2
    exit 1
  fi
done

if $VERIFY; then
  if [[ -z "${ETHERSCAN_API_KEY:-}" ]]; then
    echo "error: ETHERSCAN_API_KEY is required for verification (use --skip-verify to deploy only)" >&2
    exit 1
  fi
  export ETHERSCAN_API_KEY
fi

# forge reads PK_* and MINT_AUTHORITY from the environment for vm.envOr in GhostVaultScript
export PK_MINT_X_IMAG PK_MINT_X_REAL PK_MINT_Y_IMAG PK_MINT_Y_REAL MINT_AUTHORITY

echo "==> Deploying GhostVault (broadcast from $(basename "$SOL_ROOT"))"
echo "    RPC: ${RPC_URL:0:40}…"

forge_args=(
  script/GhostVault.s.sol:GhostVaultScript
  --rpc-url "$RPC_URL"
  --broadcast
  --private-key "$PRIVATE_KEY"
)

if $VERIFY; then
  # Uses `[etherscan].sepolia` in foundry.toml; key from ETHERSCAN_API_KEY.
  forge_args+=(--verify)
fi

forge script "${forge_args[@]}"

echo
echo "==> Done. Contract address: check latest run under broadcast/GhostVault.s.sol/<chainId>/run-latest.json"
echo "    or the console output above."
