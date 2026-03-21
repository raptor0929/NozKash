import pytest
from eth_utils import keccak
from py_ecc.bn128 import curve_order, is_on_curve, b, b2

import ghost_library as gl
from ghost_library import (
    GhostError, CurveError, InvalidPointError, ScalarMultiplicationError,
    DerivationError, VerificationError,
)

# ==============================================================================
# FIXTURES
# ==============================================================================

@pytest.fixture
def setup_data():
    """Provides standard deterministic inputs for the tests."""
    master_seed = b"pytest_secret_master_seed_2026"
    token_index = 42
    destination = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7"
    return master_seed, token_index, destination


@pytest.fixture
def live_keypair():
    return gl.generate_mint_keypair()


# ==============================================================================
# EXCEPTION HIERARCHY
# ==============================================================================

def test_exception_hierarchy():
    """Verifies the exception inheritance chain is correctly structured."""
    assert issubclass(CurveError,                 GhostError)
    assert issubclass(InvalidPointError,          CurveError)
    assert issubclass(ScalarMultiplicationError,  CurveError)
    assert issubclass(DerivationError,            GhostError)
    assert issubclass(VerificationError,          GhostError)


# ==============================================================================
# MINT KEYPAIR
# ==============================================================================

def test_mint_keypair_generation():
    """Ensures the Mint generates valid scalar keys and G2 points."""
    keypair = gl.generate_mint_keypair()
    assert isinstance(keypair.sk, int)
    assert 0 < keypair.sk < curve_order
    assert is_on_curve(keypair.pk, b2)


def test_mint_keypairs_are_unique():
    """Two sequential keypairs must not be identical."""
    kp1 = gl.generate_mint_keypair()
    kp2 = gl.generate_mint_keypair()
    assert kp1.sk != kp2.sk


# ==============================================================================
# TOKEN DERIVATION
# ==============================================================================

def test_token_derivation_is_deterministic(setup_data):
    """Proves that passing the same seed and index yields the exact same secrets."""
    master_seed, token_index, _ = setup_data
    s1 = gl.derive_token_secrets(master_seed, token_index)
    s2 = gl.derive_token_secrets(master_seed, token_index)
    assert s1.spend_address_hex == s2.spend_address_hex
    assert s1.spend_priv.to_hex() == s2.spend_priv.to_hex()
    assert s1.r == s2.r


def test_different_indices_yield_different_secrets(setup_data):
    """Different token indices must produce completely different outputs."""
    master_seed, _, _ = setup_data
    s0 = gl.derive_token_secrets(master_seed, 0)
    s1 = gl.derive_token_secrets(master_seed, 1)
    assert s0.spend_address_hex != s1.spend_address_hex
    assert s0.r != s1.r


def test_different_seeds_yield_different_secrets():
    """Different seeds must produce completely different outputs for the same index."""
    s1 = gl.derive_token_secrets(b"seed_a", 0)
    s2 = gl.derive_token_secrets(b"seed_b", 0)
    assert s1.spend_address_hex != s2.spend_address_hex


def test_index_boundary_256_differs_from_0(setup_data):
    """
    Index 256 must not collide with index 0.
    Catches the DataView/Uint8Array truncation bug where 256 & 0xFF == 0.
    """
    master_seed, _, _ = setup_data
    s0   = gl.derive_token_secrets(master_seed, 0)
    s256 = gl.derive_token_secrets(master_seed, 256)
    assert s0.spend_address_hex != s256.spend_address_hex
    assert s0.r != s256.r


def test_derive_rejects_empty_seed():
    with pytest.raises(DerivationError, match="non-empty"):
        gl.derive_token_secrets(b"", 0)


def test_derive_rejects_negative_index():
    with pytest.raises(DerivationError, match="non-negative"):
        gl.derive_token_secrets(b"seed", -1)


def test_derive_rejects_oversized_index():
    with pytest.raises(DerivationError, match="32 bits"):
        gl.derive_token_secrets(b"seed", 0x1_0000_0000)


# ==============================================================================
# POINT VALIDATION
# ==============================================================================

def test_parse_g1_valid_point(setup_data):
    """A round-trip through serialize_g1 / parse_g1 must be lossless."""
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    x, y = gl.serialize_g1(blinded.Y)
    recovered = gl.parse_g1(x, y)
    assert recovered[0].n == blinded.Y[0].n
    assert recovered[1].n == blinded.Y[1].n


def test_parse_g1_rejects_invalid_point():
    """parse_g1 must raise InvalidPointError for a point not on the curve.
    Note: (1, 2) is actually valid on BN254 since 2^2 == 1^3 + 3 == 4.
    (1, 1) is not: 1^2=1 != 1^3+3=4.
    """
    with pytest.raises(InvalidPointError) as exc_info:
        gl.parse_g1(1, 1)
    assert isinstance(exc_info.value, CurveError)
    assert isinstance(exc_info.value, GhostError)
    assert exc_info.value.x == 1
    assert exc_info.value.y == 1


