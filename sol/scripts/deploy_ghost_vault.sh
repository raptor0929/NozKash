#!/usr/bin/env bash
# Deploy GhostVault via Foundry and verify on the block explorer for the target chain.
#
# Usage (from repo root: sol/):
#   bash scripts/deploy_ghost_vault.sh
#   bash scripts/deploy_ghost_vault.sh --skip-verify
#   bash scripts/deploy_ghost_vault.sh --chain 84532
#   bash scripts/deploy_ghost_vault.sh --chain sepolia --verifier-url https://api-sepolia.etherscan.io/api
#
# Requires `sol/.env` (or pre-exported variables) with:
#   PRIVATE_KEY       — deployer (hex, with or without 0x)
#   PK_MINT_X_IMAG    — BLS pk limb (uint256 string, decimal or 0x hex)
#   PK_MINT_X_REAL
#   PK_MINT_Y_IMAG
#   PK_MINT_Y_REAL
#   MINT_AUTHORITY    — address allowed to call announce()
#   RPC_URL           — JSON-RPC HTTPS for the target network
#
# Verification (omit with --skip-verify):
#   VERIFIER_API_KEY or ETHERSCAN_API_KEY — explorer API key (Etherscan, Basescan, Snowtrace, etc.)
#   CHAIN or CHAIN_ID (optional) — EIP-155 chain id (e.g. 11155111) or Foundry chain name (e.g. sepolia).
#     Passed to forge as --chain so the correct explorer is used when using the etherscan verifier.
#   VERIFIER_URL (optional) — Etherscan-compatible API base URL for custom / unlisted chains, e.g.:
#     https://api-sepolia.etherscan.io/api
#     https://api-sepolia.basescan.org/api
#     When set, forge uses --verifier custom with this URL.
#   VERIFIER (optional) — etherscan | sourcify | blockscout | oklink | custom (default: etherscan).
#     If VERIFIER_URL is set, custom is implied unless you override VERIFIER.
#
# Solidity entrypoint: script/GhostVault.s.sol — GhostVaultScript

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SOL_ROOT"

VERIFY=true
CHAIN_CLI=""
VERIFIER_URL_CLI=""
VERIFIER_CLI=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-verify)
      VERIFY=false
      shift
      ;;
    --chain)
      if [[ $# -lt 2 ]]; then echo "error: --chain requires a value" >&2; exit 1; fi
      CHAIN_CLI="$2"
      shift 2
      ;;
    --verifier-url)
      if [[ $# -lt 2 ]]; then echo "error: --verifier-url requires a value" >&2; exit 1; fi
      VERIFIER_URL_CLI="$2"
      shift 2
      ;;
    --verifier)
      if [[ $# -lt 2 ]]; then echo "error: --verifier requires a value" >&2; exit 1; fi
      VERIFIER_CLI="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '1,40p' "$0" | tail -n +2
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

# CLI overrides env
CHAIN="${CHAIN_CLI:-${CHAIN:-${CHAIN_ID:-}}}"
VERIFIER_URL="${VERIFIER_URL_CLI:-${VERIFIER_URL:-}}"
VERIFIER="${VERIFIER_CLI:-${VERIFIER:-etherscan}}"

if [[ -n "$VERIFIER_URL" ]]; then
  VERIFIER="custom"
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

API_KEY="${VERIFIER_API_KEY:-${ETHERSCAN_API_KEY:-}}"

if $VERIFY; then
  if [[ -z "$API_KEY" ]]; then
    echo "error: VERIFIER_API_KEY or ETHERSCAN_API_KEY is required for verification (use --skip-verify to deploy only)" >&2
    exit 1
  fi
  export ETHERSCAN_API_KEY="$API_KEY"
fi

# forge reads PK_* and MINT_AUTHORITY from the environment for vm.envOr in GhostVaultScript
export PK_MINT_X_IMAG PK_MINT_X_REAL PK_MINT_Y_IMAG PK_MINT_Y_REAL MINT_AUTHORITY

echo "==> Deploying GhostVault (broadcast from $(basename "$SOL_ROOT"))"
echo "    RPC: ${RPC_URL:0:40}…"
if [[ -n "$CHAIN" ]]; then
  echo "    Chain: $CHAIN"
fi

forge_args=(
  script/GhostVault.s.sol:GhostVaultScript
  --rpc-url "$RPC_URL"
  --broadcast
  --private-key "$PRIVATE_KEY"
)

if [[ -n "$CHAIN" ]]; then
  forge_args+=(--chain "$CHAIN")
fi

if $VERIFY; then
  forge_args+=(--verify)
  case "$VERIFIER" in
    custom)
      if [[ -z "$VERIFIER_URL" ]]; then
        echo "error: VERIFIER_URL is required when using custom verification (or pass --verifier-url)" >&2
        exit 1
      fi
      forge_args+=(
        --verifier custom
        --verifier-url "$VERIFIER_URL"
        --verifier-api-key "$API_KEY"
      )
      ;;
    etherscan)
      forge_args+=(--verifier etherscan --etherscan-api-key "$API_KEY")
      ;;
    sourcify|blockscout|oklink)
      forge_args+=(--verifier "$VERIFIER" --verifier-api-key "$API_KEY")
      ;;
    *)
      echo "error: unknown VERIFIER='$VERIFIER' (use etherscan, sourcify, blockscout, oklink, or custom with VERIFIER_URL)" >&2
      exit 1
      ;;
  esac
  if [[ -z "$CHAIN" ]] && [[ -z "$VERIFIER_URL" ]] && [[ "$VERIFIER" == "etherscan" ]]; then
    echo "warning: CHAIN/CHAIN_ID not set — forge will infer from RPC; set CHAIN for clearer explorer matching" >&2
  fi
fi

forge script "${forge_args[@]}"

echo
echo "==> Done. Contract address: check latest run under broadcast/GhostVault.s.sol/<chainId>/run-latest.json"
echo "    or the console output above."
