import os
from dataclasses import dataclass
from eth_keys import keys
from eth_utils import keccak
from py_ecc.bn128 import (
    G1, G2, multiply, curve_order, field_modulus, pairing, is_on_curve, FQ, b, b2
)

# ==============================================================================
# TYPE ALIASES
# Gives semantic meaning to raw tuples from py_ecc.
# G1Point = (FQ, FQ)        — a point on the BN254 G1 curve
# G2Point = (FQ2, FQ2)      — a point on the BN254 G2 curve
# ==============================================================================

G1Point = tuple
G2Point = tuple


# ==============================================================================
# DATA CLASSES
# Replaces plain dicts for all return types, giving IDE support and
# making the client/mint boundary explicit at the type level.
# ==============================================================================

@dataclass
class TokenSecrets:
    """
    Client-side only. Contains the spend private key — never passed to the mint.
    Supports both attribute access (secrets.spend_address_hex) and legacy dict-style
    access (secrets["spend_address_hex"]) for backward compatibility with existing tests.
    """
    spend_priv: keys.PrivateKey
    spend_address_hex: str
    spend_address_bytes: bytes
    r: int                          # BLS blinding scalar in Z_q



@dataclass
class BlindedPoints:
    Y: G1Point                      # H(spend_address) — unblinded hash-to-curve
    B: G1Point                      # r * Y             — blinded point sent to mint



@dataclass
class RedemptionProof:
    msg_hash: bytes
    compact_hex: str                # 128-char r||s hex, matches TS compactHex
    recovery_bit: int               # 0 or 1 — note: EVM ecrecover uses v = recovery_bit + 27
    signature_obj: keys.Signature   # raw eth_keys object for local verify



@dataclass
class MintKeypair:
    sk: int                         # BLS scalar private key
    pk: G2Point                     # sk * G2 — public key on G2



# ==============================================================================
# 1. CORE CRYPTOGRAPHY UTILS
# ==============================================================================

