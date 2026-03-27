"""
Ghost-Tip Protocol: CLI Wallet

Reference implementation of the full client lifecycle. Each command maps to
one phase of the protocol and prints every intermediate cryptographic value.

Commands:
    deposit   Blind a token and submit (or simulate) a deposit transaction
    scan      Scan chain events to find and recover pending/spendable tokens
    redeem    Unblind a recovered token and redeem it (directly or via relayer)
    status    Show wallet state: known tokens, balances, lifecycle stages
    balance   Query on-chain ETH balance for the wallet address

Flags:
    --mock      Offline mode: skip ALL chain interactions. Only MASTER_SEED and
                MINT_BLS_PRIVKEY_INT are needed in .env. Use with mint_mock.py
                and redeem_mock.py for a full offline test cycle.
    --dry-run   Generate payloads without broadcasting (still needs RPC for
                nonce/gas queries).

Configuration (.env):
    MASTER_SEED             Hex string seed (from generate_keys.py)    [always required]
    MINT_BLS_PRIVKEY_INT    BLS scalar for the mint                    [mock mode only]
    WALLET_ADDRESS          Ethereum address that pays gas             [chain mode only]
    WALLET_KEY              Private key for the above                  [chain mode only]
    CONTRACT_ADDRESS        Deployed GhostVault contract address       [chain mode only]
    RPC_HTTP_URL            HTTP RPC endpoint                          [chain mode only]
    SCAN_FROM_BLOCK         Block to start scanning from (default: 0)

Usage:
    uv run client.py deposit --index 0 --mock             # offline deposit
    uv run client.py deposit --index 0                    # real deposit
    uv run client.py deposit --index 0 --dry-run          # simulate with RPC
    uv run client.py scan --from-block 7000000
    uv run client.py redeem --index 0 --to 0xAddr --mock  # offline redeem payload
    uv run client.py redeem --index 0 --to 0xAddr
    uv run client.py status --mock                        # offline wallet status
    uv run client.py balance
"""

import json
import logging
import os
import sys
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Annotated, Optional

import requests
import typer
from dotenv import load_dotenv
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text
from rich.theme import Theme
from rich.traceback import install as install_rich_traceback
from web3 import Web3
from web3.exceptions import ContractCustomError, ContractLogicError

from contract_errors import decode_contract_error
from ghost_library import (
    G1Point, G2Point, Scalar,
    derive_token_secrets, blind_token, unblind_signature,
    generate_redemption_proof, serialize_g1, parse_g1,
    verify_bls_pairing, verify_ecdsa_mev_protection,
    GhostError, InvalidPointError, _mul_g2,
)

load_dotenv()

# ── Rich setup ─────────────────────────────────────────────────────────────────

ghost_theme = Theme({
    "primary":   "bold cyan",
    "secondary": "dim cyan",
    "success":   "bold green",
    "warning":   "bold yellow",
    "error":     "bold red",
    "muted":     "dim white",
    "label":     "bold white",
    "value":     "cyan",
    "addr":      "yellow",
    "hash":      "magenta",
    "num":       "bright_blue",
    "accent":    "bright_cyan",
    "banner":    "bold bright_cyan",
    "dryrun":    "bold magenta",
    "step":      "bold cyan",
})

console = Console(theme=ghost_theme, highlight=False)
install_rich_traceback(console=console, show_locals=False)

# ── Verbosity ──────────────────────────────────────────────────────────────────

class Verbosity(str, Enum):
    quiet   = "quiet"    # minimal output, just final result
    normal  = "normal"   # key steps and results (default)
    verbose = "verbose"  # all intermediate cryptographic values
    debug   = "debug"    # + raw hex, encoded calldata, etc.


_verbosity: Verbosity = Verbosity.normal
_dry_run: bool = False
_mock_mode: bool = False


def is_verbose() -> bool:
    return _verbosity in (Verbosity.verbose, Verbosity.debug)


def is_debug() -> bool:
    return _verbosity == Verbosity.debug


def is_quiet() -> bool:
    return _verbosity == Verbosity.quiet


def is_dry_run() -> bool:
    return _dry_run


def is_mock() -> bool:
    return _mock_mode


# ── Formatting helpers ─────────────────────────────────────────────────────────

DENOMINATION_WEI = 1_000_000_000_000_000  # 0.001 ETH


def _short(val: str, head: int = 10, tail: int = 8) -> str:
    if len(val) <= head + tail + 3:
        return val
    return f"{val[:head]}…{val[-tail:]}"


def _fmt_addr(address: str) -> Text:
    t = Text()
    t.append(address[:6], "addr")
    t.append("…", "muted")
    t.append(address[-4:], "addr")
    return t


def _fmt_hex(value: str, width: int = 22) -> Text:
    d = value if len(value) <= width else value[:width] + "…"
    return Text(d, style="hash")


def _kv_table(rows: list[tuple[str, object]], title: str = "", border: str = "secondary") -> Panel:
    table = Table(box=box.SIMPLE, show_header=False, padding=(0, 2), border_style=border)
    table.add_column("Key",   style="label", no_wrap=True)
    table.add_column("Value", style="value", no_wrap=False)
    for k, v in rows:
        if isinstance(v, Text):
            table.add_row(k, v)
        else:
            table.add_row(k, str(v))
    return Panel(table, title=f"[primary]{title}[/primary]" if title else "", border_style=border, padding=(0, 1))


