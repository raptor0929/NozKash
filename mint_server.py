"""
Ghost-Tip Protocol: Mint Server

Stateless daemon that listens for GhostVault DepositLocked events, performs
the blind BLS signing operation (S' = sk * B), and broadcasts the blinded
signature back to the contract via the announce() function.

Configuration (via .env or environment variables):
    MINT_BLS_PRIVKEY        Hex scalar private key (from generate_keys.py)
    CONTRACT_ADDRESS        Deployed GhostVault contract address
    RPC_WS_URL              WebSocket RPC endpoint (e.g. wss://sepolia.infura.io/...)
    MINT_WALLET_ADDRESS     Ethereum address that pays for announce() gas
    MINT_WALLET_KEY         Private key for the above address (hex, no 0x prefix)
    POLL_INTERVAL_SECONDS   Event polling interval (default: 2)
    LOG_LEVEL               Logging level (default: INFO)

Usage:
    uv run mint_server.py
    uv run mint_server.py --verbosity verbose
    uv run mint_server.py --verbosity debug
    uv run mint_server.py --verbosity quiet
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import typer
from dotenv import load_dotenv
from rich import box
from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text
from rich.theme import Theme
from rich.traceback import install as install_rich_traceback
from web3 import AsyncWeb3, WebSocketProvider
from web3.exceptions import ContractCustomError, ContractLogicError
from web3.types import EventData

from contract_errors import decode_contract_error
from ghost_library import (
    GhostError,
    InvalidPointError,
    Scalar,
    mint_blind_sign,
    parse_g1,
    serialize_g1,
)

load_dotenv()

# ── Rich setup ────────────────────────────────────────────────────────────────

ghost_theme = Theme(
    {
        "primary":    "bold cyan",
        "secondary":  "dim cyan",
        "success":    "bold green",
        "warning":    "bold yellow",
        "error":      "bold red",
        "muted":      "dim white",
        "label":      "bold white",
        "value":      "cyan",
        "addr":       "yellow",
        "hash":       "magenta",
        "num":        "bright_blue",
        "accent":     "bright_cyan",
        "banner":     "bold bright_cyan",
    }
)

console = Console(theme=ghost_theme, highlight=False)
install_rich_traceback(console=console, show_locals=False)


# ── Verbosity ─────────────────────────────────────────────────────────────────

class Verbosity(str, Enum):
    quiet   = "quiet"    # errors only
    normal  = "normal"   # key events (default)
    verbose = "verbose"  # all intermediate values
    debug   = "debug"    # everything + raw data


VERBOSITY_TO_LOG_LEVEL = {
    Verbosity.quiet:   logging.ERROR,
    Verbosity.normal:  logging.INFO,
    Verbosity.verbose: logging.DEBUG,
    Verbosity.debug:   logging.DEBUG,
}

# Module-level verbosity (set at startup)
_verbosity: Verbosity = Verbosity.normal


def is_verbose() -> bool:
    return _verbosity in (Verbosity.verbose, Verbosity.debug)


def is_debug() -> bool:
    return _verbosity == Verbosity.debug


def is_quiet() -> bool:
    return _verbosity == Verbosity.quiet


# ── Formatted output helpers ──────────────────────────────────────────────────

def _shorten(val: str, head: int = 10, tail: int = 8) -> str:
    """Return a shortened hex string for display."""
    if len(val) <= head + tail + 3:
        return val
    return f"{val[:head]}…{val[-tail:]}"


def _addr(address: str) -> Text:
    t = Text()
    t.append(address[:6], style="addr")
    t.append("…", style="muted")
    t.append(address[-4:], style="addr")
    return t


def _hex(value: str, max_len: int = 20) -> Text:
    t = Text()
    display = value if len(value) <= max_len else value[:max_len] + "…"
    t.append(display, style="hash")
    return t


def _num(value: int | str) -> Text:
    return Text(str(value), style="num")


def print_banner() -> None:
    banner = Panel(
        Text.assemble(
            ("👻  ", ""),
            ("GHOST-TIP MINT SERVER", "banner"),
            ("  👻", ""),
        ),
        subtitle=Text("BLS Blind Signature Daemon · Sepolia", style="secondary"),
        border_style="cyan",
        padding=(0, 4),
    )
    console.print()
    console.print(banner)
    console.print()


def print_config(config: "MintConfig") -> None:
    table = Table(
        box=box.SIMPLE,
        show_header=False,
        padding=(0, 2),
        border_style="secondary",
    )
    table.add_column("Key",   style="label",   no_wrap=True)
    table.add_column("Value", style="value",   no_wrap=False)

    # Wallet
    table.add_row("Wallet", config.wallet_address)
    table.add_row("Contract", config.contract_address)
    table.add_row("RPC", _shorten(config.rpc_ws_url, head=30, tail=8))
    table.add_row("Poll interval", f"{config.poll_interval}s")
    table.add_row("Verbosity", _verbosity.value)

    if is_verbose():
        sk_display = hex(config.sk)
        table.add_row("BLS sk", _shorten(sk_display, head=12, tail=6))

    console.print(
        Panel(table, title="[primary]Configuration[/primary]", border_style="secondary", padding=(0, 1))
    )
    console.print()


def section(title: str) -> None:
    if not is_quiet():
        console.print(Rule(f"[secondary]{title}[/secondary]", style="dim cyan"))


def log_connected(chain_id: int, block: int) -> None:
    if is_quiet():
        return
    console.print(
        Text.assemble(
            ("  ✅  Connected  ", "success"),
            ("chain=", "muted"),
            (str(chain_id), "num"),
            ("  block=", "muted"),
            (str(block), "num"),
        )
    )
    console.print()


def log_listening() -> None:
    if is_quiet():
        return
    console.print(Text("  👂  Listening for DepositLocked events…\n", style="secondary"))


def log_deposit_received(
    deposit_id: str,
    tx_hash: str,
    b_x: int,
    b_y: int,
    block: Optional[int] = None,
) -> None:
    if is_quiet():
        return

    table = Table(
        box=box.SIMPLE_HEAVY,
        show_header=False,
        padding=(0, 2),
        border_style="cyan",
    )
    table.add_column("Field", style="label",  no_wrap=True)
    table.add_column("Value", style="value",  no_wrap=False)

    table.add_row("Event",      "DepositLocked")
    table.add_row("Deposit ID", deposit_id)
    table.add_row("Tx hash",    _shorten(tx_hash, head=14, tail=8))
    if block is not None:
        table.add_row("Block", str(block))

    if is_verbose():
        table.add_row("B.x", _shorten(hex(b_x), head=18, tail=6))
        table.add_row("B.y", _shorten(hex(b_y), head=18, tail=6))

    console.print(
        Panel(
            table,
            title="[primary]📥  Deposit Received[/primary]",
            border_style="cyan",
            padding=(0, 1),
        )
    )


def log_signing(b_x: int, b_y: int, s_prime_x: int, s_prime_y: int) -> None:
    if not is_verbose():
        return

    table = Table(
        box=box.SIMPLE,
        show_header=False,
        padding=(0, 2),
        border_style="secondary",
    )
    table.add_column("Field", style="label", no_wrap=True)
    table.add_column("Value", style="hash",  no_wrap=False)

    table.add_row("B.x  (input)",   _shorten(hex(b_x),       head=18, tail=6))
    table.add_row("B.y  (input)",   _shorten(hex(b_y),       head=18, tail=6))
    table.add_row("S'.x (output)",  _shorten(hex(s_prime_x), head=18, tail=6))
    table.add_row("S'.y (output)",  _shorten(hex(s_prime_y), head=18, tail=6))

    console.print(
        Panel(
            table,
            title="[secondary]🔏  Blind Signature  S' = sk · B[/secondary]",
            border_style="dim cyan",
            padding=(0, 1),
        )
    )


def log_announce_sent(deposit_id: str, tx_hash: str) -> None:
    if is_quiet():
        return
    console.print(
        Text.assemble(
            ("  📤  announce() sent   ", "primary"),
            ("deposit=", "muted"),
            (_shorten(deposit_id, head=8, tail=6), "addr"),
            ("   tx=", "muted"),
            (_shorten(tx_hash, head=10, tail=8), "hash"),
        )
    )


def log_announce_confirmed(deposit_id: str, block: int, gas: int) -> None:
    if is_quiet():
        return
    console.print(
        Text.assemble(
            ("  ✅  Confirmed          ", "success"),
            ("block=", "muted"),
            (str(block), "num"),
            ("   gas=", "muted"),
            (str(gas), "num"),
        )
    )
    console.print()


def log_announce_reverted(deposit_id: str, tx_hash: str) -> None:
    console.print(
        Text.assemble(
            ("  ❌  REVERTED           ", "error"),
            ("deposit=", "muted"),
            (_shorten(deposit_id, head=8, tail=6), "addr"),
            ("   tx=", "muted"),
            (_shorten(tx_hash, head=10, tail=8), "hash"),
        )
    )


def log_invalid_point(deposit_id: str, exc: InvalidPointError) -> None:
    console.print(
        Panel(
            Text.assemble(
                ("Deposit ID: ", "label"),
                (deposit_id, "addr"),
                ("\nReason:     ", "label"),
                (str(exc), "error"),
            ),
            title="[error]⚠️  Invalid G1 Point — Deposit Rejected[/error]",
            border_style="red",
            padding=(0, 2),
        )
    )


def log_signing_error(deposit_id: str, exc: Exception) -> None:
    console.print(
        Panel(
            Text.assemble(
                ("Deposit ID: ", "label"),
                (deposit_id, "addr"),
                ("\nError:      ", "label"),
                (str(exc), "error"),
            ),
            title="[error]❌  Signing Error[/error]",
            border_style="red",
            padding=(0, 2),
        )
    )


def log_announce_error(deposit_id: str, exc: Exception) -> None:
    console.print(
        Panel(
            Text.assemble(
                ("Deposit ID: ", "label"),
                (deposit_id, "addr"),
                ("\nError:      ", "label"),
                (str(exc), "error"),
            ),
            title="[error]❌  announce() Failed[/error]",
            border_style="red",
            padding=(0, 2),
        )
    )


def log_reconnecting(exc: Exception, delay: int = 5) -> None:
    console.print(
        Text.assemble(
            ("\n  ⚡  Connection lost — reconnecting in ", "warning"),
            (str(delay), "num"),
            ("s", "warning"),
            (f"\n     {exc}\n", "muted"),
        )
    )


def log_debug_raw(label: str, data: object) -> None:
    if not is_debug():
        return
    import json
    try:
        pretty = json.dumps(dict(data), indent=2, default=str)
    except Exception:
        pretty = str(data)
    console.print(
        Panel(
            pretty,
            title=f"[muted]DEBUG · {label}[/muted]",
            border_style="dim",
            padding=(0, 2),
        )
    )


# ── Configuration ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MintConfig:
    sk:                  Scalar
    contract_address:    str
    rpc_ws_url:          str
    wallet_address:      str
    wallet_key:          str
    poll_interval:       float
    log_level:           str


def load_config(verbosity: Verbosity) -> MintConfig:
    missing = []

    def require(key: str) -> str:
        val = os.getenv(key, "").strip()
        if not val:
            missing.append(key)
        return val

    sk_hex         = require("MINT_BLS_PRIVKEY")
    contract_addr  = require("CONTRACT_ADDRESS")
    rpc_ws_url     = require("RPC_WS_URL")
    wallet_address = require("MINT_WALLET_ADDRESS")
    wallet_key     = require("MINT_WALLET_KEY")

    if missing:
        console.print(
            Panel(
                Text.assemble(
                    ("Missing environment variables:\n\n", "error"),
                    *[
                        Text.assemble(("  • ", "muted"), (k, "label"), ("\n", ""))
                        for k in missing
                    ],
                    ("\nRun generate_keys.py to create a .env file.", "secondary"),
                ),
                title="[error]❌  Configuration Error[/error]",
                border_style="red",
            )
        )
        raise typer.Exit(code=1)

    try:
        sk = Scalar(int(sk_hex, 16))
    except ValueError:
        console.print(f"[error]MINT_BLS_PRIVKEY is not valid hex: {sk_hex[:20]}…[/error]")
        raise typer.Exit(code=1)

    return MintConfig(
        sk=sk,
        contract_address=contract_addr,
        rpc_ws_url=rpc_ws_url,
        wallet_address=wallet_address,
        wallet_key=wallet_key if wallet_key.startswith("0x") else "0x" + wallet_key,
        poll_interval=float(os.getenv("POLL_INTERVAL_SECONDS", "2")),
        log_level=logging.getLevelName(VERBOSITY_TO_LOG_LEVEL[verbosity]),
    )


# ── Contract ABI ──────────────────────────────────────────────────────────────

_ABI_PATH = Path(__file__).resolve().parent / "ghost_vault_abi.json"
GHOST_VAULT_ABI = json.loads(_ABI_PATH.read_text())


# ── Signing logic ─────────────────────────────────────────────────────────────

def sign_deposit(blinded_point_raw: list[int], sk: Scalar) -> tuple[int, int]:
    """
    Core mint operation: validates the submitted G1 point and blind-signs it.
    Returns (S'_x, S'_y) as uint256 integers for Solidity.
    Raises InvalidPointError if B is not on BN254 G1.
    """
    B = parse_g1(int(blinded_point_raw[0]), int(blinded_point_raw[1]))
    S_prime = mint_blind_sign(B, sk)
    return serialize_g1(S_prime)


# ── Mint daemon ───────────────────────────────────────────────────────────────

class MintDaemon:
    def __init__(self, config: MintConfig) -> None:
        self.config = config

    async def run(self) -> None:
        section("Starting Daemon")
        print_config(self.config)
        log_listening()

        while True:
            try:
                await self._connect_and_listen()
            except Exception as exc:
                log_reconnecting(exc)
                await asyncio.sleep(5)

    async def _connect_and_listen(self) -> None:
        section("WebSocket Connection")

        async with AsyncWeb3(WebSocketProvider(self.config.rpc_ws_url)) as w3:
            if not await w3.is_connected():
                raise ConnectionError("WebSocket handshake failed")

            chain_id     = await w3.eth.chain_id
            latest_block = await w3.eth.block_number
            log_connected(chain_id, latest_block)

            contract = w3.eth.contract(
                address=AsyncWeb3.to_checksum_address(self.config.contract_address),
                abi=GHOST_VAULT_ABI,
            )

            event_filter = await contract.events.DepositLocked.create_filter(
                from_block="latest"
            )
            log_listening()

            while True:
                entries: list[EventData] = await event_filter.get_new_entries()
                for event in entries:
                    await self._handle_deposit(w3, contract, event)
                await asyncio.sleep(self.config.poll_interval)

    async def _handle_deposit(
        self,
        w3: AsyncWeb3,
        contract,
        event: EventData,
    ) -> None:
        deposit_id = event["args"]["depositId"]
        b_coords   = event["args"]["B"]
        tx_hash    = event["transactionHash"].hex()
        block_num  = event.get("blockNumber")

        b_x = int(b_coords[0])
        b_y = int(b_coords[1])

        log_debug_raw("DepositLocked event", event["args"])
        log_deposit_received(deposit_id, tx_hash, b_x, b_y, block=block_num)

        # ── Step 1: Blind-sign B ──────────────────────────────────────────────
        t0 = time.monotonic()
        try:
            s_prime_x, s_prime_y = sign_deposit(b_coords, self.config.sk)
        except InvalidPointError as exc:
            log_invalid_point(deposit_id, exc)
            return
        except GhostError as exc:
            log_signing_error(deposit_id, exc)
            return

        elapsed_sign = (time.monotonic() - t0) * 1000
        log_signing(b_x, b_y, s_prime_x, s_prime_y)

        if is_verbose():
            console.print(
                Text.assemble(
                    ("     ⏱  Signing took ", "muted"),
                    (f"{elapsed_sign:.1f}ms", "num"),
                    ("\n", ""),
                )
            )

        # ── Step 2: Submit announce() ─────────────────────────────────────────
        try:
            await self._submit_announcement(w3, contract, deposit_id, [s_prime_x, s_prime_y])
        except Exception as exc:
            log_announce_error(deposit_id, exc)

    async def _submit_announcement(
        self,
        w3: AsyncWeb3,
        contract,
        deposit_id: str,
        s_prime_coords: list[int],
    ) -> None:
        wallet    = AsyncWeb3.to_checksum_address(self.config.wallet_address)
        nonce     = await w3.eth.get_transaction_count(wallet)
        gas_price = await w3.eth.gas_price

        if is_verbose():
            console.print(
                Text.assemble(
                    ("     nonce=", "muted"),
                    (str(nonce), "num"),
                    ("   gas_price=", "muted"),
                    (f"{w3.from_wei(gas_price, 'gwei'):.2f} gwei", "num"),
                    ("\n", ""),
                )
            )

        try:
            tx = await contract.functions.announce(
                deposit_id,
                s_prime_coords,
            ).build_transaction({
                "from":     wallet,
                "nonce":    nonce,
                "gasPrice": gas_price,
            })
        except (ContractCustomError, ContractLogicError) as exc:
            raise Exception(f"announce() reverted: {decode_contract_error(exc)}") from exc

        signed  = w3.eth.account.sign_transaction(tx, private_key=self.config.wallet_key)
        tx_hash = await w3.eth.send_raw_transaction(signed.raw_transaction)

        log_announce_sent(deposit_id, tx_hash.hex())

        receipt = await w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

        if receipt["status"] == 1:
            log_announce_confirmed(deposit_id, receipt["blockNumber"], receipt["gasUsed"])
            log_debug_raw("announce() receipt", receipt)
        else:
            log_announce_reverted(deposit_id, tx_hash.hex())


# ── Typer app ─────────────────────────────────────────────────────────────────

app = typer.Typer(
    name="mint-server",
    help="Ghost-Tip Protocol Mint Server — listens for deposits and issues blind signatures.",
    add_completion=False,
    rich_markup_mode="rich",
    pretty_exceptions_enable=False,
)


@app.command()
def run(
    verbosity: Verbosity = typer.Option(
        Verbosity.normal,
        "--verbosity", "-v",
        help=(
            "[bold]quiet[/bold] errors only · "
            "[bold]normal[/bold] key events · "
            "[bold]verbose[/bold] intermediates · "
            "[bold]debug[/bold] raw data"
        ),
        show_default=True,
        rich_help_panel="Logging",
    ),
    log_level: Optional[str] = typer.Option(
        None,
        "--log-level",
        help="Override Python logging level (DEBUG, INFO, WARNING, ERROR). Rarely needed.",
        show_default=False,
        hidden=True,
        rich_help_panel="Logging",
    ),
) -> None:
    """
    Start the Ghost-Tip mint daemon.

    Connects over WebSocket and processes [primary]DepositLocked[/primary] events,
    performing [accent]S' = sk · B[/accent] and calling [primary]announce()[/primary]
    for each valid deposit.
    """
    global _verbosity
    _verbosity = verbosity

    # Python logging — suppressed by Rich for normal use; enabled at debug level
    effective_log_level = (
        getattr(logging, log_level.upper(), logging.WARNING)
        if log_level
        else VERBOSITY_TO_LOG_LEVEL[verbosity]
    )
    logging.basicConfig(
        level=effective_log_level,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%H:%M:%S",
        # Silence noisy libraries unless debug
        handlers=[logging.NullHandler()] if verbosity != Verbosity.debug else None,
    )
    # Keep web3/websockets quiet unless debug
    if verbosity != Verbosity.debug:
        for noisy in ("web3", "websockets", "asyncio"):
            logging.getLogger(noisy).setLevel(logging.ERROR)

    print_banner()
    config = load_config(verbosity)
    daemon = MintDaemon(config)

    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        console.print("\n[warning]  ⚡  Interrupted — shutting down.[/warning]\n")


if __name__ == "__main__":
    app()
