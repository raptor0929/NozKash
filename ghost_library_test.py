import pytest
from eth_utils import keccak
from py_ecc.bn128 import curve_order, is_on_curve, b, b2

import ghost_library as gl

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


# ==============================================================================
# TESTS
# ==============================================================================

def test_mint_keypair_generation():
    """Ensures the Mint generates valid scalar keys and G2 points."""
    keypair = gl.generate_mint_keypair()

    assert isinstance(keypair.sk, int)
    assert 0 < keypair.sk < curve_order
    assert is_on_curve(keypair.pk, b2)


def test_token_derivation_is_deterministic(setup_data):
    """Proves that passing the same seed and index yields the exact same secrets."""
    master_seed, token_index, _ = setup_data

    secrets1 = gl.derive_token_secrets(master_seed, token_index)
    secrets2 = gl.derive_token_secrets(master_seed, token_index)

    assert secrets1.spend_address_hex == secrets2.spend_address_hex
    assert secrets1.spend_priv.to_hex() == secrets2.spend_priv.to_hex()
    assert secrets1.r == secrets2.r


def test_full_protocol_lifecycle(setup_data):
    """Integration test: proves the math holds from blinding through verification."""
    master_seed, token_index, destination = setup_data

    # 1. Setup Mint
    keypair = gl.generate_mint_keypair()

    # 2. Client Setup & Blinding
    secrets = gl.derive_token_secrets(master_seed, token_index)
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)

    assert is_on_curve(blinded.Y, b)
    assert is_on_curve(blinded.B, b)

    # 3. Mint Signs
    S_prime = gl.mint_blind_sign(blinded.B, keypair.sk)
    assert is_on_curve(S_prime, b)

    # 4. Client Unblinds & Proof
    S = gl.unblind_signature(S_prime, secrets.r)
    assert is_on_curve(S, b)

    proof = gl.generate_redemption_proof(secrets.spend_priv, destination)

    # 5. EVM Verification (ECDSA Check)
    is_valid_ecdsa = gl.verify_ecdsa_mev_protection(
        proof.msg_hash,
        proof.compact_hex,
        proof.recovery_bit,
        secrets.spend_address_hex,
    )
    assert is_valid_ecdsa is True

    # 6. EVM Verification (BLS Check)
    is_valid_bls = gl.verify_bls_pairing(S, blinded.Y, keypair.pk)
    assert is_valid_bls is True


def test_mev_protection_rejects_tampering(setup_data):
    """Proves that a tampered destination payload invalidates the ecrecover extraction."""
    master_seed, token_index, _ = setup_data
    secrets = gl.derive_token_secrets(master_seed, token_index)

    intended_destination = "0xAliceAddress"
    proof = gl.generate_redemption_proof(secrets.spend_priv, intended_destination)

    # A front-running MEV bot intercepts and tries to redirect funds to Bob
    tampered_payload_str = "Pay to: 0xBobAddress"
    tampered_msg_hash = keccak(tampered_payload_str.encode('utf-8'))

    # ecrecover on the tampered hash yields a garbage address, not the spend address
    is_valid = gl.verify_ecdsa_mev_protection(
        tampered_msg_hash,
        proof.compact_hex,
        proof.recovery_bit,
        secrets.spend_address_hex,
    )
    assert is_valid is False