def print_banner() -> None:
    mode_tag = ""
    if _mock_mode:
        mode_tag = "  [dryrun][ MOCK ][/dryrun]"
    elif _dry_run:
        mode_tag = "  [dryrun][ DRY-RUN ][/dryrun]"
    console.print()
    console.print(Panel(
        Text.assemble(("👻  ", ""), ("GHOST-TIP CLI WALLET", "banner"), ("  👻", ""), (mode_tag, "")),
        subtitle=Text("eCash · BLS Blind Signatures · Sepolia", style="secondary"),
        border_style="cyan",
        padding=(0, 4),
    ))
    console.print()


def section(title: str, icon: str = "──") -> None:
    if not is_quiet():
        console.print(Rule(f"[step]{icon}  {title}[/step]", style="dim cyan"))


def ok(msg: str) -> None:
    console.print(Text(f"  ✅  {msg}", style="success"))


def warn(msg: str) -> None:
    console.print(Text(f"  ⚠️   {msg}", style="warning"))


def err(msg: str) -> None:
    console.print(Text(f"  ❌  {msg}", style="error"))


def info(msg: str, muted: bool = False) -> None:
    if not is_quiet():
        console.print(Text(f"  {msg}", style="muted" if muted else ""))


def dry(msg: str) -> None:
    """Print a message that only shows in dry-run mode."""
    console.print(Text(f"  🔵  [DRY-RUN] {msg}", style="dryrun"))


def kv(label: str, value: object, style: str = "value") -> None:
    if is_quiet():
        return
    v = str(value) if not isinstance(value, Text) else value
    console.print(Text.assemble(
        (f"    {label:<28} ", "label"),
        (v if isinstance(v, str) else str(v), style),
    ))


def kv_hex(label: str, value: str) -> None:
    """Print a key-value pair with hex truncation in normal mode, full in verbose."""
    if is_quiet():
        return
    display = value if is_verbose() else _short(value, 18, 8)
    kv(label, display, style="hash")


# ── Wallet state ───────────────────────────────────────────────────────────────

WALLET_STATE_FILE = Path(__file__).resolve().parent / ".." / ".ghost_wallet.json"

@dataclass
class TokenRecord:
    index:         int
    spend_address: str
    deposit_id:    str
    deposit_tx:    Optional[str] = None
    deposit_block: Optional[int] = None
    s_unblinded_x: Optional[str] = None
    s_unblinded_y: Optional[str] = None
    redeem_tx:     Optional[str] = None
    spent:         bool = False

    @property
    def has_token(self) -> bool:
        return self.s_unblinded_x is not None

    @property
    def status(self) -> str:
        if self.spent:
            return "SPENT"
        if self.has_token:
            return "READY_TO_REDEEM"
        return "AWAITING_MINT" if self.deposit_tx else "FRESH"

    @property
    def status_styled(self) -> Text:
        s = self.status
        colours = {
            "SPENT":            "dim white",
            "READY_TO_REDEEM":  "bold green",
            "AWAITING_MINT":    "yellow",
            "FRESH":            "dim",
        }
        return Text(s, style=colours.get(s, "white"))


@dataclass
class WalletState:
    tokens: dict[int, TokenRecord] = field(default_factory=dict)
    last_scanned_block: int = 0

    def save(self) -> None:
        data = {
            "tokens": {str(idx): asdict(rec) for idx, rec in self.tokens.items()},
            "last_scanned_block": self.last_scanned_block,
        }
        WALLET_STATE_FILE.write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls) -> "WalletState":
        if not WALLET_STATE_FILE.exists():
            return cls()
        data = json.loads(WALLET_STATE_FILE.read_text())
        tokens = {int(idx): TokenRecord(**rec) for idx, rec in data.get("tokens", {}).items()}
        return cls(tokens=tokens, last_scanned_block=data.get("last_scanned_block", 0))


# ── Config ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ClientConfig:
    master_seed:      bytes
    wallet_address:   str            # may be empty in mock mode
    wallet_key:       str            # may be empty in mock mode
    contract_address: str            # may be empty in mock mode
    rpc_http_url:     str            # may be empty in mock mode
    scan_from_block:  int
    mint_bls_pubkey:  G2Point | None = None  # parsed G2 point, None if not configured


def _parse_mint_bls_pubkey(raw: str) -> G2Point | None:
    """
    Parse MINT_BLS_PUBKEY env var (4 comma-separated hex uint256 in EIP-197 order:
    X_imag, X_real, Y_imag, Y_real) into a py_ecc G2Point.
    Falls back to deriving from MINT_BLS_PRIVKEY if available.
    """
    from py_ecc.bn128 import FQ2, G2 as G2_gen

    if raw:
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) == 4:
            x_imag, x_real, y_imag, y_real = (int(p, 16) for p in parts)
            return G2Point((FQ2([x_real, x_imag]), FQ2([y_real, y_imag])))

    sk_hex = os.getenv("MINT_BLS_PRIVKEY", "").strip() or os.getenv("MINT_BLS_PRIVKEY_INT", "").strip()
    if sk_hex:
        sk_int = int(sk_hex, 16) if sk_hex.startswith("0x") else int(sk_hex)
        return _mul_g2(G2Point(G2_gen), Scalar(sk_int))

    return None


