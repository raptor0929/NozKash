import os
from py_ecc.bn128 import curve_order, G2, multiply

def generate_keys_and_env():
    print("========================================")
    print("🔒 GHOST-TIP: SECRETS & .ENV GENERATOR")
    print("========================================\n")

    # ---------------------------------------------------------
    # 1. Master Seed for the Client Wallet
    # ---------------------------------------------------------
    # In a real app, this comes from a BIP-39 mnemonic, 
    # but we generate a secure random hex seed here for testing.
    master_seed = os.urandom(32).hex()

    # ---------------------------------------------------------
    # 2. Generate BN254 Mint BLS Keypair
    # ---------------------------------------------------------
    # Generate a random scalar within the curve's order
    sk_bytes = os.urandom(32)
    sk_int = int.from_bytes(sk_bytes, 'big') % curve_order
    
    # Calculate PK_mint = sk * G2
    pk_g2 = multiply(G2, sk_int)

    # Extract coordinates
    # py_ecc G2 points are tuples of FQ2 polynomials: ((x.real, x.imag), (y.real, y.imag))
    # Note: Solidity ecPairing expects: [x.imag, x.real, y.imag, y.real]
    x_real = pk_g2[0].coeffs[0].n
    x_imag = pk_g2[0].coeffs[1].n
    y_real = pk_g2[1].coeffs[0].n
    y_imag = pk_g2[1].coeffs[1].n

    # Format arrays for easy copying if needed elsewhere
    solidity_pk = f"[{x_imag}, {x_real}, {y_imag}, {y_real}]"
    ts_pk = f"['{hex(x_imag)}', '{hex(x_real)}', '{hex(y_imag)}', '{hex(y_real)}']"

    print("✅ Cryptographic material generated.")
    print("✍️ Writing to .env file...")

    # ---------------------------------------------------------
    # 3. Write securely to .env
    # ---------------------------------------------------------
    with open(".env", "w") as f:
        f.write("# =========================================\n")
        f.write("# GHOST-TIP LOCAL TESTING ENVIRONMENT\n")
        f.write("# =========================================\n\n")
        
        f.write("# 1. CLIENT WALLET CONFIG\n")
        f.write("# The deterministic seed used to recover all tokens and nullifiers\n")
        f.write(f"MASTER_SEED={master_seed}\n\n")
        
        f.write("# 2. MINT SERVER CONFIG (PYTHON)\n")
        f.write("# The scalar private key used to perform the blind signature (S' = sk * B)\n")
        f.write(f"MINT_BLS_PRIVKEY_INT={sk_int}\n\n")
        
        f.write("# 3. SMART CONTRACT VERIFICATION KEY (SOLIDITY COPY/PASTE)\n")
        f.write("# Hardcode this array into GhostVault.sol so ecPairing can verify the tokens\n")
        f.write(f"# PK_MINT_SOLIDITY={solidity_pk}\n")

    print("\n🎉 Success! .env file created in current directory.")
    print(f"Master Seed: {master_seed[:10]}... (saved to .env)")

if __name__ == "__main__":
    generate_keys_and_env()
