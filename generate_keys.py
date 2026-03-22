"""
Ghost-Tip Protocol: Key & Configuration Generator

Generates all secrets and configuration needed to run the Ghost-Tip client,
mint, and flow scripts. Writes a complete .env file with:

    ── Secrets (generated fresh) ──
    • MASTER_SEED            HD-wallet-style master seed for token derivation
    • MINT_BLS_PRIVKEY       BLS scalar (0x hex) for the blind signing mint

    ── Deposit Wallet (--with-wallet) ──
    • WALLET_ADDRESS          Ethereum address for deposits (funded with Sepolia ETH)
    • WALLET_KEY              Private key for WALLET_ADDRESS

    ── Mint Wallet (--with-mint-wallet) ──
    • MINT_WALLET_ADDRESS     Ethereum address that pays gas for announce() calls
    • MINT_WALLET_KEY         Private key for MINT_WALLET_ADDRESS

    ── Network (passed via flags or edited later) ──
    • RPC_HTTP_URL            Sepolia JSON-RPC endpoint (client)
    • RPC_WS_URL              Sepolia WebSocket endpoint (mint server)
    • CONTRACT_ADDRESS        GhostVault contract address
    • SCAN_FROM_BLOCK         Block to start scanning for events

Safety:
    • Will NOT overwrite an existing .env file unless --force is passed.
    • Prints the generated values so you can back them up.
    • All secrets use cryptographically secure randomness.

Usage:
    uv run generate_keys.py              # generate .env (fails if exists)
    uv run generate_keys.py --force      # overwrite existing .env
    uv run generate_keys.py --print      # print what would be written, don't write
    uv run generate_keys.py --with-wallet --with-mint-wallet  # generate both keypairs
"""

import os
import secrets
import sys
from enum import Enum
from pathlib import Path
from typing import Annotated, Optional

import typer
from py_ecc.bn128 import curve_order, G2, multiply as bn128_multiply
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.text import Text
from rich.theme import Theme

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
    "banner":    "bold bright_cyan",
    "key":       "bold bright_yellow",
    "secret":    "bold red",
})

console = Console(theme=ghost_theme, highlight=False)

ENV_FILE = Path(".env")


# ==============================================================================
# KEY GENERATION
# ==============================================================================

def generate_master_seed() -> str:
    """Generate a 32-byte hex master seed for HD-style token derivation."""
    return secrets.token_hex(32)


def generate_bls_scalar() -> int:
    """Generate a random BLS scalar in (0, curve_order) for the mint."""
    while True:
        sk = secrets.randbelow(curve_order - 1) + 1
        if 0 < sk < curve_order:
            return sk


def generate_eth_keypair() -> tuple[str, str]:
    """
    Generate a fresh Ethereum keypair for the deposit wallet.

    Returns (address, private_key_hex) using eth_keys for proper
    checksummed address derivation.
    """
    from eth_keys import keys

    privkey_bytes = secrets.token_bytes(32)
    privkey = keys.PrivateKey(privkey_bytes)
    address = privkey.public_key.to_checksum_address()
    return address, "0x" + privkey_bytes.hex()


def derive_bls_pubkey_summary(sk: int) -> str:
    """Compute PK = sk·G2 and return a short summary string."""
    pk = bn128_multiply(G2, sk)
    x_real = hex(pk[0].coeffs[0].n)[:18] + "…"
    return f"G2({x_real})"


def derive_bls_pubkey_hex(sk: int) -> str:
    """
    Compute PK = sk·G2 and return 4 comma-separated hex uint256 values
    in the EIP-197 limb order expected by the GhostVault constructor:
        X_imag, X_real, Y_imag, Y_real
    """
    pk = bn128_multiply(G2, sk)
    # py_ecc FQ2 coeffs order: [real, imag]
    x_real = hex(pk[0].coeffs[0].n)
    x_imag = hex(pk[0].coeffs[1].n)
    y_real = hex(pk[1].coeffs[0].n)
    y_imag = hex(pk[1].coeffs[1].n)
    return f"{x_imag},{x_real},{y_imag},{y_real}"


# ==============================================================================
# ENV FILE CONSTRUCTION
# ==============================================================================

