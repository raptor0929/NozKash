#!/usr/bin/env bash
# =============================================================================
# ghost_flow.sh — Ghost-Tip Protocol: Full Lifecycle Runner
#
# Drives the complete Ghost-Tip eCash flow from a single script:
#   1. Check wallet balance
#   2. Deposit token (blind & submit)
#   3. Wait for mint server to sign the deposit
#   4. Scan chain for the signed token
#   5. Redeem the token to a recipient address
#
# In --mock mode, all chain interactions are replaced:
#   1. (skipped — no chain balance to check)
#   2. Deposit: client.py deposit --dry-run (derives + blinds, saves to wallet)
#   3. Mock mint: mint_mock.py (signs + unblinds + saves S to wallet)
#   4. (skipped — mock mint already wrote wallet state)
#   5. Redeem: client.py redeem --dry-run (generates calldata) then
#              redeem_mock.py verify (runs full contract verification)
#
# Usage:
#   ./ghost_flow.sh [OPTIONS]
#
# Options:
#   -i, --index    <n>       Token index to use (default: 0)
#   -t, --to       <addr>    Recipient address for redemption
#   -r, --relayer  <url>     Relayer URL (optional; relayer pays gas on redeem)
#   -b, --block    <n>       Start block for scan (default: from .env or 0)
#   -v, --verbose            Use verbose verbosity for client output
#   -q, --quiet              Use quiet verbosity for client output
#       --dry-run            Simulate all steps, broadcast nothing
#       --mock               Full offline mode: no chain, no RPC, no gas.
#                            Uses mock mint + mock redeemer for verification.
#                            Implies --dry-run for client commands.
#       --no-banner          Skip the ASCII banner
#       --skip-balance       Skip balance check
#       --skip-deposit       Skip deposit (assume already done)
#       --skip-scan          Skip scan (assume token already recovered)
#       --skip-redeem        Skip redemption step
#       --wait-mint  <s>     Seconds to wait for mint after deposit (default: 30)
#   -h, --help               Show this help
#
# Environment (.env must be present):
#   MASTER_SEED, WALLET_ADDRESS, WALLET_KEY,
#   CONTRACT_ADDRESS, RPC_HTTP_URL, SCAN_FROM_BLOCK
#
# For --mock mode, only MASTER_SEED and MINT_BLS_PRIVKEY_INT are required.
#
# Examples:
#   # Full flow, token 0, redeem to your own address
#   ./ghost_flow.sh --to 0xYourAddress
#
#   # Dry-run: generate all payloads without broadcasting
#   ./ghost_flow.sh --to 0xYourAddress --dry-run
#
#   # MOCK: full offline test — no chain, no gas, no RPC
#   ./ghost_flow.sh --to 0xYourAddress --mock
#
#   # Resume from scan (deposit already done)
#   ./ghost_flow.sh --to 0xYourAddress --skip-deposit
#
#   # Use a relayer for gas-free redemption
#   ./ghost_flow.sh --to 0xYourAddress --relayer http://localhost:8000
# =============================================================================

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INDEX=0
RECIPIENT=""
RELAYER=""
SCAN_FROM_BLOCK="${SCAN_FROM_BLOCK:-0}"
VERBOSITY="normal"
DRY_RUN=false
MOCK_MODE=false
SKIP_BALANCE=false
SKIP_DEPOSIT=false
SKIP_SCAN=false
SKIP_REDEEM=false
WAIT_MINT=30
SHOW_BANNER=true

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
log()      { echo -e "${CYAN}${BOLD}[ghost]${RESET}  $*"; }
log_ok()   { echo -e "${GREEN}${BOLD}  ✅${RESET}  $*"; }
log_warn() { echo -e "${YELLOW}${BOLD}  ⚠️ ${RESET}  $*"; }
log_err()  { echo -e "${RED}${BOLD}  ❌${RESET}  $*" >&2; }
log_dry()  { echo -e "${MAGENTA}${BOLD}  🔵 [DRY-RUN]${RESET}  $*"; }
log_mock() { echo -e "${MAGENTA}${BOLD}  🧪 [MOCK]${RESET}  $*"; }
log_sep()  { echo -e "${DIM}${CYAN}──────────────────────────────────────────────────${RESET}"; }
log_step() { echo; log_sep; echo -e "  ${BOLD}${CYAN}$*${RESET}"; log_sep; }

die() { log_err "$*"; exit 1; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

# ── Parse args ─────────────────────────────────────────────────────────────────
usage() {
    grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//' | head -60
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -i|--index)        INDEX="$2";          shift 2 ;;
        -t|--to)           RECIPIENT="$2";      shift 2 ;;
        -r|--relayer)      RELAYER="$2";        shift 2 ;;
        -b|--block)        SCAN_FROM_BLOCK="$2";shift 2 ;;
        -v|--verbose)      VERBOSITY="verbose"; shift   ;;
        -q|--quiet)        VERBOSITY="quiet";   shift   ;;
           --dry-run)      DRY_RUN=true;        shift   ;;
           --mock)         MOCK_MODE=true;
                           DRY_RUN=true;        shift   ;;
           --no-banner)    SHOW_BANNER=false;   shift   ;;
           --skip-balance) SKIP_BALANCE=true;   shift   ;;
           --skip-deposit) SKIP_DEPOSIT=true;   shift   ;;
           --skip-scan)    SKIP_SCAN=true;      shift   ;;
           --skip-redeem)  SKIP_REDEEM=true;    shift   ;;
           --wait-mint)    WAIT_MINT="$2";      shift 2 ;;
        -h|--help)         usage ;;
        *) die "Unknown option: $1" ;;
    esac
