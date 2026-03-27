"""
Ghost-Tip Protocol: Mock Redeemer (On-Chain Verification Simulator)

Simulates the GhostVault.redeem() smart contract function entirely off-chain.
Performs the exact same verification steps the Solidity contract would:

    1. ecrecover(msg_hash, spendSignature) → nullifier address
    2. Check nullifier has not been spent (mock: in-memory set)
    3. Y = hashToCurve(nullifier)
    4. ecPairing(S, G2, Y, PK_mint) → BLS verification
    5. Transfer 0.001 ETH to recipient (mock: just records success)

Library usage:
    from redeem_mock import MockRedeemer

    redeemer = MockRedeemer(pk_mint=pk_g2_point)
    result = redeemer.redeem(
        recipient="0xRecipient...",
        spend_signature_bytes=sig_65_bytes,
        unblinded_s_x=s_x_int,
        unblinded_s_y=s_y_int,
    )

CLI usage (replaces on-chain redeem with full verification):
    uv run redeem_mock.py verify --index 0 --to 0xRecipient
    uv run redeem_mock.py verify --index 0 --to 0xRecipient --verbosity verbose

All operations are pure — no network, no gas. The CLI reads wallet state and
MASTER_SEED from .env to reconstruct the redemption payload, then verifies it.
"""

import json
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Annotated, Optional

import typer
from dotenv import load_dotenv
from py_ecc.bn128 import G2 as G2_gen, curve_order
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.text import Text
from rich.theme import Theme

from ghost_library import (
    G1Point, G2Point, Scalar,
    derive_token_secrets, hash_to_curve, parse_g1, serialize_g1,
    generate_redemption_proof,
    verify_bls_pairing, verify_ecdsa_mev_protection,
    _mul_g2,
    GhostError, InvalidPointError,
)

load_dotenv()


# ==============================================================================
# MOCK REDEEMER LIBRARY
# ==============================================================================

class MockRedeemError(GhostError):
    """Raised for mock redeemer configuration errors."""


@dataclass
class RedeemResult:
    """Result of a mock redemption attempt."""

    success:    bool
    nullifier:  Optional[str] = None
    recipient:  Optional[str] = None
    reason:     Optional[str] = None

    # Intermediate values for debugging
    ecrecover_address: Optional[str] = None
    bls_pairing_ok:    Optional[bool] = None
    ecdsa_ok:          Optional[bool] = None
    nullifier_spent:   Optional[bool] = None

    def __str__(self) -> str:
        if self.success:
            return (
                f"✅ REDEEM SUCCESS\n"
                f"  Nullifier:  {self.nullifier}\n"
                f"  Recipient:  {self.recipient}\n"
                f"  ECDSA:      {'✅' if self.ecdsa_ok else '❌'}\n"
                f"  BLS:        {'✅' if self.bls_pairing_ok else '❌'}"
            )
        return (
            f"❌ REDEEM FAILED\n"
            f"  Reason:     {self.reason}\n"
            f"  Nullifier:  {self.nullifier or 'unknown'}\n"
            f"  ECDSA:      {self.ecdsa_ok}\n"
            f"  BLS:        {self.bls_pairing_ok}"
        )


