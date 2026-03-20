import os
from dotenv import load_dotenv
from eth_keys import keys
from eth_utils import keccak
from py_ecc.bn128 import (
    G1, G2, multiply, curve_order, field_modulus, pairing, FQ
)

# Inject variables from the local .env file
load_dotenv()

# ==============================================================================
# CRYPTOGRAPHIC HELPERS & FORMATTING
# ==============================================================================
def hash_to_curve(message_bytes: bytes) -> tuple:
    """
    A 'try-and-increment' hash-to-curve mapping for BN254 G1.
    Finds a valid x coordinate where x^3 + 3 is a quadratic residue.
    """
    counter = 0
    while True:
        # Hash the payload + counter
        h = keccak(message_bytes + counter.to_bytes(4, 'big'))
        x = int.from_bytes(h, 'big') % field_modulus
        
        # BN254 equation: y^2 = x^3 + 3
        y_squared = (pow(x, 3, field_modulus) + 3) % field_modulus
        
        # Check if y_squared is a quadratic residue using Euler's criterion
        if pow(y_squared, (field_modulus - 1) // 2, field_modulus) == 1:
            # BN254 field_modulus = 3 mod 4, so y = sqrt(v) = v^((p+1)/4) mod p
            y = pow(y_squared, (field_modulus + 1) // 4, field_modulus)
            return (FQ(x), FQ(y))
        
        counter += 1

def print_g1(name: str, point: tuple):
    """Helper to print G1 points in hex for cross-language comparison."""
    # Convert scalar to hex, strip '0x' prefix
    x_hex = hex(point[0].n)[2:]
    y_hex = hex(point[1].n)[2:]
    print(f"    {name} (X) : {x_hex}")
    print(f"    {name} (Y) : {y_hex}")

def print_g2(name: str, point: tuple):
    """Helper to print G2 points in hex for cross-language comparison."""
    x_real = hex(point[0].coeffs[0].n)[2:]
    x_imag = hex(point[0].coeffs[1].n)[2:]
    y_real = hex(point[1].coeffs[0].n)[2:]
    y_imag = hex(point[1].coeffs[1].n)[2:]
    print(f"    {name} (X_real) : {x_real}")
    print(f"    {name} (X_imag) : {x_imag}")
    print(f"    {name} (Y_real) : {y_real}")
    print(f"    {name} (Y_imag) : {y_imag}")

# ==============================================================================
# MAIN LIFECYCLE TEST
# ==============================================================================
def main():
    print("👻 GHOST-TIP PROTOCOL: FULL LIFECYCLE TEST (.ENV ENABLED) 👻\n")

    # --------------------------------------------------------------------------
    # 0. MINT SETUP (Server Side)
    # --------------------------------------------------------------------------
    print("[0] Loading Mint Configuration from .env...")
    sk_mint_str = os.getenv("MINT_BLS_PRIVKEY_INT")
    if not sk_mint_str:
        raise ValueError("Missing MINT_BLS_PRIVKEY_INT in .env file. Run generator script first.")
    
    sk_mint = int(sk_mint_str)
    PK_mint = multiply(G2, sk_mint)
    print("    ✅ Mint Keys loaded securely.")
    print_g2("PK_mint", PK_mint)
    print("")

    # --------------------------------------------------------------------------
    # 1. DETERMINISTIC DERIVATION (Client Side)
    # --------------------------------------------------------------------------
    print("[1] Deriving Token Secrets (User's Wallet)...")
    master_seed_str = os.getenv("MASTER_SEED")
    if not master_seed_str:
         raise ValueError("Missing MASTER_SEED in .env file.")
    
    master_seed = master_seed_str.encode('utf-8')
    token_index = 42

    base_material = keccak(master_seed + token_index.to_bytes(4, 'big'))
    
    # A. The Spend Key (Identity & MEV Protection)
    spend_priv_bytes = keccak(b"spend" + base_material)
    spend_priv = keys.PrivateKey(spend_priv_bytes)
    spend_address_hex = spend_priv.public_key.to_address()
    spend_address_bytes = bytes.fromhex(spend_address_hex[2:])
    
    # B. The Blinding Factor (Scalar for BN254)
    r = int.from_bytes(keccak(b"blind" + base_material), 'big') % curve_order

    print(f"    Token Index   : {token_index}")
    print(f"    Spend Address : {spend_address_hex} (This is the Token Secret!)")
    print(f"    Blinding 'r'  : {r}\n")

    # --------------------------------------------------------------------------
    # 2. BLINDING & DEPOSIT (Client Side -> Smart Contract)
    # --------------------------------------------------------------------------
    print("[2] Client Blinding the Token...")
    Y = hash_to_curve(spend_address_bytes)
    B = multiply(Y, r)
    
    print_g1("Y (Hash-to-Curve)", Y)
    print_g1("B (Blinded Point)", B)
    print("    Blinded Point B mapped to G1. Sent to Smart Contract.\n")

    # --------------------------------------------------------------------------
    # 3. BLIND SIGNING (Mint Server)
    # --------------------------------------------------------------------------
    print("[3] Mint blindly signing the point...")
    S_prime = multiply(B, sk_mint)
    
    print_g1("S' (Blind Sig)", S_prime)
    print("    Blinded Signature S' generated. Broadcasted to Chain.\n")

    # --------------------------------------------------------------------------
    # 4. UNBLINDING (Client Side)
    # --------------------------------------------------------------------------
    print("[4] Client unblinding the signature...")
    r_inv = pow(r, -1, curve_order)
    S = multiply(S_prime, r_inv)
    
    print_g1("S (Unblinded Sig)", S)
    print("    Valid, unblinded eCash Token obtained: (SpendAddress, S)\n")

    # --------------------------------------------------------------------------
    # 5. REDEMPTION PROOF GENERATION (Client Side)
    # --------------------------------------------------------------------------
    print("[5] Generating Redemption Proof for Smart Contract...")
    destination_address = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7"
    
    payload_str = f"Pay to: {destination_address}"
    msg_hash = keccak(payload_str.encode('utf-8'))
    
    # Sign it with the Spend Private Key
    ecdsa_sig = spend_priv.sign_msg_hash(msg_hash)
    
    # Manually extract r and s and pad to 64 chars to match TypeScript compactHex
    r_hex = hex(ecdsa_sig.r)[2:].zfill(64)
    s_hex = hex(ecdsa_sig.s)[2:].zfill(64)
    compact_hex = r_hex + s_hex
    recovery_bit = ecdsa_sig.v
    
    print(f"    Destination      : {destination_address}")
    print(f"    ECDSA Signature  : 0x{compact_hex} (plus recovery bit: {recovery_bit})\n")

    # --------------------------------------------------------------------------
    # 6. SMART CONTRACT VERIFICATION (EVM Simulation)
    # --------------------------------------------------------------------------
    print("[6] EVM Verification (Redemption Transaction)...")
    
    recovered_pubkey = ecdsa_sig.recover_public_key_from_msg_hash(msg_hash)
    recovered_address = recovered_pubkey.to_address()
    
    print(f"    [Contract] Signature mathematically bound to: {recovered_address}")
    assert recovered_address.lower() == spend_address_hex.lower(), "ECDSA Verification failed!"
    print("    ✅ MEV Protection Verified!")

    Y_recovered = hash_to_curve(bytes.fromhex(recovered_address[2:]))

    # Execute the BLS Pairing Check: e(S, G2) == e(Y, PK_mint)
    # py_ecc pairing takes (G2, G1)
    left_side = pairing(G2, S)
    right_side = pairing(PK_mint, Y_recovered)
    
    if left_side == right_side:
        print("    ✅ BLS Pairing Verified! Mathematical proof is flawless.")
        print("\n🎉 TRANSACTION SUCCESS: 0.01 Sepolia ETH Transferred! 🎉")
    else:
        print("    ❌ BLS Pairing FAILED!")

if __name__ == "__main__":
    main()