done

# ── Banner ─────────────────────────────────────────────────────────────────────
if $SHOW_BANNER; then
    echo
    echo -e "${CYAN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════╗"
    echo "  ║       👻  GHOST-TIP PROTOCOL FLOW  👻     ║"
    echo "  ║    Privacy-preserving eCash on Sepolia    ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo -e "${RESET}"
fi

# ── Pre-flight checks ──────────────────────────────────────────────────────────
require_cmd uv
require_cmd python3

if [[ ! -f ".env" ]]; then
    log_err ".env file not found."
    echo
    echo -e "  ${BOLD}Run:${RESET}  uv run generate_keys.py"
    echo -e "  ${DIM}This generates all keys and configuration needed.${RESET}"
    echo
    exit 1
fi

if ! $SKIP_REDEEM && [[ -z "$RECIPIENT" ]]; then
    die "Recipient address required. Use --to 0xYourAddress or --skip-redeem."
fi

# Announce mode prominently
if $MOCK_MODE; then
    echo
    echo -e "${MAGENTA}${BOLD}  ══════════════════════════════════════════════"
    echo   "   🧪  MOCK MODE  —  full offline verification"
    echo   "      No chain · No RPC · No gas · No contract"
    echo -e "  ══════════════════════════════════════════════${RESET}"
    echo
elif $DRY_RUN; then
    echo
    echo -e "${MAGENTA}${BOLD}  ══════════════════════════════════════════════"
    echo   "     🔵  DRY-RUN MODE  —  no transactions sent"
    echo -e "  ══════════════════════════════════════════════${RESET}"
    echo
fi

# Build shared client args
CLIENT_ARGS=("--verbosity" "$VERBOSITY")
DRY_FLAG=()
$DRY_RUN && DRY_FLAG=("--dry-run")

RELAYER_FLAG=()
[[ -n "$RELAYER" ]] && RELAYER_FLAG=("--relayer" "$RELAYER")

# ==============================================================================
# MOCK MODE FLOW
# ==============================================================================
if $MOCK_MODE; then

    # ── Step 1: Deposit (mock — derives secrets, blinds, saves wallet state, no chain)
    log_step "STEP 1 · Deposit Token (index=$INDEX) [mock]"
    uv run client.py deposit \
        --index "$INDEX" \
        --mock \
        "${CLIENT_ARGS[@]}"
    log_ok "Mock deposit complete. Wallet state created."

    # ── Step 2: Mock Mint Sign (replaces: wait for mint + scan chain)
    log_step "STEP 2 · Mock Mint Sign (index=$INDEX)"
    log_mock "No chain needed — re-deriving B from seed and signing directly."
    uv run mint_mock.py \
        --index "$INDEX" \
        --verbosity "$VERBOSITY"
    log_ok "Mock mint complete. Token signed and saved to wallet state."

    # ── Step 3: Redeem (mock — generates ECDSA proof, no calldata/chain needed)
    log_step "STEP 3 · Redeem Payload (index=$INDEX → $RECIPIENT)"
    uv run client.py redeem \
        --index "$INDEX" \
        --to    "$RECIPIENT" \
        --mock \
        "${CLIENT_ARGS[@]}"
    log_ok "Mock redeem payload generated."

    # ── Step 4: Mock Redeem Verify (full contract verification)
    log_step "STEP 4 · Mock Redeem Verify (GhostVault.redeem() simulation)"
    log_mock "Running ecrecover → nullifier check → BLS pairing off-chain."
    uv run redeem_mock.py \
        --index "$INDEX" \
        --to    "$RECIPIENT" \
        --verbosity "$VERBOSITY"
    log_ok "All contract checks passed. Token verified and marked spent."

    # ── Step 5: Final status
    log_step "STEP 5 · Final Wallet Status"
    uv run client.py status --mock "${CLIENT_ARGS[@]}"

    # ── Summary ────────────────────────────────────────────────────────────
    echo
    log_sep
    echo
    echo -e "  ${GREEN}${BOLD}🎉  MOCK FLOW COMPLETE${RESET}"
    echo -e "  ${DIM}Token #${INDEX}: deposit → mint → unblind → redeem — all verified offline.${RESET}"
    echo
    echo -e "  ${DIM}What was tested:${RESET}"
    echo -e "  ${DIM}  ✔  client.py deposit --mock   (derive secrets, blind B, save state)${RESET}"
    echo -e "  ${DIM}  ✔  mint_mock.py                (S' = sk·B, unblind, BLS verify, save S)${RESET}"
    echo -e "  ${DIM}  ✔  client.py redeem --mock    (load S, derive spend key, ECDSA proof)${RESET}"
    echo -e "  ${DIM}  ✔  redeem_mock.py              (ecrecover, nullifier, BLS pairing)${RESET}"
    echo
    exit 0
