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
    uv run generate_vectors.py                   # default: 3 keypairs × 5 indices
    uv run generate_vectors.py --keypairs 5 --indices 0 1 2 100 255 256 1000
"""

import argparse
import json
import os
import sys
from pathlib import Path

from py_ecc.bn128 import G2, multiply, curve_order

# Import the library so vectors are always consistent with its implementation.
# If the library changes, re-running this script regenerates ground truth.
import ghost_library as gl

VECTORS_DIR = Path("test_vectors")


def compute_vector(master_seed_hex: str, sk_int: int, token_index: int) -> dict:
    """
    Runs the full protocol for one (seed, keypair, token_index) combination
    and returns a dict containing every intermediate value.
    """
    master_seed_bytes = master_seed_hex.encode("utf-8")

    # --- Mint public key ---
    pk_g2 = multiply(G2, sk_int)
    x_real = hex(pk_g2[0].coeffs[0].n)[2:]
    x_imag = hex(pk_g2[0].coeffs[1].n)[2:]
    y_real = hex(pk_g2[1].coeffs[0].n)[2:]
    y_imag = hex(pk_g2[1].coeffs[1].n)[2:]

    # --- Client secrets ---
    secrets = gl.derive_token_secrets(master_seed_bytes, token_index)

    # --- Blinding ---
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)

    # --- Mint signs ---
    S_prime = gl.mint_blind_sign(blinded.B, sk_int)

    # --- Client unblinds ---
    S = gl.unblind_signature(S_prime, secrets.r)

    return {
        # Inputs
        "MASTER_SEED": master_seed_hex,
        "TOKEN_INDEX": token_index,
        "MINT_BLS_PRIVKEY_INT": str(sk_int),

        # Mint public key (G2)
        "PK_MINT": {
            "X_real": x_real,
            "X_imag": x_imag,
            "Y_real": y_real,
            "Y_imag": y_imag,
        },

        # Client-derived secrets
        "SPEND_ADDRESS": secrets.spend_address_hex,
        "BLINDING_R": str(secrets.r),

        # Hash-to-curve (Y = H(spend_address))
        "Y_HASH_TO_CURVE": {
            "X": hex(blinded.Y[0].n)[2:],
            "Y": hex(blinded.Y[1].n)[2:],
        },

        # Blinded point (B = r * Y)
        "B_BLINDED": {
            "X": hex(blinded.B[0].n)[2:],
            "Y": hex(blinded.B[1].n)[2:],
        },

        # Blind signature (S' = sk * B)
        "S_PRIME": {
            "X": hex(S_prime[0].n)[2:],
            "Y": hex(S_prime[1].n)[2:],
        },

        # Unblinded token signature (S = S' * r^-1)
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

    # Always include index 256 to exercise the DataView fix (would silently collide
    # with index 0 under the old Uint8Array([0,0,0,tokenIndex]) encoding).
    indices = sorted(set(args.indices))

    print(f"Generating {args.keypairs} keypair(s) × {len(indices)} index/indices "
          f"= {args.keypairs * len(indices)} vector files\n")

    total = 0
    for kp_num in range(1, args.keypairs + 1):
        master_seed_hex, sk_int = generate_keypair()
        seed_prefix = master_seed_hex[:8]
        sk_prefix = hex(sk_int)[-8:]
        kp_dir = args.out / f"{seed_prefix}_{sk_prefix}"

        print(f"[{kp_num}/{args.keypairs}] seed={seed_prefix}...  sk=...{sk_prefix}")

        for idx in indices:
            vector = compute_vector(master_seed_hex, sk_int, idx)
            path = write_vector(vector, kp_dir)
            print(f"    token_{idx:>5}  →  {path}")
            total += 1

    print(f"\n✅ {total} vector files written to {args.out}/")


if __name__ == "__main__":
    main()
