import os
from dataclasses import dataclass
from typing import NewType
from eth_keys import keys
from eth_utils import keccak
from py_ecc.bn128 import (
    G2, multiply, curve_order, field_modulus, pairing, is_on_curve, FQ, FQ2, b
)

# ==============================================================================
# EXCEPTION HIERARCHY
# ==============================================================================

class GhostError(Exception):
    """Base class for all Ghost-Tip protocol errors."""


class CurveError(GhostError):
    """Raised when a curve point fails a validity check."""


class InvalidPointError(CurveError):
    """Raised when a supplied point does not lie on the expected curve."""
    def __init__(self, x: int, y: int, curve: str = "BN254 G1") -> None:
        super().__init__(f"Point (0x{x:x}, 0x{y:x}) is not on the {curve} curve")
        self.x = x
        self.y = y
        self.curve = curve


class ScalarMultiplicationError(CurveError):
    """Raised when scalar multiplication returns an unexpected result (e.g. point at infinity)."""


class DerivationError(GhostError):
    """Raised when token secret derivation receives invalid inputs."""


class VerificationError(GhostError):
    """Raised when a cryptographic verification step produces an unrecoverable error
    (as distinct from a clean False return from a verify_* function)."""


# ==============================================================================
# TYPE ALIASES
# ==============================================================================

G1Point = NewType("G1Point", tuple[FQ,  FQ])
G2Point = NewType("G2Point", tuple[FQ2, FQ2])
Scalar  = NewType("Scalar",  int)


def _mul_g1(point: G1Point, scalar: Scalar) -> G1Point:
    """
    Typed G1 scalar multiplication. Raises ScalarMultiplicationError instead
    of returning None — py_ecc types multiply() as Optional but None is only
    possible for the zero scalar, which is invalid in all protocol contexts.
    """
    result = multiply(point, scalar)
    if result is None:
        raise ScalarMultiplicationError(
            "G1 scalar multiplication returned the point at infinity — scalar must be non-zero"
        )
    return G1Point(result)


def _mul_g2(point: G2Point, scalar: Scalar) -> G2Point:
    """Typed G2 scalar multiplication — same contract as _mul_g1."""
    result = multiply(point, scalar)
    if result is None:
        raise ScalarMultiplicationError(
            "G2 scalar multiplication returned the point at infinity — scalar must be non-zero"
        )
    return G2Point(result)


# ==============================================================================
# DATA CLASSES
# ==============================================================================

@dataclass
class TokenKeypair:
    """
    A secp256k1 keypair derived deterministically from the master seed.
    Both the spend keypair and the blind keypair share this structure.

    The Ethereum address of each keypair serves a protocol role:
      - spend keypair address → nullifier (prevents double-spend)
      - blind keypair address → deposit ID (deterministic, unlinkable identifier)
    """
    priv:         keys.PrivateKey
    pub_hex:      str     # 0x04-prefixed uncompressed public key (65 bytes, 132 hex chars)
    address:      str     # 0x-prefixed Ethereum address (20 bytes)
    address_bytes: bytes  # raw 20 bytes


@dataclass
class TokenSecrets:
    """
    Client-side only. Both keypairs must never be sent to the mint.

    spend:  the nullifier keypair — address is the token's unique on-chain identifier
            at redemption time; the private key signs the anti-MEV payload.

    blind:  the blinding keypair — address is the deterministic deposit ID submitted
            with the deposit transaction; the private key (as a BN254 scalar) is the
            multiplicative blinding factor r used in B = r·Y.

    The deposit ID (blind.address) is revealed at deposit time but cannot be linked
    to the spend address (spend.address) without the master seed, preserving privacy.
    """
    spend: TokenKeypair
    blind: TokenKeypair

    @property
    def spend_priv(self) -> keys.PrivateKey:
        """Convenience accessor — the spend private key used in generate_redemption_proof."""
        return self.spend.priv

    @property
    def spend_address_hex(self) -> str:
        return self.spend.address

    @property
    def spend_address_bytes(self) -> bytes:
        return self.spend.address_bytes

    @property
    def r(self) -> Scalar:
        """
        The BLS blinding scalar, derived from the blind private key.
        Equivalent to int(blind.priv) % curve_order.
        """
        return Scalar(int.from_bytes(self.blind.priv.to_bytes(), "big") % curve_order)

    @property
    def deposit_id(self) -> str:
        """The deposit ID: the Ethereum address of the blind keypair."""
        return self.blind.address


@dataclass
class BlindedPoints:
    Y: G1Point      # H(spend_address) — unblinded hash-to-curve result
    B: G1Point      # r·Y              — blinded point sent to mint


@dataclass
class RedemptionProof:
    msg_hash:      bytes
    compact_hex:   str              # 128-char r||s hex, matches TS compactHex
    recovery_bit:  int              # 0 or 1 — EVM ecrecover uses v = recovery_bit + 27
    signature_obj: keys.Signature   # raw eth_keys object for local verify


@dataclass
class MintKeypair:
    sk: Scalar      # BLS scalar private key in Z_q
    pk: G2Point     # sk·G2 — public verification key


# ==============================================================================
# HELPERS
# ==============================================================================

