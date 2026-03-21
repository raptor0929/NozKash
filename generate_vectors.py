"""
Ghost-Tip Protocol: Test Vector Generator

Generates cryptographic test vectors covering the full protocol lifecycle
for multiple (mint keypair, token index) combinations. Each vector file is
a self-contained JSON snapshot of every intermediate value produced during
one run of the protocol, suitable for cross-language parity testing.

Output layout:
    test_vectors/
        <seed_prefix>_<sk_prefix>/
            token_<index>.json   — one file per token index tested

Usage:
    uv run generate_vectors.py                   # default: 3 keypairs × 6 indices
    uv run generate_vectors.py --keypairs 5 --indices 0 1 2 100 255 256 1000
"""

import argparse
import json
import os
from pathlib import Path

from py_ecc.bn128 import G2, curve_order
from ghost_library import Scalar, G2Point, _mul_g2

import ghost_library as gl

VECTORS_DIR = Path("test_vectors")


def compute_vector(master_seed_hex: str, sk_int: int, token_index: int) -> dict:
    """
    Runs the full protocol for one (seed, keypair, token_index) combination
    and returns a dict containing every intermediate value.

    Vector format:

    Inputs:
        MASTER_SEED         hex seed string
        TOKEN_INDEX         integer
        MINT_BLS_PRIVKEY    hex BLS scalar

    Mint public key (G2, py_ecc FQ2 coordinate order):
        PK_MINT.{X_real, X_imag, Y_real, Y_imag}

    Spend keypair (nullifier identity):
        SPEND_KEYPAIR.priv      hex private key bytes
        SPEND_KEYPAIR.pub       hex uncompressed public key (0x04...)
        SPEND_KEYPAIR.address   0x-prefixed Ethereum address (the nullifier)

    Blind keypair (deposit identity + BLS blinding factor):
        BLIND_KEYPAIR.priv      hex private key bytes
        BLIND_KEYPAIR.pub       hex uncompressed public key (0x04...)
        BLIND_KEYPAIR.address   0x-prefixed Ethereum address (the deposit ID)
        BLIND_KEYPAIR.r         hex BLS scalar = int(priv) % curve_order

    BLS protocol intermediates:
        Y_HASH_TO_CURVE.{X, Y}  H(spend_address) on BN254 G1
        B_BLINDED.{X, Y}        r·Y — sent to mint
        S_PRIME.{X, Y}          sk·B — mint's blind signature
        S_UNBLINDED.{X, Y}      S'·r⁻¹ — the final token signature
    """
    master_seed_bytes = master_seed_hex.encode("utf-8")

    # --- Mint public key ---
    sk = Scalar(sk_int)
    pk_g2 = _mul_g2(G2Point(G2), sk)

    # --- Client secrets (both keypairs) ---
    secrets = gl.derive_token_secrets(master_seed_bytes, token_index)

    # --- BLS protocol ---
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    S_prime = gl.mint_blind_sign(blinded.B, sk)
    S       = gl.unblind_signature(S_prime, secrets.r)

    return {
        # ── Inputs ────────────────────────────────────────────────────────────
        "MASTER_SEED":      master_seed_hex,
        "TOKEN_INDEX":      token_index,
        "MINT_BLS_PRIVKEY": hex(sk_int),

        # ── Mint public key (G2) ──────────────────────────────────────────────
        "PK_MINT": {
            "X_real": hex(pk_g2[0].coeffs[0].n)[2:],
            "X_imag": hex(pk_g2[0].coeffs[1].n)[2:],
            "Y_real": hex(pk_g2[1].coeffs[0].n)[2:],
            "Y_imag": hex(pk_g2[1].coeffs[1].n)[2:],
        },

        # ── Spend keypair (nullifier) ─────────────────────────────────────────
        # The spend address is the token's nullifier — revealed only at redemption.
        # The private key signs the anti-MEV payload "Pay to: <recipient>".
        "SPEND_KEYPAIR": {
            "priv":    secrets.spend.priv.to_bytes().hex(),
            "pub":     secrets.spend.pub_hex,
            "address": secrets.spend.address,
        },

        # ── Blind keypair (deposit ID + blinding factor) ──────────────────────
        # The blind address is the deposit ID — submitted with the deposit tx.
        # It reveals nothing about the spend address without the master seed.
        # The private key, as a BN254 scalar, IS the multiplicative blinding factor r.
        "BLIND_KEYPAIR": {
            "priv":    secrets.blind.priv.to_bytes().hex(),
            "pub":     secrets.blind.pub_hex,
            "address": secrets.blind.address,
            "r":       hex(secrets.r),   # int(priv) % curve_order
        },

        # ── BLS protocol intermediates ────────────────────────────────────────
        "Y_HASH_TO_CURVE": {
            "X": hex(blinded.Y[0].n)[2:],
            "Y": hex(blinded.Y[1].n)[2:],
        },
        "B_BLINDED": {
            "X": hex(blinded.B[0].n)[2:],
            "Y": hex(blinded.B[1].n)[2:],
        },
        "S_PRIME": {
            "X": hex(S_prime[0].n)[2:],
            "Y": hex(S_prime[1].n)[2:],
        },
        "S_UNBLINDED": {
            "X": hex(S[0].n)[2:],
            "Y": hex(S[1].n)[2:],
        },
    }


def generate_keypair() -> tuple[str, int]:
    """Returns (master_seed_hex, sk_int) as fresh random material."""
    master_seed_hex = os.urandom(32).hex()
    sk_int = int.from_bytes(os.urandom(32), "big") % curve_order
    return master_seed_hex, sk_int


def write_vector(vector: dict, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"token_{vector['TOKEN_INDEX']}.json"
    path.write_text(json.dumps(vector, indent=2))
    return path


def main():
    parser = argparse.ArgumentParser(description="Generate Ghost-Tip protocol test vectors")
    parser.add_argument(
        "--keypairs", type=int, default=3,
        help="Number of random (seed, mint keypair) combinations to generate (default: 3)"
    )
    parser.add_argument(
        "--indices", type=int, nargs="+",
        default=[0, 1, 42, 255, 256, 1000],
        help="Token indices to generate per keypair (default: 0 1 42 255 256 1000)"
    )
    parser.add_argument(
        "--out", type=Path, default=VECTORS_DIR,
        help=f"Output directory (default: {VECTORS_DIR})"
    )
    args = parser.parse_args()

    indices = sorted(set(args.indices))

    print(f"Generating {args.keypairs} keypair(s) × {len(indices)} index/indices "
          f"= {args.keypairs * len(indices)} vector files\n")

    total = 0
    for kp_num in range(1, args.keypairs + 1):
        master_seed_hex, sk_int = generate_keypair()
        seed_prefix = master_seed_hex[:8]
        sk_prefix   = hex(sk_int)[-8:]
        kp_dir      = args.out / f"{seed_prefix}_{sk_prefix}"

        print(f"[{kp_num}/{args.keypairs}] seed={seed_prefix}...  sk=...{sk_prefix}")

        for idx in indices:
            vector = compute_vector(master_seed_hex, sk_int, idx)
            path   = write_vector(vector, kp_dir)
            print(f"    token_{idx:>5}  →  {path}")
            total += 1

    print(f"\n✅ {total} vector files written to {args.out}/")


if __name__ == "__main__":
    main()