def build_env_content(
    master_seed: str,
    bls_sk: int,
    wallet_address: str = "",
    wallet_key: str = "",
    mint_wallet_address: str = "",
    mint_wallet_key: str = "",
    rpc_url: str = "",
    rpc_ws_url: str = "",
    contract_address: str = "",
    scan_from_block: str = "0",
) -> str:
    """Build the .env file content with clear section headers."""

    # Chain settings: only include if provided (non-empty)
    chain_section = ""
    if wallet_address and wallet_key:
        chain_section += f"""
# ── Deposit Wallet ────────────────────────────────────────────────────────────
# Ethereum keypair for submitting deposit transactions.
# Fund this address with Sepolia ETH before running deposits.
WALLET_ADDRESS={wallet_address}
WALLET_KEY={wallet_key}
"""

    if mint_wallet_address and mint_wallet_key:
        chain_section += f"""
# ── Mint Wallet ───────────────────────────────────────────────────────────────
# Ethereum keypair for the mint server (pays gas for announce() calls).
# Fund this address with Sepolia ETH before starting the mint daemon.
MINT_WALLET_ADDRESS={mint_wallet_address}
MINT_WALLET_KEY={mint_wallet_key}
"""

    if rpc_url:
        chain_section += f"""
# ── Network (HTTP) ────────────────────────────────────────────────────────────
# Sepolia JSON-RPC endpoint for the CLI wallet.
# Free tier: https://app.infura.io → create project → copy Sepolia endpoint.
RPC_HTTP_URL={rpc_url}
"""

    if rpc_ws_url:
        chain_section += f"""
# ── Network (WebSocket) ──────────────────────────────────────────────────────
# Sepolia WebSocket endpoint for the mint server event listener.
RPC_WS_URL={rpc_ws_url}
"""

    if contract_address:
        chain_section += f"""
# ── Contract ──────────────────────────────────────────────────────────────────
# GhostVault contract address on Sepolia.
# Update this after deploying the contract.
CONTRACT_ADDRESS={contract_address}
"""

    if not chain_section:
        chain_section = """
# ── Chain Settings (not configured) ──────────────────────────────────────────
# The settings below are only needed for on-chain operation.
# For offline testing, run:  ./ghost_flow.sh --to 0xAnyAddress --mock
#
# Uncomment and fill in when ready to go on-chain:
# WALLET_ADDRESS=0xYourAddress
# WALLET_KEY=0xYourPrivateKey
# MINT_WALLET_ADDRESS=0xMintAddress
# MINT_WALLET_KEY=0xMintPrivateKey
# RPC_HTTP_URL=https://sepolia.infura.io/v3/YOUR_PROJECT_ID
# RPC_WS_URL=wss://sepolia.infura.io/ws/v3/YOUR_PROJECT_ID
# CONTRACT_ADDRESS=0xDeployedContractAddress
"""

    return f"""\
# ==============================================================================
# Ghost-Tip Protocol — Configuration
# Generated by generate_keys.py
#
# ⚠️  This file contains SECRET KEYS. Do not commit to version control.
#
# Mock mode (offline):  only MASTER_SEED + MINT_BLS_PRIVKEY are needed.
# Chain mode (Sepolia): all settings below must be filled in.
# ==============================================================================

# ── Token Derivation ──────────────────────────────────────────────────────────
# 32-byte hex seed used to deterministically derive all token keypairs.
# Losing this seed means losing access to all un-redeemed tokens.
MASTER_SEED={master_seed}

# ── Mint BLS Key ──────────────────────────────────────────────────────────────
# BLS scalar (integer) for the blind signing mint server.
# The mint uses this to compute S' = sk · B on blinded deposit points.
MINT_BLS_PRIVKEY={hex(bls_sk)}

# BLS public key on G2 (4 uint256 values, EIP-197 limb order).
# Used by the client to verify unblinded signatures locally before redeeming.
# Derived deterministically from MINT_BLS_PRIVKEY — do not edit manually.
MINT_BLS_PUBKEY={derive_bls_pubkey_hex(bls_sk)}
{chain_section}
# ── Scanning ──────────────────────────────────────────────────────────────────
# Block number to start scanning for MintFulfilled events.
# Set to the contract deployment block to avoid scanning millions of blocks.
SCAN_FROM_BLOCK={scan_from_block}
"""


# ==============================================================================
# CLI
# ==============================================================================