def load_config() -> ClientConfig:
    """
    Load configuration from .env.

    In mock mode (--mock flag), only MASTER_SEED is required.
    Chain-specific vars (WALLET_*, CONTRACT_*, RPC_*) are loaded if present
    but won't cause errors if missing — they're not needed for offline ops.

    In normal mode, all variables are required.
    """
    seed_hex = os.getenv("MASTER_SEED", "").strip()

    if not seed_hex:
        console.print(Panel(
            Text.assemble(
                ("Missing MASTER_SEED in .env.\n\n", "error"),
                ("Run ", "secondary"), ("uv run generate_keys.py", "label"),
                (" to create all required keys.", "secondary"),
            ),
            title="[error]❌  Configuration Error[/error]",
            border_style="red",
        ))
        raise typer.Exit(code=1)

    wallet_addr = os.getenv("WALLET_ADDRESS", "").strip()
    wallet_key  = os.getenv("WALLET_KEY", "").strip()
    contract    = os.getenv("CONTRACT_ADDRESS", "").strip()
    rpc_url     = os.getenv("RPC_HTTP_URL", "").strip()

    # In normal (non-mock) mode, require chain settings
    if not is_mock():
        missing = []
        if not wallet_addr: missing.append("WALLET_ADDRESS")
        if not wallet_key:  missing.append("WALLET_KEY")
        if not contract:    missing.append("CONTRACT_ADDRESS")
        if not rpc_url:     missing.append("RPC_HTTP_URL")

        if missing:
            console.print(Panel(
                Text.assemble(
                    ("Missing .env variables:\n\n", "error"),
                    *[Text.assemble(("  • ", "muted"), (k, "label"), ("\n", "")) for k in missing],
                    ("\nRun ", "secondary"), ("uv run generate_keys.py", "label"),
                    (" then add wallet/rpc settings.\n", "secondary"),
                    ("Or use ", "secondary"), ("--mock", "label"),
                    (" for offline testing (only MASTER_SEED needed).", "secondary"),
                ),
                title="[error]❌  Configuration Error[/error]",
                border_style="red",
            ))
            raise typer.Exit(code=1)

    pk = _parse_mint_bls_pubkey(os.getenv("MINT_BLS_PUBKEY", "").strip())

    return ClientConfig(
        master_seed=seed_hex.encode("utf-8"),
        wallet_address=wallet_addr,
        wallet_key=wallet_key if wallet_key.startswith("0x") else ("0x" + wallet_key if wallet_key else ""),
        contract_address=contract,
        rpc_http_url=rpc_url,
        scan_from_block=int(os.getenv("SCAN_FROM_BLOCK", "0")),
        mint_bls_pubkey=pk,
    )


# ── Contract ABI ───────────────────────────────────────────────────────────────

_ABI_PATH = Path(__file__).resolve().parent / ".." / "sol" / "ghost_vault_abi.json"
GHOST_VAULT_ABI = json.loads(_ABI_PATH.read_text())


# ── Helpers ────────────────────────────────────────────────────────────────────

def encode_spend_signature(compact_hex: str, recovery_bit: int) -> bytes:
    r_bytes = bytes.fromhex(compact_hex[:64])
    s_bytes = bytes.fromhex(compact_hex[64:])
    v_byte  = bytes([recovery_bit + 27])
    return r_bytes + s_bytes + v_byte


def build_web3(config: ClientConfig) -> Web3:
    w3 = Web3(Web3.HTTPProvider(config.rpc_http_url))
    if not w3.is_connected():
        err(f"Cannot connect to RPC: {config.rpc_http_url}")
        raise typer.Exit(code=1)
    return w3


# ── Command: deposit ───────────────────────────────────────────────────────────