def _derive_keypair(domain: bytes, base_material: bytes) -> TokenKeypair:
    """
    Derives a secp256k1 TokenKeypair from a domain separator and base material.
    Domain separators used by this library: b"spend", b"blind".
    """
    priv_bytes = keccak(domain + base_material)
    priv       = keys.PrivateKey(priv_bytes)
    pub_hex    = "0x04" + priv.public_key.to_bytes().hex()
    address    = priv.public_key.to_address()
    return TokenKeypair(
        priv=priv,
        pub_hex=pub_hex,
        address=address,
        address_bytes=bytes.fromhex(address[2:]),
    )


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
        h = keccak(message_bytes + counter.to_bytes(4, "big"))
        x = int.from_bytes(h, "big") % field_modulus
        y_squared = (pow(x, 3, field_modulus) + 3) % field_modulus
        if pow(y_squared, (field_modulus - 1) // 2, field_modulus) == 1:
            y = pow(y_squared, (field_modulus + 1) // 4, field_modulus)
            return G1Point((FQ(x), FQ(y)))
        counter += 1


def serialize_g1(point: G1Point) -> tuple[int, int]:
    """Returns (x, y) as plain integers, ready for Solidity uint256[2]."""
    return (point[0].n, point[1].n)


def parse_g1(x: int, y: int) -> G1Point:
    """
    Reconstructs a G1Point from two uint256 integers (e.g. from a contract event).
    Raises InvalidPointError if the point is not on the curve.
    """
    point = G1Point((FQ(x), FQ(y)))
    if not is_on_curve(point, b):
        raise InvalidPointError(x, y)
    return point


def generate_mint_keypair() -> MintKeypair:
    """Generates a random BLS scalar and its G2 public key."""
    sk = Scalar(int.from_bytes(os.urandom(32), "big") % curve_order)
    pk = _mul_g2(G2Point(G2), sk)
    return MintKeypair(sk=sk, pk=pk)


# ==============================================================================
# 2. CLIENT OPERATIONS (User Wallet)
# ==============================================================================

def derive_token_secrets(master_seed: bytes, token_index: int) -> TokenSecrets:
    """
    Deterministically derives both token keypairs for a given index.

    Both keypairs share the same base_material = keccak(seed || index), then
    are separated by domain: keccak(b"spend" || base) and keccak(b"blind" || base).

    The spend keypair address is the nullifier (revealed only at redemption).
    The blind keypair address is the deposit ID (revealed at deposit time).
    The blind private key, interpreted as a BN254 scalar, is the blinding factor r.

    The returned object is CLIENT-ONLY — neither private key must reach the mint.
    """
    if not master_seed:
        raise DerivationError("master_seed must be non-empty")
    if token_index < 0:
        raise DerivationError(f"token_index must be non-negative, got {token_index}")
    if token_index > 0xFFFFFFFF:
        raise DerivationError(f"token_index must fit in 32 bits, got {token_index}")

    base_material = keccak(master_seed + token_index.to_bytes(4, "big"))

    return TokenSecrets(
        spend=_derive_keypair(b"spend", base_material),
        blind=_derive_keypair(b"blind", base_material),
    )


def blind_token(spend_address_bytes: bytes, r: Scalar) -> BlindedPoints:
    """
    Maps the spend address to G1 and applies the multiplicative blinding factor.
    Returns BlindedPoints(Y, B) where only B is sent to the mint.
    """
    Y = hash_to_curve(spend_address_bytes)
    B = _mul_g1(Y, r)
    return BlindedPoints(Y=Y, B=B)


def unblind_signature(S_prime: G1Point, r: Scalar) -> G1Point:
    """
    Removes the blinding factor from the mint's signature.
    Returns S = S' · r^-1.
    """
    r_inv = Scalar(pow(r, -1, curve_order))
    return _mul_g1(S_prime, r_inv)


def generate_redemption_proof(
    spend_priv: keys.PrivateKey,
    destination_address: str,
) -> RedemptionProof:
    """
    Generates the anti-MEV ECDSA signature binding the token to a destination address.

    NOTE: recovery_bit is 0 or 1. The EVM ecrecover precompile expects v = recovery_bit + 27.
    The Solidity contract must add 27 when constructing the signature bytes for ecrecover,
    or use the (r, s, v) split form directly.
    """
    payload_str = f"Pay to: {destination_address}"
    msg_hash = keccak(payload_str.encode("utf-8"))
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

def mint_blind_sign(B: G1Point, sk_mint: Scalar) -> G1Point:
    """
    Blindly signs a client's G1 point using the mint's scalar private key.
    Returns S' = sk · B.

    Raises InvalidPointError if B is not a valid G1 point — prevents signing
    garbage from a malformed or adversarial client request.
    """
    if not is_on_curve(B, b):
        raise InvalidPointError(B[0].n, B[1].n)
    return _mul_g1(B, sk_mint)


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
    Simulates the EVM ecrecover precompile. Derives the signer's address from
    (msg_hash, compact_hex, recovery_bit) and compares to expected_address_hex.

    Returns False for invalid signatures. Raises VerificationError only for
    malformed inputs that indicate a programming error (wrong hex length, etc.).
    """
    if len(compact_hex) != 128:
        raise VerificationError(
            f"compact_hex must be 128 hex chars (64 bytes), got {len(compact_hex)}"
        )
    if recovery_bit not in (0, 1):
        raise VerificationError(
            f"recovery_bit must be 0 or 1, got {recovery_bit}"
        )
    try:
        r = int(compact_hex[:64], 16)
        s = int(compact_hex[64:], 16)
        sig = keys.Signature(vrs=(recovery_bit, r, s))
        recovered_pubkey = sig.recover_public_key_from_msg_hash(msg_hash)
        return recovered_pubkey.to_address().lower() == expected_address_hex.lower()
    except Exception:
        return False


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

    print(f"Spend address (nullifier):   {secrets.spend_address_hex}")
    print(f"Blind address (deposit ID):  {secrets.deposit_id}")
    print(f"Blinding scalar r:           {hex(secrets.r)}")

    blinded = blind_token(secrets.spend_address_bytes, secrets.r)

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
