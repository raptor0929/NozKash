"""
Ghost-Tip Protocol: Parametrized Vector Tests

Discovers all vector files under test_vectors/ and runs the full protocol
verification suite against each one. Add more vectors by running:

    uv run generate_vectors.py

Then re-run pytest — new files are picked up automatically.
"""

import json
import pytest
from pathlib import Path
from py_ecc.bn128 import G2, multiply

import ghost_library as gl

# ==============================================================================
# VECTOR DISCOVERY
# ==============================================================================

VECTORS_DIR = Path(__file__).parent / "test_vectors"


def load_all_vectors() -> list[tuple[str, dict]]:
    """
    Returns a list of (test_id, vector_dict) for every JSON file found under
    test_vectors/. test_id is "<keypair_dir>/<filename>" for readable pytest output.
    """
    if not VECTORS_DIR.exists():
        return []
    files = sorted(VECTORS_DIR.rglob("*.json"))
    return [
        (f"{f.parent.name}/{f.stem}", json.loads(f.read_text()))
        for f in files
    ]


ALL_VECTORS = load_all_vectors()
IDS = [v[0] for v in ALL_VECTORS]
PARAMS = [v[1] for v in ALL_VECTORS]

# Fall back to the legacy vectors.json if no test_vectors/ directory exists yet,
# so the suite keeps passing before generate_vectors.py has been run.
if not PARAMS:
    _legacy = Path(__file__).parent / "vectors.json"
    if _legacy.exists():
        PARAMS = [json.loads(_legacy.read_text())]
        IDS = ["legacy/vectors"]


# ==============================================================================
# PARAMETRIZED TESTS
# ==============================================================================

@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_mint_pk_vector(v):
    """Proves the Mint's G2 Public Key derives correctly from the scalar."""
    sk_mint = int(v["MINT_BLS_PRIVKEY_INT"])
    pk_mint = multiply(G2, sk_mint)

    assert hex(pk_mint[0].coeffs[0].n)[2:] == v["PK_MINT"]["X_real"]
    assert hex(pk_mint[0].coeffs[1].n)[2:] == v["PK_MINT"]["X_imag"]
    assert hex(pk_mint[1].coeffs[0].n)[2:] == v["PK_MINT"]["Y_real"]
    assert hex(pk_mint[1].coeffs[1].n)[2:] == v["PK_MINT"]["Y_imag"]


@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_derive_token_secrets_vector(v):
    """Proves deterministic derivation yields the exact address and blinding factor."""
    master_seed = v["MASTER_SEED"].encode("utf-8")
    secrets = gl.derive_token_secrets(master_seed, v["TOKEN_INDEX"])

    assert secrets.spend_address_hex == v["SPEND_ADDRESS"]
    assert str(secrets.r) == v["BLINDING_R"]


@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_blind_token_vector(v):
    """Proves Hash-to-Curve mapping and multiplicative blinding match."""
    master_seed = v["MASTER_SEED"].encode("utf-8")
    secrets = gl.derive_token_secrets(master_seed, v["TOKEN_INDEX"])
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)

    assert hex(blinded.Y[0].n)[2:] == v["Y_HASH_TO_CURVE"]["X"]
    assert hex(blinded.Y[1].n)[2:] == v["Y_HASH_TO_CURVE"]["Y"]
    assert hex(blinded.B[0].n)[2:] == v["B_BLINDED"]["X"]
    assert hex(blinded.B[1].n)[2:] == v["B_BLINDED"]["Y"]


@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_mint_blind_sign_vector(v):
    """Proves the Mint's blind signature (S') generates the exact same point."""
    master_seed = v["MASTER_SEED"].encode("utf-8")
    secrets = gl.derive_token_secrets(master_seed, v["TOKEN_INDEX"])
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    sk_mint = int(v["MINT_BLS_PRIVKEY_INT"])

    S_prime = gl.mint_blind_sign(blinded.B, sk_mint)

    assert hex(S_prime[0].n)[2:] == v["S_PRIME"]["X"]
    assert hex(S_prime[1].n)[2:] == v["S_PRIME"]["Y"]


@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_unblind_signature_vector(v):
    """Proves client-side unblinding correctly recovers the final token signature."""
    master_seed = v["MASTER_SEED"].encode("utf-8")
    secrets = gl.derive_token_secrets(master_seed, v["TOKEN_INDEX"])
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    sk_mint = int(v["MINT_BLS_PRIVKEY_INT"])
    S_prime = gl.mint_blind_sign(blinded.B, sk_mint)

    S = gl.unblind_signature(S_prime, secrets.r)

    assert hex(S[0].n)[2:] == v["S_UNBLINDED"]["X"]
    assert hex(S[1].n)[2:] == v["S_UNBLINDED"]["Y"]


@pytest.mark.parametrize("v", PARAMS, ids=IDS)
def test_full_lifecycle_vector(v):
    """
    End-to-end pairing check: proves e(S, G2) == e(Y, PK_mint) for every vector.
    This is the mathematical statement the on-chain ecPairing call verifies.
    """
    master_seed = v["MASTER_SEED"].encode("utf-8")
    sk_mint = int(v["MINT_BLS_PRIVKEY_INT"])
    pk_mint = multiply(G2, sk_mint)

    secrets = gl.derive_token_secrets(master_seed, v["TOKEN_INDEX"])
    blinded = gl.blind_token(secrets.spend_address_bytes, secrets.r)
    S_prime = gl.mint_blind_sign(blinded.B, sk_mint)
    S = gl.unblind_signature(S_prime, secrets.r)

    assert gl.verify_bls_pairing(S, blinded.Y, pk_mint) is True