def cmd_deposit(config: ClientConfig, token_index: int) -> None:
    print_banner()
    section(f"DEPOSIT  ·  Token #{token_index}", "📥")

    state = WalletState.load()

    # Step 1: derive
    section("Step 1 · Derive Token Secrets", "🔑")
    secrets = derive_token_secrets(config.master_seed, token_index)

    kv("Token index",    str(token_index))
    kv("Spend address",  secrets.spend.address, style="addr")
    kv("Blind address",  secrets.blind.address, style="addr")
    if is_verbose():
        kv_hex("Blinding scalar r", hex(secrets.r))

    info("Spend address = nullifier (revealed only at redemption)", muted=True)
    info("Blind address = deposit ID (submitted with deposit tx)", muted=True)
    console.print()

    # Step 2: blind
    section("Step 2 · Blind Token → G1", "🎭")
    blinded  = blind_token(secrets.spend_address_bytes, secrets.r)
    b_x, b_y = serialize_g1(blinded.B)
    y_x, y_y = serialize_g1(blinded.Y)

    if is_verbose():
        kv_hex("Y = H(spend_addr) x", hex(y_x))
        kv_hex("Y = H(spend_addr) y", hex(y_y))
    kv_hex("B = r·Y  x", hex(b_x))
    kv_hex("B = r·Y  y", hex(b_y))
    kv("Deposit ID",  secrets.deposit_id, style="addr")
    info("B is the blinded point — mint cannot derive spend address without r", muted=True)
    console.print()

    # ── Mock / dry-run: skip chain interaction entirely ────────────────────
    if is_mock():
        section("Step 3 · Save Token (mock — no chain)", "🧪")
        dry("deposit([B.x, B.y], depositId) with value=0.001 ETH")
        dry(f"B.x       = {hex(b_x)}")
        dry(f"B.y       = {hex(b_y)}")
        dry(f"depositId = {secrets.deposit_id}")
        dry("No calldata built (mock mode — no contract needed)")

        state.tokens[token_index] = TokenRecord(
            index=token_index,
            spend_address=secrets.spend.address,
            deposit_id=secrets.deposit_id,
            deposit_tx="mock-no-broadcast",
            deposit_block=None,
        )
        state.save()
        ok("Mock deposit complete. Token saved to wallet state.")
        return

    # ── Chain interaction required from here ───────────────────────────────
    w3 = build_web3(config)

    # Step 3: build calldata / simulate
    section("Step 3 · Build deposit() Calldata", "📋")
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )
    wallet    = Web3.to_checksum_address(config.wallet_address)
    nonce     = w3.eth.get_transaction_count(wallet)
    gas_price = w3.eth.gas_price
    balance   = w3.eth.get_balance(wallet)

    kv("Wallet address",  wallet, style="addr")
    kv("Balance",         f"{Web3.from_wei(balance, 'ether'):.6f} ETH")
    kv("Nonce",           str(nonce))
    kv("Gas price",       f"{Web3.from_wei(gas_price, 'gwei'):.2f} gwei")
    kv("Deposit amount",  "0.001 ETH")

    if not is_dry_run() and balance < DENOMINATION_WEI:
        err("Insufficient balance: need at least 0.001 ETH")
        raise typer.Exit(code=1)

    try:
        tx = contract.functions.deposit(
            Web3.to_checksum_address(secrets.deposit_id),
            [b_x, b_y],
        ).build_transaction({
            "from":     wallet,
            "value":    DENOMINATION_WEI,
            "nonce":    nonce,
            "gasPrice": gas_price,
        })
    except (ContractCustomError, ContractLogicError) as exc:
        err(f"Contract reverted: {decode_contract_error(exc)}")
        raise typer.Exit(code=1) from exc

    if is_debug():
        kv_hex("Calldata", tx["data"][:80] + "…")

    console.print()

    # Step 4: broadcast or simulate
    section("Step 4 · Broadcast", "📡")

    if is_dry_run():
        dry(f"deposit([B.x, B.y], depositId) with value=0.001 ETH")
        dry(f"from={wallet}")
        dry(f"to={config.contract_address}")
        dry(f"B.x = {hex(b_x)}")
        dry(f"B.y = {hex(b_y)}")
        dry(f"depositId = {secrets.deposit_id}")
        dry("Transaction NOT sent (dry-run mode)")

        state.tokens[token_index] = TokenRecord(
            index=token_index,
            spend_address=secrets.spend.address,
            deposit_id=secrets.deposit_id,
            deposit_tx="dry-run-not-broadcast",
            deposit_block=None,
        )
        state.save()
        ok("Dry-run complete. Run without --dry-run to broadcast.")
        return

    signed  = w3.eth.account.sign_transaction(tx, private_key=config.wallet_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    kv("Transaction sent", tx_hash.hex(), style="hash")
    info("Waiting for confirmation…")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt["status"] != 1:
        err(f"Transaction REVERTED  tx={tx_hash.hex()}")
        raise typer.Exit(code=1)

    kv("Confirmed block",   str(receipt["blockNumber"]))
    kv("Gas used",          str(receipt["gasUsed"]))
    kv("Deposit ID",        secrets.deposit_id, style="addr")

    state.tokens[token_index] = TokenRecord(
        index=token_index,
        spend_address=secrets.spend.address,
        deposit_id=secrets.deposit_id,
        deposit_tx=tx_hash.hex(),
        deposit_block=receipt["blockNumber"],
    )
    state.save()

    console.print()
    ok("Deposit complete. Next: run 'scan' to recover the signed token.")


# ── Command: scan ──────────────────────────────────────────────────────────────

def cmd_scan(
    config: ClientConfig,
    from_block: Optional[int],
    index_from: int,
    index_to: int,
) -> None:
    print_banner()
    section(f"SCAN  ·  Tokens {index_from}–{index_to}", "🔍")

    state    = WalletState.load()
    w3       = build_web3(config)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )

    start_block  = from_block if from_block is not None else state.last_scanned_block
    latest_block = w3.eth.block_number

    kv("Scanning blocks", f"{start_block} → {latest_block}")
    kv("Token indices",   f"{index_from} – {index_to}")
    console.print()

    # Fetch events
    section("Step 1 · Fetch MintFulfilled Events", "📡")
    fulfilled_events = contract.events.MintFulfilled().get_logs(
        from_block=start_block,
        to_block=latest_block,
    )
    kv("Events found", str(len(fulfilled_events)))

    fulfilled: dict[str, tuple[int, int]] = {}
    for evt in fulfilled_events:
        did = Web3.to_checksum_address(evt["args"]["depositId"])
        sig = evt["args"]["S_prime"]
        fulfilled[did] = (int(sig[0]), int(sig[1]))
        if is_verbose():
            kv_hex(f"  S'.x [{_short(did, 6, 4)}]", hex(int(sig[0])))

    console.print()
    section("Step 2 · Match Tokens by Deposit ID", "🔗")

    scan_indices = range(index_from, index_to + 1)
    recovered = 0

    for idx in scan_indices:
        existing = state.tokens.get(idx)
        secrets    = derive_token_secrets(config.master_seed, idx)
        deposit_id = Web3.to_checksum_address(secrets.deposit_id)

        # Ensure a record exists
        if existing is None:
            existing = TokenRecord(
                index=idx,
                spend_address=secrets.spend.address,
                deposit_id=deposit_id,
            )
            state.tokens[idx] = existing

        # Skip tokens that were never deposited — nothing to scan for
        if existing.status == "FRESH":
            continue

        # Already redeemed — just show status
        if existing.spent:
            if not is_quiet():
                console.print(Text.assemble(
                    ("\n  Token ", "muted"), (str(idx), "num"),
                    ("  ·  ", "muted"), existing.status_styled,
                ))
            continue

        # Already have unblinded signature — show cached status, skip re-processing
        if existing.has_token:
            if not is_quiet():
                console.print(Text.assemble(
                    ("\n  Token ", "muted"), (str(idx), "num"),
                    ("  ·  ", "muted"), existing.status_styled,
                    ("  (cached)", "muted"),
                ))
            continue

        # AWAITING_MINT — deposited but no signature yet, check events
        if not is_quiet():
            console.print(Text.assemble(
                ("\n  Token ", "muted"), (str(idx), "num"),
                ("  ·  ", "muted"), existing.status_styled,
            ))

        if deposit_id not in fulfilled:
            info(f"  No MintFulfilled yet for deposit ID {_short(deposit_id, 8, 6)}", muted=True)
            continue

        s_prime_x, s_prime_y = fulfilled[deposit_id]
        if is_verbose():
            kv_hex("  S'.x (blind sig)", hex(s_prime_x))
            kv_hex("  S'.y (blind sig)", hex(s_prime_y))

        info("  Unblinding: S = S' · r⁻¹ mod q …")
        S_prime  = parse_g1(s_prime_x, s_prime_y)
        S        = unblind_signature(S_prime, secrets.r)
        s_x, s_y = serialize_g1(S)

        if is_verbose():
            kv_hex("  S.x (unblinded)", hex(s_x))
            kv_hex("  S.y (unblinded)", hex(s_y))

        # Local BLS verification against mint public key
        if config.mint_bls_pubkey is not None:
            Y = blind_token(secrets.spend_address_bytes, secrets.r).Y
            bls_ok = verify_bls_pairing(S, Y, config.mint_bls_pubkey)
            if bls_ok:
                ok("  BLS pairing verified locally ✓")
            else:
                err("  BLS pairing FAILED — signature does not match mint public key.")
                err("  This token will be rejected on-chain. Check MINT_BLS_PUBKEY in .env.")
        else:
            info("  MINT_BLS_PUBKEY not configured — skipping local BLS check.", muted=True)

        # On-chain nullifier check
        nullifier_addr = Web3.to_checksum_address(secrets.spend.address)
        is_spent       = contract.functions.spentNullifiers(nullifier_addr).call()

        existing.s_unblinded_x = hex(s_x)
        existing.s_unblinded_y = hex(s_y)
        existing.spent         = is_spent
        recovered += 1

        console.print(Text.assemble(
            ("  → ", "muted"), existing.status_styled,
        ))

    state.last_scanned_block = latest_block
    state.save()

    console.print()
    console.print(Rule(style="dim cyan"))
    kv("Scan complete", f"{recovered} token(s) recovered · block {latest_block} saved")