@dataclass
class MockRedeemer:
    """
    Off-chain simulation of GhostVault.redeem().

    Maintains an in-memory set of spent nullifiers, exactly like the
    contract's mapping(address => bool) public spentNullifiers.
    """

    pk_mint: G2Point
    spent_nullifiers: set[str] = field(default_factory=set)

    # ── Constructors ──────────────────────────────────────────────────────

    @classmethod
    def from_sk(cls, sk_int: int) -> "MockRedeemer":
        """Derive PK_mint from the scalar and create a redeemer."""
        pk = _mul_g2(G2Point(G2_gen), Scalar(sk_int))
        return cls(pk_mint=pk)

    @classmethod
    def from_env(cls) -> "MockRedeemer":
        """Load the mint scalar from .env and derive PK_mint."""
        sk_hex = os.getenv("MINT_BLS_PRIVKEY")
        sk_int_str = os.getenv("MINT_BLS_PRIVKEY_INT")

        if sk_hex:
            sk = int(sk_hex, 16) if sk_hex.startswith("0x") else int(sk_hex)
        elif sk_int_str:
            sk = int(sk_int_str, 16) if sk_int_str.startswith("0x") else int(sk_int_str)
        else:
            raise MockRedeemError(
                "Missing MINT_BLS_PRIVKEY or MINT_BLS_PRIVKEY_INT in environment."
            )
        return cls.from_sk(sk)

    # ── Core redemption ───────────────────────────────────────────────────

    def redeem(
        self,
        recipient: str,
        spend_signature_bytes: bytes,
        unblinded_s_x: int,
        unblinded_s_y: int,
    ) -> RedeemResult:
        """
        Simulate GhostVault.redeem() — the full on-chain verification pipeline.

        Args:
            recipient:              Destination address for the 0.001 ETH.
            spend_signature_bytes:  65-byte ECDSA signature (r‖s‖v), v is 27 or 28.
            unblinded_s_x:          x coordinate of the unblinded BLS signature S.
            unblinded_s_y:          y coordinate of the unblinded BLS signature S.

        Returns:
            RedeemResult with success/failure details and all intermediates.
        """
        result = RedeemResult(success=False, recipient=recipient)

        # ── Step 1: Parse the ECDSA signature and ecrecover the nullifier ─
        if len(spend_signature_bytes) != 65:
            result.reason = f"Spend signature must be 65 bytes, got {len(spend_signature_bytes)}"
            return result

        from eth_utils import keccak
        from eth_keys import keys

        # Match Solidity: keccak256(abi.encodePacked("Pay to RAW: ", recipient))
        addr_bytes = bytes.fromhex(recipient.replace("0x", ""))
        msg_hash = keccak(b"Pay to RAW: " + addr_bytes)

        r_bytes = spend_signature_bytes[:32]
        s_bytes = spend_signature_bytes[32:64]
        v_byte  = spend_signature_bytes[64]

        if v_byte not in (27, 28):
            result.reason = f"Invalid v byte: {v_byte} (expected 27 or 28)"
            return result

        recovery_bit = v_byte - 27
        compact_hex = r_bytes.hex() + s_bytes.hex()

        try:
            r_int = int.from_bytes(r_bytes, "big")
            s_int = int.from_bytes(s_bytes, "big")
            sig = keys.Signature(vrs=(recovery_bit, r_int, s_int))
            recovered_pubkey = sig.recover_public_key_from_msg_hash(msg_hash)
            nullifier = recovered_pubkey.to_address()
        except Exception as exc:
            result.reason = f"ecrecover failed: {exc}"
            return result

        result.nullifier = nullifier
        result.ecrecover_address = nullifier

        # ── Step 2: ECDSA verification ────────────────────────────────────
        result.ecdsa_ok = verify_ecdsa_mev_protection(
            msg_hash, compact_hex, recovery_bit, nullifier,
        )
        if not result.ecdsa_ok:
            result.reason = "ECDSA verification failed (ecrecover address mismatch)"
            return result

        # ── Step 3: Double-spend check ────────────────────────────────────
        nullifier_lower = nullifier.lower()
        if nullifier_lower in self.spent_nullifiers:
            result.nullifier_spent = True
            result.reason = f"Token already spent (nullifier {nullifier} is in spent set)"
            return result
        result.nullifier_spent = False

        # ── Step 4: Parse the unblinded BLS signature S ───────────────────
        try:
            S = parse_g1(unblinded_s_x, unblinded_s_y)
        except InvalidPointError as exc:
            result.reason = f"Unblinded signature S is not on BN254 G1: {exc}"
            return result

        # ── Step 5: hashToCurve(nullifier) ────────────────────────────────
        nullifier_bytes = bytes.fromhex(nullifier[2:])
        Y = hash_to_curve(nullifier_bytes)

        # ── Step 6: BLS pairing check ────────────────────────────────────
        result.bls_pairing_ok = verify_bls_pairing(S, Y, self.pk_mint)
        if not result.bls_pairing_ok:
            result.reason = "BLS pairing check failed: e(S, G2) != e(Y, PK_mint)"
            return result

        # ── Step 7: Mark as spent ─────────────────────────────────────────
        self.spent_nullifiers.add(nullifier_lower)
        result.success = True
        return result

    def redeem_from_proof(
        self,
        recipient: str,
        compact_hex: str,
        recovery_bit: int,
        unblinded_s_x: int,
        unblinded_s_y: int,
    ) -> RedeemResult:
        """
        Convenience: accepts proof components from generate_redemption_proof()
        and encodes the 65-byte signature internally.
        """
        r_bytes = bytes.fromhex(compact_hex[:64])
        s_bytes = bytes.fromhex(compact_hex[64:])
        v_byte  = bytes([recovery_bit + 27])
        sig_65  = r_bytes + s_bytes + v_byte
        return self.redeem(recipient, sig_65, unblinded_s_x, unblinded_s_y)

    def is_spent(self, nullifier: str) -> bool:
        return nullifier.lower() in self.spent_nullifiers

    def reset(self) -> None:
        self.spent_nullifiers.clear()