def test_mint_blind_sign_rejects_invalid_point():
    """mint_blind_sign must raise InvalidPointError for an off-curve input."""
    from py_ecc.bn128 import FQ
    from ghost_library import G1Point
    # (1, 1) is off-curve on BN254: 1^2=1 != 1^3+3=4
    bad_point = G1Point((FQ(1), FQ(1)))
    keypair = gl.generate_mint_keypair()
    with pytest.raises(InvalidPointError):
        gl.mint_blind_sign(bad_point, keypair.sk)


# ==============================================================================
# FULL PROTOCOL LIFECYCLE
# ==============================================================================

def test_full_protocol_lifecycle(setup_data, live_keypair):
    """Integration test: proves the math holds from blinding through verification."""
    master_seed, token_index, destination = setup_data
    keypair = live_keypair

    secrets = gl.derive_token_secrets(master_seed, token_index)
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)

    assert is_on_curve(blinded.Y, b)
    assert is_on_curve(blinded.B, b)

    S_prime = gl.mint_blind_sign(blinded.B, keypair.sk)
    assert is_on_curve(S_prime, b)

    S = gl.unblind_signature(S_prime, secrets.r)
    assert is_on_curve(S, b)

    proof = gl.generate_redemption_proof(secrets.spend_priv, destination)

    assert gl.verify_ecdsa_mev_protection(
        proof.msg_hash, proof.compact_hex, proof.recovery_bit, secrets.spend_address_hex
    ) is True

    assert gl.verify_bls_pairing(S, blinded.Y, keypair.pk) is True


# ==============================================================================
# MEV PROTECTION
# ==============================================================================

def test_mev_protection_rejects_tampered_destination(setup_data):
    """Tampered destination must yield a wrong address from ecrecover."""
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)
    proof = gl.generate_redemption_proof(secrets.spend_priv, "0xAliceAddress")

    tampered_hash = keccak("Pay to: 0xBobAddress".encode("utf-8"))
    assert gl.verify_ecdsa_mev_protection(
        tampered_hash, proof.compact_hex, proof.recovery_bit, secrets.spend_address_hex
    ) is False


def test_mev_protection_rejects_wrong_recovery_bit(setup_data):
    """
    Wrong recovery bit must cause ecrecover to derive the wrong address.
    This directly tests that our verify path actually uses the recovery bit,
    not a stored public key shortcut.
    """
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)
    proof = gl.generate_redemption_proof(secrets.spend_priv, "0xAliceAddress")

    wrong_bit = 1 - proof.recovery_bit
    # With the wrong recovery bit ecrecover returns a different (garbage) address
    assert gl.verify_ecdsa_mev_protection(
        proof.msg_hash, proof.compact_hex, wrong_bit, secrets.spend_address_hex
    ) is False


def test_mev_protection_raises_on_bad_compact_hex(setup_data):
    """verify_ecdsa_mev_protection must raise VerificationError for malformed hex."""
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)
    proof = gl.generate_redemption_proof(secrets.spend_priv, "0xAlice")

    with pytest.raises(VerificationError, match="128 hex chars"):
        gl.verify_ecdsa_mev_protection(
            proof.msg_hash, "tooshort", proof.recovery_bit, secrets.spend_address_hex
        )


def test_mev_protection_raises_on_bad_recovery_bit(setup_data):
    """verify_ecdsa_mev_protection must raise VerificationError for invalid recovery bit."""
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)
    proof = gl.generate_redemption_proof(secrets.spend_priv, "0xAlice")

    with pytest.raises(VerificationError, match="recovery_bit"):
        gl.verify_ecdsa_mev_protection(
            proof.msg_hash, proof.compact_hex, 5, secrets.spend_address_hex
        )


# ==============================================================================
# BLS PAIRING
# ==============================================================================

def test_bls_pairing_rejects_wrong_keypair(setup_data):
    """Signature from one keypair must not verify under a different keypair."""
    master_seed, token_index, _ = setup_data
    kp1 = gl.generate_mint_keypair()
    kp2 = gl.generate_mint_keypair()

    secrets = gl.derive_token_secrets(master_seed, token_index)
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    S_prime = gl.mint_blind_sign(blinded.B, kp1.sk)
    S = gl.unblind_signature(S_prime, secrets.r)

    # Should pass under kp1
    assert gl.verify_bls_pairing(S, blinded.Y, kp1.pk) is True
    # Must fail under kp2
    assert gl.verify_bls_pairing(S, blinded.Y, kp2.pk) is False


def test_bls_pairing_rejects_wrong_token(setup_data, live_keypair):
    """Signature over token A must not verify against token B's Y point."""
    master_seed, _, _ = setup_data
    keypair = live_keypair

    secrets_a = gl.derive_token_secrets(master_seed, 0)
    secrets_b = gl.derive_token_secrets(master_seed, 1)

    blinded_a = gl.blind_token(secrets_a.spend_address_bytes, secrets_a.r)
    blinded_b = gl.blind_token(secrets_b.spend_address_bytes, secrets_b.r)

    S_prime = gl.mint_blind_sign(blinded_a.B, keypair.sk)
    S = gl.unblind_signature(S_prime, secrets_a.r)

    assert gl.verify_bls_pairing(S, blinded_a.Y, keypair.pk) is True
    assert gl.verify_bls_pairing(S, blinded_b.Y, keypair.pk) is False