def hash_to_curve(message_bytes: bytes) -> G1Point:
    """
    Try-and-increment hash-to-curve for BN254 G1.
    Iterates until keccak(message || counter) yields a valid x coordinate.
    """
    counter = 0
    while True:
        h = keccak(message_bytes + counter.to_bytes(4, 'big'))
        x = int.from_bytes(h, 'big') % field_modulus
        y_squared = (pow(x, 3, field_modulus) + 3) % field_modulus
        if pow(y_squared, (field_modulus - 1) // 2, field_modulus) == 1:
            y = pow(y_squared, (field_modulus + 1) // 4, field_modulus)
            return (FQ(x), FQ(y))
        counter += 1


def serialize_g1(point: G1Point) -> tuple[int, int]:
    """Returns (x, y) as plain integers, ready for Solidity uint256[2]."""
    return (point[0].n, point[1].n)


def parse_g1(x: int, y: int) -> G1Point:
    """
    Reconstructs a G1Point from two uint256 integers (e.g. from a contract event).
    Raises ValueError if the result is not on the curve — guards mint_blind_sign
    against malformed client inputs.
    """
    point = (FQ(x), FQ(y))
    if not is_on_curve(point, b):
        raise ValueError(f"Point ({x}, {y}) is not on the BN254 G1 curve")
    return point


def generate_mint_keypair() -> MintKeypair:
    """Generates a random BLS scalar and its G2 public key."""
    sk = int.from_bytes(os.urandom(32), 'big') % curve_order
    pk = multiply(G2, sk)
    return MintKeypair(sk=sk, pk=pk)


# ==============================================================================
# 2. CLIENT OPERATIONS (User Wallet)
# ==============================================================================

def derive_token_secrets(master_seed: bytes, token_index: int) -> TokenSecrets:
    """
    Deterministically derives all client-side secrets for a given token index.
    The returned object is CLIENT-ONLY — spend_priv must never be sent to the mint.
    """
    base_material = keccak(master_seed + token_index.to_bytes(4, 'big'))

    spend_priv_bytes = keccak(b"spend" + base_material)
    spend_priv = keys.PrivateKey(spend_priv_bytes)
    spend_address_hex = spend_priv.public_key.to_address()
    spend_address_bytes = bytes.fromhex(spend_address_hex[2:])

    r = int.from_bytes(keccak(b"blind" + base_material), 'big') % curve_order

    return TokenSecrets(
        spend_priv=spend_priv,
        spend_address_hex=spend_address_hex,
        spend_address_bytes=spend_address_bytes,
        r=r,
    )


def blind_token(spend_address_bytes: bytes, r: int) -> BlindedPoints:
    """
    Maps the token secret to G1 and applies the multiplicative blinding factor.
    Returns BlindedPoints(Y, B) where only B is sent to the mint.
    """
    Y = hash_to_curve(spend_address_bytes)
    B = multiply(Y, r)
    return BlindedPoints(Y=Y, B=B)


def unblind_signature(S_prime: G1Point, r: int) -> G1Point:
    """
    Removes the blinding factor from the mint's signature.
    Returns S = S' * r^-1.
    """
    r_inv = pow(r, -1, curve_order)
    return multiply(S_prime, r_inv)


def generate_redemption_proof(spend_priv: keys.PrivateKey, destination_address: str) -> RedemptionProof:
    """
    Generates the anti-MEV ECDSA signature binding the token to a destination address.

    NOTE: recovery_bit is 0 or 1. The EVM ecrecover precompile expects v = recovery_bit + 27.
    The Solidity contract must add 27 when constructing the signature bytes for ecrecover,
    or use the (r, s, v) split form directly.
    """
    payload_str = f"Pay to: {destination_address}"
    msg_hash = keccak(payload_str.encode('utf-8'))
    ecdsa_sig = spend_priv.sign_msg_hash(msg_hash)

    r_hex = hex(ecdsa_sig.r)[2:].zfill(64)
    s_hex = hex(ecdsa_sig.s)[2:].zfill(64)
    compact_hex = r_hex + s_hex

    return RedemptionProof(
        msg_hash=msg_hash,
        compact_hex=compact_hex,
        recovery_bit=ecdsa_sig.v,
        signature_obj=ecdsa_sig,
    )


# ==============================================================================
# 3. MINT OPERATIONS (Server Daemon)
# ==============================================================================

def mint_blind_sign(B: G1Point, sk_mint: int) -> G1Point:
    """
    Blindly signs a client's G1 point using the mint's scalar private key.
    Returns S' = sk * B.

    Raises ValueError if B is not a valid G1 point — prevents signing garbage
    from a malformed or adversarial client request.
    """
    if not is_on_curve(B, b):
        raise ValueError("Blinded point B is not on the BN254 G1 curve")
    return multiply(B, sk_mint)


# ==============================================================================
# 4. VERIFICATION LOGIC (EVM Equivalents)
# ==============================================================================

def verify_ecdsa_mev_protection(
    msg_hash: bytes,
    compact_hex: str,
    recovery_bit: int,
    expected_address_hex: str,
) -> bool:
    """
    Simulates the EVM ecrecover precompile. Accepts the same compact_hex +
    recovery_bit format that generate_redemption_proof produces, so the two
    functions are directly composable without manual reconstruction.
    """
    r = int(compact_hex[:64], 16)
    s = int(compact_hex[64:], 16)
    sig = keys.Signature(vrs=(recovery_bit, r, s))
    recovered_pubkey = sig.recover_public_key_from_msg_hash(msg_hash)
    return recovered_pubkey.to_address().lower() == expected_address_hex.lower()


def verify_bls_pairing(S: G1Point, Y: G1Point, PK_mint: G2Point) -> bool:
    """
    Simulates the EVM 0x08 ecPairing precompile.
    Checks if e(S, G2) == e(Y, PK_mint).
    """
    return pairing(G2, S) == pairing(PK_mint, Y)


# ==============================================================================
# QUICK SMOKE TEST
# ==============================================================================

if __name__ == "__main__":
    print("Testing Ghost-Tip Helper Library...")

    master_seed = b"super_secret_seed"
    destination = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7"

    keypair = generate_mint_keypair()

    secrets = derive_token_secrets(master_seed, token_index=42)
    blinded = blind_token(secrets.spend_address_bytes, secrets.r)

    # Only B crosses the client->mint boundary
    S_prime = mint_blind_sign(blinded.B, keypair.sk)
    S = unblind_signature(S_prime, secrets.r)
    proof = generate_redemption_proof(secrets.spend_priv, destination)

    is_valid_ecdsa = verify_ecdsa_mev_protection(
        proof.msg_hash,
        proof.compact_hex,
        proof.recovery_bit,
        secrets.spend_address_hex,
    )
    is_valid_bls = verify_bls_pairing(S, blinded.Y, keypair.pk)

    print(f"MEV Protection Valid: {is_valid_ecdsa}")
    print(f"BLS Pairing Valid:    {is_valid_bls}")