# ==============================================================================
# CLI — reads wallet state, builds redeem payload, verifies everything
# ==============================================================================

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
    "step":      "bold cyan",
    "mock":      "bold magenta",
})

console = Console(theme=ghost_theme, highlight=False)

WALLET_STATE_FILE = Path(".ghost_wallet.json")


class Verbosity(str, Enum):
    quiet   = "quiet"
    normal  = "normal"
    verbose = "verbose"


def _short(val: str, head: int = 10, tail: int = 8) -> str:
    if len(val) <= head + tail + 3:
        return val
    return f"{val[:head]}…{val[-tail:]}"


def _load_wallet_state() -> dict:
    if not WALLET_STATE_FILE.exists():
        return {"tokens": {}, "last_scanned_block": 0}
    return json.loads(WALLET_STATE_FILE.read_text())


def _save_wallet_state(state: dict) -> None:
    WALLET_STATE_FILE.write_text(json.dumps(state, indent=2))


def _encode_spend_signature(compact_hex: str, recovery_bit: int) -> bytes:
    """Encode compact_hex + recovery_bit into the 65-byte format the contract expects."""
    r_bytes = bytes.fromhex(compact_hex[:64])
    s_bytes = bytes.fromhex(compact_hex[64:])
    v_byte  = bytes([recovery_bit + 27])
    return r_bytes + s_bytes + v_byte


cli_app = typer.Typer(
    name="mock-redeem",
    help="Ghost-Tip Mock Redeemer — offline contract verification for testing.",
    no_args_is_help=True,
    rich_markup_mode="rich",
    pretty_exceptions_enable=False,
)


