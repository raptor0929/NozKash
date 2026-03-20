import os
from eth_keys import keys
from eth_utils import keccak
from py_ecc.bn128 import G1, G2, multiply, curve_order, field_modulus, pairing, FQ


# ==============================================================================
# CRYPTOGRAPHIC HELPER: HASH-TO-CURVE (BN254 / alt_bn128)
# ==============================================================================
def hash_to_curve(message_bytes: bytes) -> tuple:
    """
    A 'try-and-increment' hash-to-curve mapping for BN254 G1.
    Finds a valid x coordinate where x^3 + 3 is a quadratic residue.
    """
    counter = 0
    while True:
        # Hash the payload + counter
        h = keccak(message_bytes + counter.to_bytes(4, "big"))
        x = int.from_bytes(h, "big") % field_modulus

        # BN254 equation: y^2 = x^3 + 3
        y_squared = (pow(x, 3, field_modulus) + 3) % field_modulus

        # Check if y_squared is a quadratic residue using Euler's criterion
        if pow(y_squared, (field_modulus - 1) // 2, field_modulus) == 1:
            # BN254 field_modulus = 3 mod 4, so y = sqrt(v) = v^((p+1)/4) mod p
            y = pow(y_squared, (field_modulus + 1) // 4, field_modulus)

            # Return the point as py_ecc FQ objects
            return (FQ(x), FQ(y))

        counter += 1


# ==============================================================================
# MAIN LIFECYCLE TEST
# ==============================================================================
def main():
    print("👻 GHOST-TIP PROTOCOL: FULL LIFECYCLE TEST 👻\n")

    # --------------------------------------------------------------------------
    # 0. MINT SETUP (Server Side)
    # --------------------------------------------------------------------------
    print("[0] Setting up the Mint...")
    sk_mint = int.from_bytes(os.urandom(32), "big") % curve_order
    PK_mint = multiply(G2, sk_mint)
    print(f"    Mint BLS Private Key : {sk_mint}")
    print(f"    Mint BLS Public Key  : Generated on G2\n")

    # --------------------------------------------------------------------------
    # 1. DETERMINISTIC DERIVATION (Client Side)
    # --------------------------------------------------------------------------
    print("[1] Deriving Token Secrets (User's Wallet)...")
    master_seed = b"ghost_tip_secret_master_seed_2026"
    token_index = 42

    base_material = keccak(master_seed + token_index.to_bytes(4, "big"))

    # A. The Spend Key (Identity & MEV Protection)
    spend_priv_bytes = keccak(b"spend" + base_material)
    spend_priv = keys.PrivateKey(spend_priv_bytes)
    spend_address_hex = spend_priv.public_key.to_address()
    spend_address_bytes = bytes.fromhex(spend_address_hex[2:])

    # B. The Blinding Factor (Scalar for BN254)
    r = int.from_bytes(keccak(b"blind" + base_material), "big") % curve_order

    print(f"    Token Index   : {token_index}")
    print(
        f"    Spend Address : {spend_address_hex} (This is the Token Secret/Nullifier!)"
    )
    print(f"    Blinding 'r'  : {r}\n")

    # --------------------------------------------------------------------------
    # 2. BLINDING & DEPOSIT (Client Side -> Smart Contract)
    # --------------------------------------------------------------------------
    print("[2] Client Blinding the Token...")
    # Map the Ethereum Address to a point on the BN254 curve
    Y = hash_to_curve(spend_address_bytes)

    # Multiplicative blinding: B = r * Y
    B = multiply(Y, r)
    print(f"    Blinded Point B mapped to G1. Sent to Smart Contract.\n")

    # --------------------------------------------------------------------------
    # 3. BLIND SIGNING (Mint Server)
    # --------------------------------------------------------------------------
    print("[3] Mint blindly signing the point...")
    # The mint multiplies the blinded point by its secret key: S' = sk * B
    S_prime = multiply(B, sk_mint)
    print(f"    Blinded Signature S' generated. Broadcasted to Chain.\n")

    # --------------------------------------------------------------------------
    # 4. UNBLINDING (Client Side)
    # --------------------------------------------------------------------------
    print("[4] Client unblinding the signature...")
    # The client computes the modular inverse of r
    r_inv = pow(r, -1, curve_order)

    # S = S' * r^-1
    S = multiply(S_prime, r_inv)
    print(f"    Valid, unblinded eCash Token obtained: (SpendAddress, S)\n")

    # --------------------------------------------------------------------------
    # 5. REDEMPTION PROOF GENERATION (Client Side)
    # --------------------------------------------------------------------------
    print("[5] Generating Redemption Proof for Smart Contract...")
    destination_address = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7"

    # Create the anti-MEV payload
    payload_str = f"Pay to: {destination_address}"
    msg_hash = keccak(payload_str.encode("utf-8"))

    # Sign it with the Spend Private Key
    ecdsa_sig = spend_priv.sign_msg_hash(msg_hash)
    print(f"    Destination      : {destination_address}")
    print(f"    ECDSA Signature  : {ecdsa_sig.to_hex()}\n")

    # --------------------------------------------------------------------------
    # 6. SMART CONTRACT VERIFICATION (EVM Simulation)
    # --------------------------------------------------------------------------
    print("[6] EVM Verification (Redemption Transaction)...")

    # A. ecrecover the nullifier from the ECDSA signature
    recovered_pubkey = ecdsa_sig.recover_public_key_from_msg_hash(msg_hash)
    recovered_address = recovered_pubkey.to_address()
    print(f"    [Contract] ecrecover Address : {recovered_address}")
    assert recovered_address.lower() == spend_address_hex.lower(), (
        "ECDSA ecrecover failed!"
    )
    print("    ✅ MEV Protection Verified!")

    # B. Hash the recovered address back to the curve
    Y_recovered = hash_to_curve(bytes.fromhex(recovered_address[2:]))

    # C. Execute the BLS Pairing Check: e(S, G2) == e(Y, PK_mint)
    # Note: py_ecc pairing takes (G2, G1)
    left_side = pairing(G2, S)
    right_side = pairing(PK_mint, Y_recovered)

    if left_side == right_side:
        print("    ✅ BLS Pairing Verified! Mathematical proof is flawless.")
        print("\n🎉 TRANSACTION SUCCESS: 0.01 Sepolia ETH Transferred! 🎉")
    else:
        print("    ❌ BLS Pairing FAILED!")


if __name__ == "__main__":
    main()