app = typer.Typer(
    name="generate-keys",
    help="Generate Ghost-Tip Protocol keys and configuration.",
    no_args_is_help=False,
    rich_markup_mode="rich",
    pretty_exceptions_enable=False,
)


@app.callback(invoke_without_command=True)
def main(
    force: Annotated[bool, typer.Option(
        "--force", "-f",
        help="Overwrite existing .env file.",
    )] = False,
    print_only: Annotated[bool, typer.Option(
        "--print", "-p",
        help="Print generated config to stdout without writing .env.",
    )] = False,
    with_wallet: Annotated[bool, typer.Option(
        "--with-wallet", "-w",
        help="Also generate an Ethereum deposit wallet keypair.",
    )] = False,
    with_mint_wallet: Annotated[bool, typer.Option(
        "--with-mint-wallet",
        help="Also generate an Ethereum keypair for the mint server (announce() gas).",
    )] = False,
    rpc_url: Annotated[Optional[str], typer.Option(
        "--rpc-url",
        help="HTTP RPC URL for the CLI wallet (e.g. your Infura Sepolia endpoint).",
    )] = None,
    rpc_ws_url: Annotated[Optional[str], typer.Option(
        "--rpc-ws-url",
        help="WebSocket RPC URL for the mint server (e.g. wss://sepolia.infura.io/ws/v3/...).",
    )] = None,
    contract: Annotated[Optional[str], typer.Option(
        "--contract",
        help="GhostVault contract address to include.",
    )] = None,
    scan_from: Annotated[Optional[str], typer.Option(
        "--scan-from",
        help="Block number to start scanning from.",
    )] = None,
) -> None:
    """
    Generate keys and write a .env file.

    By default, generates only what's needed for mock mode (offline testing):
    MASTER_SEED and MINT_BLS_PRIVKEY.

    Use --with-wallet to also generate a deposit wallet keypair,
    --with-mint-wallet to generate a mint server keypair, and
    --rpc-url / --rpc-ws-url / --contract to include chain settings.
    """
    console.print(Panel(
        Text.assemble(("🔑  ", ""), ("GHOST-TIP KEY GENERATOR", "banner"), ("  🔑", "")),
        subtitle=Text("All secrets use CSPRNG · Never commit .env to git", style="secondary"),
        border_style="cyan",
        padding=(0, 4),
    ))
    console.print()

    # ── Safety check ──────────────────────────────────────────────────────
    if ENV_FILE.exists() and not force and not print_only:
        console.print(Panel(
            Text.assemble(
                ("Existing .env found at ", "warning"),
                (str(ENV_FILE.resolve()), "value"),
                ("\n\nTo overwrite, run with ", "warning"),
                ("--force", "key"),
                ("\nTo preview without writing, run with ", "warning"),
                ("--print", "key"),
            ),
            title="⚠️  File exists",
            border_style="yellow",
            padding=(1, 2),
        ))
        raise typer.Exit(code=1)

    # ── Generate secrets ──────────────────────────────────────────────────
    console.print(Rule("[step]Generating Protocol Secrets[/step]", style="dim cyan"))

    master_seed = generate_master_seed()
    console.print(Text.assemble(
        ("  MASTER_SEED        ", "label"), (master_seed[:16] + "…" + master_seed[-8:], "hash"),
        ("  (64 hex chars)", "muted"),
    ))

    bls_sk = generate_bls_scalar()
    bls_sk_hex = hex(bls_sk)
    console.print(Text.assemble(
        ("  MINT_BLS_PRIVKEY   ", "label"), (bls_sk_hex[:20] + "…" + bls_sk_hex[-8:], "hash"),
    ))

    pk_summary = derive_bls_pubkey_summary(bls_sk)
    console.print(Text.assemble(
        ("  PK_mint            ", "label"), (pk_summary, "value"),
    ))
    console.print()

    # ── Optional: deposit wallet ──────────────────────────────────────────
    wallet_address = ""
    wallet_key = ""

    if with_wallet:
        console.print(Rule("[step]Generating Deposit Wallet[/step]", style="dim cyan"))
        wallet_address, wallet_key = generate_eth_keypair()
        console.print(Text.assemble(
            ("  WALLET_ADDRESS     ", "label"), (wallet_address, "addr"),
        ))
        console.print(Text.assemble(
            ("  WALLET_KEY         ", "label"), (wallet_key[:10] + "…" + wallet_key[-6:], "secret"),
            ("  (keep secret!)", "muted"),
        ))
        console.print()

    # ── Optional: mint wallet ─────────────────────────────────────────────
    mint_wallet_address = ""
    mint_wallet_key = ""

    if with_mint_wallet:
        console.print(Rule("[step]Generating Mint Wallet[/step]", style="dim cyan"))
        mint_wallet_address, mint_wallet_key = generate_eth_keypair()
        console.print(Text.assemble(
            ("  MINT_WALLET_ADDRESS ", "label"), (mint_wallet_address, "addr"),
        ))
        console.print(Text.assemble(
            ("  MINT_WALLET_KEY     ", "label"), (mint_wallet_key[:10] + "…" + mint_wallet_key[-6:], "secret"),
            ("  (keep secret!)", "muted"),
        ))
        console.print()

    # ── Build .env content ────────────────────────────────────────────────
    env_content = build_env_content(
        master_seed=master_seed,
        bls_sk=bls_sk,
        wallet_address=wallet_address,
        wallet_key=wallet_key,
        mint_wallet_address=mint_wallet_address,
        mint_wallet_key=mint_wallet_key,
        rpc_url=rpc_url or "",
        rpc_ws_url=rpc_ws_url or "",
        contract_address=contract or "",
        scan_from_block=scan_from or "0",
    )

    # ── Write or print ────────────────────────────────────────────────────
    if print_only:
        console.print(Rule("[step]Generated .env (not written)[/step]", style="dim cyan"))
        console.print()
        console.print(env_content)
        console.print()
        console.print(Text(
            "  ℹ️   Run without --print to write to disk.",
            style="muted",
        ))
    else:
        ENV_FILE.write_text(env_content)
        console.print(Rule("[step]Configuration Written[/step]", style="dim cyan"))
        console.print(Text.assemble(
            ("  📄  Written to ", "success"), (str(ENV_FILE.resolve()), "value"),
        ))

    console.print()

    # ── Next steps ────────────────────────────────────────────────────────
    console.print(Rule("[step]Next Steps[/step]", style="dim cyan"))
    console.print()
    console.print(Text.assemble(
        ("  1. ", "num"), ("Mock flow ", "label"), ("(works right now — no ETH needed):", "muted"),
    ))
    console.print(Text(
        "     ./ghost_flow.sh --to 0xAnyAddress --mock",
        style="value",
    ))
    console.print()
    console.print(Text.assemble(
        ("  2. ", "num"), ("Real flow ", "label"), ("(needs Sepolia ETH + contract):", "muted"),
    ))
    if not with_wallet:
        console.print(Text(
            "     • Re-run with --with-wallet to generate a deposit keypair",
            style="muted",
        ))
    else:
        console.print(Text.assemble(
            ("     • Fund ", "muted"), (wallet_address, "addr"),
            (" with Sepolia ETH", "muted"),
        ))
    if not with_mint_wallet:
        console.print(Text(
            "     • Re-run with --with-mint-wallet to generate a mint server keypair",
            style="muted",
        ))
    else:
        console.print(Text.assemble(
            ("     • Fund ", "muted"), (mint_wallet_address, "addr"),
            (" with Sepolia ETH (mint gas)", "muted"),
        ))
    if not rpc_url:
        console.print(Text(
            "     • Edit .env → set RPC_HTTP_URL to your Infura/Alchemy endpoint",
            style="muted",
        ))
    if not rpc_ws_url:
        console.print(Text(
            "     • Edit .env → set RPC_WS_URL to your WebSocket endpoint (for mint server)",
            style="muted",
        ))
    console.print(Text(
        "     • Edit .env → set CONTRACT_ADDRESS after deploying GhostVault",
        style="muted",
    ))
    console.print(Text(
        "     • ./ghost_flow.sh --to 0xRecipient",
        style="value",
    ))
    console.print()

    # ── Security reminder ─────────────────────────────────────────────────
    console.print(Panel(
        Text.assemble(
            ("Back up .env securely. It contains private keys.\n", "warning"),
            ("Add ", "muted"), (".env", "value"), (" to ", "muted"), (".gitignore", "value"),
            (" — never commit secrets to version control.", "muted"),
        ),
        title="🔒  Security",
        border_style="yellow",
        padding=(0, 2),
    ))
    console.print()


if __name__ == "__main__":
    app()