@cli_app.command()
def verify(
    index: Annotated[int, typer.Option("--index", "-i", help="Token index to redeem.", min=0)],
    to: Annotated[str, typer.Option("--to", help="Recipient Ethereum address.")],
    verbosity: Annotated[Verbosity, typer.Option("--verbosity", "-v")] = Verbosity.normal,
) -> None:
    """
    Verify a token redemption off-chain, simulating every step of
    GhostVault.redeem() without touching the blockchain.

    Reads the unblinded signature from .ghost_wallet.json (written by
    mock_mint.py sign), derives the spend key from MASTER_SEED, generates
    the anti-MEV ECDSA proof, and runs the full verification pipeline:
    ecrecover → nullifier check → BLS pairing.
    """
    is_verbose = verbosity == Verbosity.verbose
    is_quiet   = verbosity == Verbosity.quiet

    if not is_quiet:
        console.print(Panel(
            Text.assemble(("🔍  ", ""), ("MOCK REDEEMER · VERIFY", "banner"), ("  🔍", "")),
            subtitle=Text("GhostVault.redeem() simulation · no chain required", style="secondary"),
            border_style="magenta",
            padding=(0, 4),
        ))
        console.print()

    # ── Load config ───────────────────────────────────────────────────────
    master_seed_str = os.getenv("MASTER_SEED")
    if not master_seed_str:
        console.print("[error]  ❌  Missing MASTER_SEED in .env[/error]")
        raise typer.Exit(code=1)
    master_seed = master_seed_str.encode("utf-8")

    try:
        redeemer = MockRedeemer.from_env()
    except MockRedeemError as exc:
        console.print(f"[error]  ❌  {exc}[/error]")
        raise typer.Exit(code=1)

    # ── Load wallet state ─────────────────────────────────────────────────
    state = _load_wallet_state()
    token_key = str(index)
    rec = state.get("tokens", {}).get(token_key)

    if not rec:
        console.print(f"[error]  ❌  Token {index} not found in wallet state. Run 'mint_mock.py sign' first.[/error]")
        raise typer.Exit(code=1)

    if not rec.get("s_unblinded_x"):
        console.print(f"[error]  ❌  Token {index} has no unblinded signature. Run 'mint_mock.py sign' first.[/error]")
        raise typer.Exit(code=1)

    if rec.get("spent"):
        console.print(f"[warning]  ⚠️   Token {index} is already marked as spent in wallet state.[/warning]")

    s_x = int(rec["s_unblinded_x"], 16)
    s_y = int(rec["s_unblinded_y"], 16)

    if not is_quiet:
        console.print(Rule(f"[step]Step 1 · Load Token #{index}[/step]", style="dim magenta"))
        console.print(Text.assemble(
            ("  Spend address  ", "label"), (rec["spend_address"], "addr"),
        ))
        console.print(Text.assemble(
            ("  Deposit ID     ", "label"), (rec["deposit_id"], "addr"),
        ))
        if is_verbose:
            console.print(Text.assemble(("  S.x            ", "label"), (_short(hex(s_x), 18, 8), "hash")))
            console.print(Text.assemble(("  S.y            ", "label"), (_short(hex(s_y), 18, 8), "hash")))
        console.print()

    # ── Derive spend key and generate ECDSA proof ─────────────────────────
    if not is_quiet:
        console.print(Rule("[step]Step 2 · Generate Anti-MEV ECDSA Proof[/step]", style="dim magenta"))

    secrets = derive_token_secrets(master_seed, index)
    proof = generate_redemption_proof(secrets.spend_priv, to)

    if not is_quiet:
        console.print(Text.assemble(
            ("  Payload        ", "label"), (f'"Pay to RAW: " || {to} (32 bytes)', "value"),
        ))
        console.print(Text.assemble(
            ("  msg_hash       ", "label"), (_short(proof.msg_hash.hex(), 18, 8), "hash"),
        ))
        console.print(Text.assemble(
            ("  recovery_bit   ", "label"), (str(proof.recovery_bit), "num"),
            ("  (v = ", "muted"), (str(proof.recovery_bit + 27), "num"), (")", "muted"),
        ))
        if is_verbose:
            console.print(Text.assemble(
                ("  compact_hex    ", "label"), (_short("0x" + proof.compact_hex, 22, 8), "hash"),
            ))
        console.print()

    # ── Build 65-byte signature and run mock redeem ───────────────────────
    if not is_quiet:
        console.print(Rule("[step]Step 3 · Simulate GhostVault.redeem()[/step]", style="dim magenta"))

    sig_65 = _encode_spend_signature(proof.compact_hex, proof.recovery_bit)

    result = redeemer.redeem(
        recipient=to,
        spend_signature_bytes=sig_65,
        unblinded_s_x=s_x,
        unblinded_s_y=s_y,
    )

    if not is_quiet:
        console.print(Text.assemble(
            ("  [ecrecover]    → ", "muted"), (result.ecrecover_address or "FAILED", "addr"),
        ))
        console.print(Text.assemble(
            ("  [ECDSA check]  ", "label"),
            ("✅ PASS" if result.ecdsa_ok else "❌ FAIL", "success" if result.ecdsa_ok else "error"),
        ))
        console.print(Text.assemble(
            ("  [Nullifier]    ", "label"),
            ("✅ NOT SPENT" if not result.nullifier_spent else "❌ ALREADY SPENT",
             "success" if not result.nullifier_spent else "error"),
        ))
        console.print(Text.assemble(
            ("  [BLS pairing]  ", "label"),
            ("✅ PASS" if result.bls_pairing_ok else "❌ FAIL",
             "success" if result.bls_pairing_ok else "error"),
        ))
        console.print()

    if result.success:
        # Mark as spent in wallet state
        state["tokens"][token_key]["spent"] = True
        state["tokens"][token_key]["redeem_tx"] = "mock-redeem-verified"
        _save_wallet_state(state)

        if not is_quiet:
            console.print(Rule(style="dim magenta"))
            console.print(Text.assemble(
                ("  🎉  ", ""),
                ("Mock redeem PASSED", "success"),
                (" — all 4 contract checks verified off-chain.", "success"),
            ))
            console.print(Text.assemble(
                ("  📝  Wallet state updated: token ", "muted"),
                (str(index), "num"),
                (" → SPENT", "muted"),
            ))
            console.print()
    else:
        console.print(f"[error]  ❌  Redemption FAILED: {result.reason}[/error]")
        raise typer.Exit(code=1)


if __name__ == "__main__":
    cli_app()
