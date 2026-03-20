import 'dotenv/config'; // Injects the .env variables into process.env
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import mcl from 'mcl-wasm';
import { 
    initBN254, hashToCurveBN254, multiplyBN254, 
    modularInverse, verifyPairingBN254, CURVE_ORDER 
} from './bn254-crypto.js';

// Helper to neatly print mcl.js points
function printPoint(name: string, point: mcl.G1 | mcl.G2) {
    const coords = point.getStr(16).split(' ');
    // coords[0] is usually '1' (Z coordinate in projective, or just an indicator)
    console.log(`    ${name} (X) : ${coords[1]}`);
    if (coords.length > 2) {
        console.log(`    ${name} (Y) : ${coords[2]}`);
    }
}

async function main() {
    await initBN254();
    console.log("👻 TS CLIENT: FULL LIFECYCLE TEST (.ENV ENABLED) 👻\n");

    // --------------------------------------------------------------------------
    // 0. MOCK THE MINT (Loading from .env)
    // --------------------------------------------------------------------------
    console.log("[0] Loading Mint Configuration from .env...");
    if (!process.env.MINT_BLS_PRIVKEY_INT || !process.env.MASTER_SEED) {
        throw new Error("Missing variables in .env file. Run python generator script first.");
    }

    const MINT_BLS_PRIVKEY = BigInt(process.env.MINT_BLS_PRIVKEY_INT);
    
    // Natively map a string to G2 to get a valid, mathematically sound generator
    const generatorG2 = mcl.hashAndMapToG2("GhostTipG2Generator");
    
    const skFr = new mcl.Fr();
    skFr.setStr(MINT_BLS_PRIVKEY.toString(10), 10);
    
    // Calculate PK_mint = sk * G2
    const PK_mint = mcl.mul(generatorG2, skFr) as mcl.G2;
    console.log("    ✅ Mint Keys loaded securely.");
    printPoint("PK_mint", PK_mint);
    console.log("");

    // --------------------------------------------------------------------------
    // 1. DETERMINISTIC DERIVATION
    // --------------------------------------------------------------------------
    console.log("[1] Deriving Token Secrets (User's Wallet)...");
    const masterSeed = Buffer.from(process.env.MASTER_SEED, "utf-8");
    const tokenIndex = 42;

    const indexBytes = new Uint8Array([0, 0, 0, 42]); // 42 in 4-byte big-endian
    const baseMaterial = keccak256(new Uint8Array([...masterSeed, ...indexBytes]));

    // A. The Spend Key (Identity & MEV Protection)
    const spendPriv = keccak256(new Uint8Array([...Buffer.from("spend"), ...baseMaterial]));
    
    // Get uncompressed public key (65 bytes, starts with 04), take last 64, hash, take last 20
    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);
    const pubKeyHash = keccak256(pubKeyUncompressed.slice(1));
    const spendAddressBytes = pubKeyHash.slice(-20);
    const spendAddressHex = "0x" + Buffer.from(spendAddressBytes).toString('hex');

    // B. The Blinding Factor (Scalar for BN254)
    const rBytes = keccak256(new Uint8Array([...Buffer.from("blind"), ...baseMaterial]));
    const r = BigInt('0x' + Buffer.from(rBytes).toString('hex')) % CURVE_ORDER;

    console.log(`    Token Index   : ${tokenIndex}`);
    console.log(`    Spend Address : ${spendAddressHex} (This is the Token Secret!)`);
    console.log(`    Blinding 'r'  : ${r}\n`);

    // --------------------------------------------------------------------------
    // 2. BLINDING
    // --------------------------------------------------------------------------
    console.log("[2] Client Blinding the Token...");
    // Map the Ethereum Address to a point on the BN254 curve
    const Y = hashToCurveBN254(spendAddressBytes);
    
    // Multiplicative blinding: B = r * Y
    const B = multiplyBN254(Y, r);
    printPoint("Y (Hash-to-Curve)", Y);
    printPoint("B (Blinded Point)", B);
    console.log("    Blinded Point B mapped to G1. Sent to Smart Contract.\n");

    // --------------------------------------------------------------------------
    // 3. MOCK MINT SIGNING
    // --------------------------------------------------------------------------
    console.log("[3] Mint blindly signing the point...");
    // The mint multiplies the blinded point by its secret key: S' = sk * B
    const S_prime = multiplyBN254(B, MINT_BLS_PRIVKEY);
    printPoint("S' (Blind Sig)", S_prime);
    console.log("    Blinded Signature S' generated. Broadcasted to Chain.\n");

    // --------------------------------------------------------------------------
    // 4. UNBLINDING
    // --------------------------------------------------------------------------
    console.log("[4] Client unblinding the signature...");
    // The client computes the modular inverse of r
    const r_inv = modularInverse(r, CURVE_ORDER);
    
    // S = S' * r^-1
    const S = multiplyBN254(S_prime, r_inv);
    printPoint("S (Unblinded Sig)", S);
    console.log("    Valid, unblinded eCash Token obtained: (SpendAddress, S)\n");

    // --------------------------------------------------------------------------
    // 5. REDEMPTION PROOF GENERATION (Anti-MEV)
    // --------------------------------------------------------------------------
    console.log("[5] Generating Redemption Proof for Smart Contract...");
    const destinationAddress = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";
    
    // Create the anti-MEV payload
    const payloadStr = `Pay to: ${destinationAddress}`;
    const msgHash = keccak256(Buffer.from(payloadStr, 'utf-8'));
    
    // AWAIT the signature! (Unwraps the Promise in older/async library versions)
    const ecdsaSig: any = await secp256k1.sign(msgHash, spendPriv);
    
    // BULLETPROOF HEX CONVERSION
    let compactHex = "";
    let recoveryBit = 0;
    
    if (ecdsaSig instanceof Uint8Array) {
        compactHex = Buffer.from(ecdsaSig).toString('hex');
    } else if (ecdsaSig.r !== undefined && ecdsaSig.s !== undefined) {
        const rHex = ecdsaSig.r.toString(16).padStart(64, '0');
        const sHex = ecdsaSig.s.toString(16).padStart(64, '0');
        compactHex = rHex + sHex;
        recoveryBit = ecdsaSig.recovery || 0;
    }
    
    console.log(`    Destination      : ${destinationAddress}`);
    console.log(`    ECDSA Signature  : 0x${compactHex} (plus recovery bit: ${recoveryBit})\n`);


    // --------------------------------------------------------------------------
    // 6. VERIFICATION (EVM Simulation)
    // --------------------------------------------------------------------------
    console.log("[6] EVM Verification (Redemption Transaction)...");
    
    // A. Verify ECDSA Signature (Anti-MEV)
    // We reuse the pubKeyUncompressed we already derived in Step 1!
    const isValidEcdsa = secp256k1.verify(ecdsaSig, msgHash, pubKeyUncompressed);

    console.log(`    [Contract] Signature mathematically bound to: ${spendAddressHex}`);
    if (!isValidEcdsa) {
        throw new Error("ECDSA Verification failed!");
    }
    console.log("    ✅ MEV Protection Verified!");

    // B. Simulate the BLS Pairing Check: e(S, G2) == e(Y, PK_mint)
    const isValidBls = verifyPairingBN254(S, Y, PK_mint);
    
    if (isValidBls) {
        console.log("    ✅ BLS Pairing Verified! Mathematical proof is flawless.");
        console.log("\n🎉 TRANSACTION SUCCESS: TypeScript bridge is fully operational! 🎉");
    } else {
        console.log("    ❌ BLS Pairing FAILED!");
    }
}

main().catch(console.error);