fi

# ==============================================================================
# NORMAL / DRY-RUN FLOW (original behavior, requires chain for scan)
# ==============================================================================

# ── Step 0: Balance ────────────────────────────────────────────────────────────
if ! $SKIP_BALANCE; then
    log_step "STEP 0 · Wallet Balance"
    uv run client.py balance "${CLIENT_ARGS[@]}"
fi

# ── Step 1: Deposit ────────────────────────────────────────────────────────────
if ! $SKIP_DEPOSIT; then
    log_step "STEP 1 · Deposit Token (index=$INDEX)"
    uv run client.py deposit \
        --index "$INDEX" \
        "${DRY_FLAG[@]}" \
        "${CLIENT_ARGS[@]}"
    log_ok "Deposit step complete."
fi

# ── Step 2: Wait for mint ──────────────────────────────────────────────────────
if ! $SKIP_SCAN && ! $SKIP_DEPOSIT; then
    if $DRY_RUN; then
        log_dry "Skipping mint wait in dry-run mode."
    else
        log_step "STEP 2 · Wait for Mint Server (~${WAIT_MINT}s)"
        log "Waiting ${WAIT_MINT}s for the mint server to sign the blinded point…"
        log "(Start mint_server.py in another terminal if it isn't running.)"

        # Count down with progress dots
        for i in $(seq 1 "$WAIT_MINT"); do
            printf "\r  ${DIM}${CYAN}%3ds remaining…${RESET}" $((WAIT_MINT - i))
            sleep 1
        done
        echo
        log_ok "Wait complete."
    fi
fi

# ── Step 3: Scan ───────────────────────────────────────────────────────────────
if ! $SKIP_SCAN; then
    log_step "STEP 3 · Scan Chain for Signed Token (index=$INDEX)"

    # Determine latest block for scan range
    if $DRY_RUN; then
        LATEST_BLOCK="latest"
        FROM_BLOCK="$SCAN_FROM_BLOCK"
        log_dry "Block range: $FROM_BLOCK → latest (not queried in dry-run)"
    else
        FROM_BLOCK="$SCAN_FROM_BLOCK"
        LATEST_BLOCK=$(uv run python3 -c "
from web3 import Web3
import os
from dotenv import load_dotenv
load_dotenv()
w3 = Web3(Web3.HTTPProvider(os.environ['RPC_HTTP_URL']))
print(w3.eth.block_number)
" 2>/dev/null || echo "0")
        log "Scanning blocks $FROM_BLOCK → $LATEST_BLOCK for index $INDEX"
    fi

    if $DRY_RUN; then
        log_dry "Scan would query blocks $FROM_BLOCK → latest for MintFulfilled events."
        log_dry "No chain queries performed in dry-run mode."
    else
        uv run client.py scan \
            --from-block "$FROM_BLOCK" \
            --index-from "$INDEX" \
            --index-to   "$INDEX" \
            "${CLIENT_ARGS[@]}"
        log_ok "Scan complete."
    fi
fi

# ── Step 4: Redeem ─────────────────────────────────────────────────────────────
if ! $SKIP_REDEEM; then
    log_step "STEP 4 · Redeem Token (index=$INDEX → $RECIPIENT)"

    if $DRY_RUN && $SKIP_SCAN; then
        log_dry "Skipping redeem dry-run: token not yet in wallet state (scan was skipped)."
    else
        uv run client.py redeem \
            --index "$INDEX" \
            --to    "$RECIPIENT" \
            "${DRY_FLAG[@]}" \
            "${RELAYER_FLAG[@]}" \
            "${CLIENT_ARGS[@]}"

        if $DRY_RUN; then
            log_dry "Redemption payload generated. Run without --dry-run to submit."
        else
            log_ok "Redemption complete. 0.001 ETH transferred to $RECIPIENT."
        fi
    fi
fi

# ── Step 5: Final status ───────────────────────────────────────────────────────
log_step "STEP 5 · Final Wallet Status"
uv run client.py status "${CLIENT_ARGS[@]}"

# ── Summary ────────────────────────────────────────────────────────────────────
echo
log_sep
echo
if $DRY_RUN; then
    echo -e "  ${MAGENTA}${BOLD}🔵  DRY-RUN COMPLETE${RESET}"
    echo -e "  ${DIM}All payloads generated. Re-run without --dry-run to broadcast.${RESET}"
else
    echo -e "  ${GREEN}${BOLD}🎉  GHOST-TIP FLOW COMPLETE${RESET}"
    echo -e "  ${DIM}Token #${INDEX} lifecycle finished successfully.${RESET}"
fi
echo