# ── Command: redeem ────────────────────────────────────────────────────────────

def cmd_redeem(
    config: ClientConfig,
    token_index: int,
    recipient: str,
    relayer_url: Optional[str] = None,
) -> None:
    print_banner()
    section(f"REDEEM  ·  Token #{token_index}  →  {recipient}", "💸")

    state = WalletState.load()

    if token_index not in state.tokens:
        err(f"Token {token_index} not found in wallet state. Run 'deposit' first.")
        raise typer.Exit(code=1)

    rec = state.tokens[token_index]

    if rec.spent:
        err(f"Token {token_index} is already spent.")
        raise typer.Exit(code=1)

    if not rec.has_token:
        hint = "'mint_mock.py sign'" if is_mock() else "'scan'"
        err(f"Token {token_index} has no unblinded signature. Run {hint} first.")
        raise typer.Exit(code=1)

    # Derive secrets early — needed for verbose output, BLS check, and step 2
    secrets = derive_token_secrets(config.master_seed, token_index)

    if is_verbose():
        section("Intermediate Values", "🔬")
        kv("Spend address (nullifier)", secrets.spend.address, style="addr")
        kv("Deposit ID",               secrets.deposit_id, style="addr")
        kv_hex("Blinding scalar r",     hex(secrets.r))
        blinded = blind_token(secrets.spend_address_bytes, secrets.r)
        kv_hex("Y.x (hash-to-curve)",   hex(blinded.Y[0].n))
        kv_hex("Y.y (hash-to-curve)",   hex(blinded.Y[1].n))
        kv_hex("B.x (blinded point)",   hex(blinded.B[0].n))
        kv_hex("B.y (blinded point)",   hex(blinded.B[1].n))
        console.print()

    # Step 1: load S
    section("Step 1 · Load Unblinded Signature", "🔓")
    s_x = int(rec.s_unblinded_x, 16)
    s_y = int(rec.s_unblinded_y, 16)
    S   = parse_g1(s_x, s_y)
    kv_hex("S.x", hex(s_x))
    kv_hex("S.y", hex(s_y))

    # Local BLS verification before attempting on-chain redeem
    if config.mint_bls_pubkey is not None:
        Y = blind_token(secrets.spend_address_bytes, secrets.r).Y
        bls_ok = verify_bls_pairing(S, Y, config.mint_bls_pubkey)
        if bls_ok:
            ok("BLS pairing verified locally ✓")
        else:
            err("BLS pairing FAILED locally — this token will be rejected on-chain.")
            err("Possible causes: wrong MINT_BLS_PUBKEY, corrupted signature, or mint key mismatch.")
            raise typer.Exit(code=1)
    else:
        info("MINT_BLS_PUBKEY not configured — skipping local BLS check.", muted=True)
    console.print()

    # Step 2: derive spend key
    section("Step 2 · Derive Spend Key", "🔑")
    kv("Spend address (nullifier)", secrets.spend.address, style="addr")
    kv("Deposit ID",               secrets.blind.address,  style="addr")
    info("The spend address is the nullifier — recorded as spent after redemption.", muted=True)
    console.print()

    # Step 3: generate redemption proof (pure crypto — no chain needed)
    section("Step 3 · Generate Anti-MEV ECDSA Proof", "🛡️")
    recipient_checksum = Web3.to_checksum_address(recipient)
    proof = generate_redemption_proof(secrets.spend_priv, recipient_checksum)

    kv("Payload",       f'"Pay to RAW: " || {recipient_checksum} (32 bytes, abi.encodePacked)')
    kv_hex("msg_hash",  proof.msg_hash.hex())
    kv_hex("compact_hex", "0x" + proof.compact_hex)
    kv("recovery_bit",  str(proof.recovery_bit))
    kv("v (EVM)",       str(proof.recovery_bit + 27))
    info("ecrecover on-chain will recover the spend address from this signature.", muted=True)

    # Local ecrecover verification
    is_valid = verify_ecdsa_mev_protection(
        proof.msg_hash, proof.compact_hex, proof.recovery_bit, secrets.spend.address,
    )
    if is_valid:
        ok("Local ecrecover check passed")
    else:
        err("Local ECDSA verification failed — aborting.")
        raise typer.Exit(code=1)

    spend_sig_bytes = encode_spend_signature(proof.compact_hex, proof.recovery_bit)
    if is_debug():
        kv_hex("Encoded sig (65 bytes)", "0x" + spend_sig_bytes.hex())
    console.print()

    # ── Mock mode: skip calldata / broadcasting entirely ──────────────────
    nullifier_checksum = Web3.to_checksum_address(secrets.spend.address)
    if is_mock():
        section("Step 4 · Mock Redemption Payload", "🧪")
        dry("redeem(recipient, spendSignature, nullifier, S)")
        dry(f"recipient  = {recipient_checksum}")
        dry(f"nullifier  = {nullifier_checksum}")
        dry(f"S.x        = {hex(s_x)}")
        dry(f"S.y        = {hex(s_y)}")
        dry(f"v          = {proof.recovery_bit + 27}  (recovery_bit + 27)")
        dry(f"sig        = 0x{spend_sig_bytes.hex()[:40]}…")
        dry("No calldata built (mock mode — no contract needed)")
        ok("Mock redemption payload generated. Run 'redeem_mock.py verify' to validate.")
        return

    # ── Chain interaction required from here ───────────────────────────────
    w3 = build_web3(config)

    # Step 4: build calldata
    section("Step 4 · Build redeem() Calldata", "📋")
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )

    # Read the mint's BLS public key from the contract
    if is_verbose():
        pk_vals = [contract.functions.pkMint(i).call() for i in range(4)]
        kv("On-chain pkMint[0]", hex(pk_vals[0]), style="hash")
        kv("On-chain pkMint[1]", hex(pk_vals[1]), style="hash")
        kv("On-chain pkMint[2]", hex(pk_vals[2]), style="hash")
        kv("On-chain pkMint[3]", hex(pk_vals[3]), style="hash")

        # Cross-check against local MINT_BLS_PUBKEY if configured
        if config.mint_bls_pubkey is not None:
            pk = config.mint_bls_pubkey
            local_vals = [pk[0].coeffs[1].n, pk[0].coeffs[0].n, pk[1].coeffs[1].n, pk[1].coeffs[0].n]
            if local_vals == pk_vals:
                ok("On-chain pkMint matches local MINT_BLS_PUBKEY ✓")
            else:
                err("On-chain pkMint does NOT match local MINT_BLS_PUBKEY!")
                err("The contract was deployed with a different mint key than your .env.")
                raise typer.Exit(code=1)
        console.print()

    ZERO = "0x0000000000000000000000000000000000000000"
    try:
        calldata = contract.functions.redeem(
            recipient_checksum, spend_sig_bytes, nullifier_checksum, [s_x, s_y],
        ).build_transaction({"from": ZERO})["data"]
    except (ContractCustomError, ContractLogicError) as exc:
        err(f"Contract reverted during simulation: {decode_contract_error(exc)}")
        raise typer.Exit(code=1) from exc

    kv("Recipient",     recipient_checksum, style="addr")
    kv("Nullifier",     nullifier_checksum, style="addr")
    kv("S.x",          str(s_x), style="num")
    kv("S.y",          str(s_y), style="num")
    kv("Calldata size", f"{len(bytes.fromhex(calldata[2:]))} bytes")
    if is_debug():
        kv_hex("Calldata prefix", calldata[:40] + "…")
    console.print()

    # Step 5: dry-run or broadcast
    if is_dry_run():
        section("Step 5 · DRY-RUN Simulation", "🔵")
        dry("redeem(recipient, spendSignature, nullifier, S)")
        dry(f"recipient  = {recipient_checksum}")
        dry(f"nullifier  = {nullifier_checksum}")
        dry(f"S.x        = {hex(s_x)}")
        dry(f"S.y        = {hex(s_y)}")
        dry(f"v          = {proof.recovery_bit + 27}  (recovery_bit + 27)")
        dry(f"calldata   = {calldata[:42]}…")
        dry("Transaction NOT sent (dry-run mode)")
        ok("Dry-run redemption proof generated successfully.")
        return

    if relayer_url:
        section("Step 5 · Broadcast via Relayer", "📡")
        kv("Relayer URL", relayer_url)
        info("Sending calldata to relayer — no local ETH required.")

        try:
            resp = requests.post(
                relayer_url.rstrip("/") + "/relay",
                json={"calldata": calldata},
                timeout=180,
            )
        except requests.exceptions.ConnectionError as exc:
            err(f"Cannot connect to relayer at {relayer_url}: {exc}")
            raise typer.Exit(code=1) from exc

        if not resp.ok:
            err(f"Relayer returned {resp.status_code}: {resp.text}")
            raise typer.Exit(code=1)

        result = resp.json()
        tx_hex = result["tx_hash"]
        kv("Transaction hash",    tx_hex, style="hash")
        kv("Confirmed at block",  str(result["block_number"]))
        kv("Gas used",            str(result["gas_used"]))
    else:
        section("Step 5 · Broadcast Directly", "📡")
        wallet    = Web3.to_checksum_address(config.wallet_address)
        nonce     = w3.eth.get_transaction_count(wallet)
        gas_price = w3.eth.gas_price
        kv("Caller (pays gas)", wallet, style="addr")
        kv("Nonce",             str(nonce))
        kv("Gas price",         f"{Web3.from_wei(gas_price, 'gwei'):.2f} gwei")

        try:
            tx = contract.functions.redeem(
                recipient_checksum, spend_sig_bytes, nullifier_checksum, [s_x, s_y],
            ).build_transaction({
                "from": wallet, "nonce": nonce, "gasPrice": gas_price,
            })
        except (ContractCustomError, ContractLogicError) as exc:
            err(f"Contract reverted during simulation: {decode_contract_error(exc)}")
            raise typer.Exit(code=1) from exc

        signed  = w3.eth.account.sign_transaction(tx, private_key=config.wallet_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        tx_hex  = tx_hash.hex()
        kv("Transaction sent", tx_hex, style="hash")
        info("Waiting for confirmation…")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt["status"] != 1:
            err(f"Transaction REVERTED  tx={tx_hex}")
            raise typer.Exit(code=1)

        kv("Confirmed block",  str(receipt["blockNumber"]))
        kv("Gas used",         str(receipt["gasUsed"]))

    console.print()
    ok("On-chain checks passed:")
    info("  ✔  ecrecover → nullifier matches spend address")
    info("  ✔  spentNullifiers[nullifier] was false")
    info("  ✔  ecPairing: e(S, G2) == e(H(nullifier), PK_mint)")
    info(f"  ✔  0.001 ETH transferred to {recipient_checksum}")

    rec.redeem_tx = tx_hex
    rec.spent     = True
    state.save()

    console.print()
    ok(f"Redemption complete. Token {token_index} is now spent.")


# ── Command: status ────────────────────────────────────────────────────────────

def cmd_status(config: ClientConfig) -> None:
    print_banner()
    section("WALLET STATUS", "📊")

    state = WalletState.load()

    if is_mock():
        # Mock mode: show wallet state without chain queries
        console.print(_kv_table([
            ("Mode",           "🧪 MOCK (offline)"),
            ("Last scanned",   f"block {state.last_scanned_block}"),
        ], title="📊  Wallet Status"))
    else:
        w3      = build_web3(config)
        wallet  = Web3.to_checksum_address(config.wallet_address)
        balance = w3.eth.get_balance(wallet)

        console.print(_kv_table([
            ("Wallet address", wallet),
            ("ETH balance",    f"{Web3.from_wei(balance, 'ether'):.6f} ETH"),
            ("Last scanned",   f"block {state.last_scanned_block}"),
        ], title="💰  On-chain Balance"))

    console.print()

    if not state.tokens:
        info("No tokens in wallet state. Run 'deposit' to create one.")
        return

    # Token table
    table = Table(
        title="Token Records",
        box=box.ROUNDED,
        border_style="cyan",
        show_lines=False,
        padding=(0, 1),
    )
    table.add_column("#",           style="num",    justify="right", no_wrap=True)
    table.add_column("Status",      no_wrap=True)
    table.add_column("Spend addr",  style="addr",   no_wrap=True)
    table.add_column("Deposit ID",  style="secondary", no_wrap=True)
    table.add_column("Deposit tx",  style="hash",   no_wrap=True)
    table.add_column("Redeem tx",   style="hash",   no_wrap=True)

    for idx in sorted(state.tokens):
        rec = state.tokens[idx]
        table.add_row(
            str(idx),
            rec.status_styled,
            _short(rec.spend_address, 6, 4),
            _short(rec.deposit_id, 6, 4),
            _short(rec.deposit_tx, 8, 6) if rec.deposit_tx else "—",
            _short(rec.redeem_tx,  8, 6) if rec.redeem_tx  else "—",
        )

    console.print(table)


# ── Command: balance ───────────────────────────────────────────────────────────

def cmd_balance(config: ClientConfig) -> None:
    print_banner()

    if is_mock():
        warn("Balance check is not available in mock mode (no chain connection).")
        return

    w3      = build_web3(config)
    wallet  = Web3.to_checksum_address(config.wallet_address)
    balance = w3.eth.get_balance(wallet)

    console.print(_kv_table([
        ("Address", wallet),
        ("Balance", f"{Web3.from_wei(balance, 'ether'):.8f} ETH"),
        ("Wei",     str(balance)),
    ], title="💰  Balance"))


# ── Typer app ──────────────────────────────────────────────────────────────────

app = typer.Typer(
    name="ghost-wallet",
    help="Ghost-Tip Protocol CLI Wallet — privacy-preserving eCash on EVM.",
    no_args_is_help=True,
    rich_markup_mode="rich",
    pretty_exceptions_enable=False,
)

VerbosityOpt = Annotated[
    Verbosity,
    typer.Option(
        "--verbosity", "-v",
        help="[bold]quiet[/bold] · [bold]normal[/bold] · [bold]verbose[/bold] · [bold]debug[/bold]",
        show_default=True,
    ),
]

DryRunOpt = Annotated[
    bool,
    typer.Option(
        "--dry-run", "-n",
        help="Simulate without broadcasting any transaction to the chain.",
        is_flag=True,
    ),
]

MockOpt = Annotated[
    bool,
    typer.Option(
        "--mock",
        help="Offline mode: skip all chain interactions. Only MASTER_SEED needed in .env.",
        is_flag=True,
    ),
]


def _set_modes(verbosity: Verbosity, dry_run: bool = False, mock: bool = False) -> None:
    """Set global mode flags. Mock implies dry-run."""
    global _verbosity, _dry_run, _mock_mode
    _verbosity = verbosity
    _dry_run = dry_run or mock
    _mock_mode = mock


@app.command()
def deposit(
    index: Annotated[int, typer.Option("--index", "-i", help="Token index (0-based).", min=0)],
    dry_run:   DryRunOpt   = False,
    mock:      MockOpt     = False,
    verbosity: VerbosityOpt = Verbosity.normal,
) -> None:
    """Blind a token secret and submit (or simulate) a deposit to GhostVault."""
    _set_modes(verbosity, dry_run, mock)
    cmd_deposit(load_config(), index)


@app.command()
def scan(
    from_block: Annotated[Optional[int], typer.Option("--from-block", help="Start block.", min=0)] = None,
    index_from: Annotated[int, typer.Option("--index-from", help="First token index.", min=0)] = 0,
    index_to:   Annotated[int, typer.Option("--index-to",   help="Last token index.",  min=0)] = 9,
    verbosity:  VerbosityOpt = Verbosity.normal,
) -> None:
    """Scan chain for MintFulfilled events and recover tokens in [index-from, index-to]."""
    _set_modes(verbosity)
    if index_to < index_from:
        err(f"--index-to ({index_to}) must be >= --index-from ({index_from})")
        raise typer.Exit(code=1)
    cmd_scan(load_config(), from_block, index_from, index_to)


@app.command()
def redeem(
    index:    Annotated[int, typer.Option("--index", "-i", help="Token index to redeem.", min=0)],
    to:       Annotated[str, typer.Option("--to",          help="Recipient Ethereum address.")],
    relayer:  Annotated[Optional[str], typer.Option("--relayer", help="Relayer base URL (relayer pays gas).")] = None,
    dry_run:  DryRunOpt   = False,
    mock:     MockOpt     = False,
    verbosity: VerbosityOpt = Verbosity.normal,
) -> None:
    """Unblind a recovered token and submit redeem() directly or via a relayer."""
    _set_modes(verbosity, dry_run, mock)
    cmd_redeem(load_config(), index, to, relayer)


@app.command()
def status(
    mock:      MockOpt     = False,
    verbosity: VerbosityOpt = Verbosity.normal,
) -> None:
    """Show wallet state: token lifecycle statuses and on-chain balance."""
    _set_modes(verbosity, mock=mock)
    cmd_status(load_config())


@app.command()
def balance(
    mock:      MockOpt     = False,
    verbosity: VerbosityOpt = Verbosity.normal,
) -> None:
    """Query on-chain ETH balance for the configured wallet address."""
    _set_modes(verbosity, mock=mock)
    cmd_balance(load_config())


if __name__ == "__main__":
    app()
