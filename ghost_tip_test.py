"""
Ghost-Tip Protocol: Full Lifecycle Smoke Test (.env enabled)

Runs the complete protocol end-to-end using keys from .env, printing every
intermediate cryptographic value for cross-language comparison and debugging.

Usage:
    uv run ghost_tip_test.py
"""
import os

from dotenv import load_dotenv
from py_ecc.bn128 import G2, pairing

import ghost_library as gl
from ghost_library import Scalar, G2Point, _mul_g2, serialize_g1

load_dotenv()

# ==============================================================================
# FORMATTING HELPERS
# ==============================================================================

def print_g1(name: str, point) -> None:
    print(f"    {name} (X) : {hex(point[0].n)[2:]}")
    print(f"    {name} (Y) : {hex(point[1].n)[2:]}")

def print_g2(name: str, point) -> None:
    print(f"    {name} (X_real) : {hex(point[0].coeffs[0].n)[2:]}")
    print(f"    {name} (X_imag) : {hex(point[0].coeffs[1].n)[2:]}")
    print(f"    {name} (Y_real) : {hex(point[1].coeffs[0].n)[2:]}")
    print(f"    {name} (Y_imag) : {hex(point[1].coeffs[1].n)[2:]}")

# ==============================================================================
# MAIN
# ==============================================================================

def main() -> None:
    print("👻 GHOST-TIP PROTOCOL: FULL LIFECYCLE TEST (.ENV ENABLED) 👻\n")

    # ── 0. Mint setup ─────────────────────────────────────────────────────────
    print("[0] Loading Mint Configuration from .env...")
    sk_hex = os.getenv("MINT_BLS_PRIVKEY") or os.getenv("MINT_BLS_PRIVKEY_INT")
    if not sk_hex:
        raise ValueError("Missing MINT_BLS_PRIVKEY in .env. Run generate_keys.py first.")

    sk_mint = Scalar(int(sk_hex, 16) if sk_hex.startswith("0x") else int(sk_hex))
    pk_mint = _mul_g2(G2Point(G2), sk_mint)

    print("    ✅ Mint Keys loaded securely.")
    print_g2("PK_mint", pk_mint)
    print()

    # ── 1. Token derivation ───────────────────────────────────────────────────
    print("[1] Deriving Token Secrets (User's Wallet)...")
    master_seed_str = os.getenv("MASTER_SEED")
    if not master_seed_str:
        raise ValueError("Missing MASTER_SEED in .env.")

    master_seed = master_seed_str.encode("utf-8")
    token_index = 42

    secrets = gl.derive_token_secrets(master_seed, token_index)

    print(f"    Token Index        : {token_index}")
    print(f"    Spend address      : {secrets.spend.address}  (nullifier — revealed at redemption)")
    print(f"    Spend pub          : {secrets.spend.pub_hex[:20]}...")
    print(f"    Blind address      : {secrets.blind.address}  (deposit ID — revealed at deposit)")
    print(f"    Blind pub          : {secrets.blind.pub_hex[:20]}...")
    print(f"    Blinding scalar r  : {hex(secrets.r)}")
    print()

    # ── 2. Blinding ───────────────────────────────────────────────────────────
    print("[2] Client Blinding the Token...")
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)

    print_g1("Y = H(spend_addr)", blinded.Y)
    print_g1("B = r·Y (blinded)", blinded.B)
    print(f"    Deposit ID (blind address) : {secrets.deposit_id}")
    print("    B + deposit_id sent to contract.\n")

    # ── 3. Blind signing ──────────────────────────────────────────────────────
    print("[3] Mint blindly signing the point...")
    S_prime = gl.mint_blind_sign(blinded.B, sk_mint)

    print_g1("S' = sk·B (blind sig)", S_prime)
    print("    S' announced on-chain.\n")

    # ── 4. Unblinding ─────────────────────────────────────────────────────────
    print("[4] Client unblinding the signature...")
    S = gl.unblind_signature(S_prime, secrets.r)

    print_g1("S = S'·r⁻¹ (token)", S)
    print("    Valid token (spend_address, S) obtained.\n")

    # ── 5. Redemption proof ───────────────────────────────────────────────────
    print("[5] Generating Redemption Proof for Smart Contract...")
    destination = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7"
    proof = gl.generate_redemption_proof(secrets.spend_priv, destination)

    print(f"    Destination      : {destination}")
    print(f"    msg_hash         : {proof.msg_hash.hex()}")
    print(f"    compact_hex      : 0x{proof.compact_hex}")
    print(f"    recovery_bit     : {proof.recovery_bit}")
    print()

    # ── 6. EVM verification ───────────────────────────────────────────────────
    print("[6] EVM Verification (Redemption Transaction)...")

    ecdsa_ok = gl.verify_ecdsa_mev_protection(
        proof.msg_hash,
        proof.compact_hex,
        proof.recovery_bit,
        secrets.spend_address_hex,
    )
    assert ecdsa_ok, "ECDSA verification failed!"
    print(f"    [ecrecover] → {secrets.spend.address}")
    print("    ✅ MEV Protection Verified!")

    bls_ok = gl.verify_bls_pairing(S, blinded.Y, pk_mint)
    assert bls_ok, "BLS pairing failed!"
    print("    ✅ BLS Pairing Verified! Mathematical proof is flawless.")
    print("\n🎉 TRANSACTION SUCCESS: 0.01 Sepolia ETH Transferred! 🎉")


if __name__ == "__main__":
    main()
