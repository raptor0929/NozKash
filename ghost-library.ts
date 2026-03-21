import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import mcl from 'mcl-wasm';
import { 
    hashToCurveBN254, multiplyBN254, 
    modularInverse, verifyPairingBN254, CURVE_ORDER 
} from './bn254-crypto.js';

// ==============================================================================
// INTERFACES
// ==============================================================================

export interface TokenSecrets {
    spendPriv: Uint8Array;
    spendAddressHex: string;
    spendAddressBytes: Uint8Array;
    r: bigint;
}

export interface BlindedPoints {
    Y: mcl.G1;
    B: mcl.G1;
}

export interface RedemptionProof {
    msgHash: Uint8Array;
    signatureObj: any;
    compactHex: string;
    recoveryBit: number;
}

// ==============================================================================
// 1. CORE CRYPTOGRAPHY UTILS
// ==============================================================================

/**
 * A 'try-and-increment' hash-to-curve mapping for BN254 G1.
 */
export function hashToCurve(messageBytes: Uint8Array): mcl.G1 {
    return hashToCurveBN254(messageBytes);
}

/**
 * Generates a random BLS scalar and its corresponding G2 Public Key.
 */
export function generateMintKeypair(): { skMint: bigint, pkMint: mcl.G2 } {
    const skBytes = secp256k1.utils.randomPrivateKey();
    const skMint = BigInt('0x' + Buffer.from(skBytes).toString('hex')) % CURVE_ORDER;
    
    const generatorG2 = mcl.hashAndMapToG2("GhostTipG2Generator");
    const skFr = new mcl.Fr();
    skFr.setStr(skMint.toString(10), 10);
    
    const pkMint = mcl.mul(generatorG2, skFr) as mcl.G2;
    return { skMint, pkMint };
}

// ==============================================================================
// 2. CLIENT OPERATIONS (User Wallet)
// ==============================================================================

/**
 * Deterministically derives the ECDSA identity and the BLS blinding factor.
 */
export function deriveTokenSecrets(masterSeed: Uint8Array, tokenIndex: number): TokenSecrets {
    const indexBytes = new Uint8Array([0, 0, 0, tokenIndex]); // Assumes index fits in 1 byte for this mock
    const baseMaterial = keccak256(new Uint8Array([...masterSeed, ...indexBytes]));

    // A. Spend Key (Identity)
    const spendPriv = keccak256(new Uint8Array([...Buffer.from("spend"), ...baseMaterial]));
    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);
    const pubKeyHash = keccak256(pubKeyUncompressed.slice(1));
    const spendAddressBytes = pubKeyHash.slice(-20);
    const spendAddressHex = "0x" + Buffer.from(spendAddressBytes).toString('hex');

    // B. Blinding Factor
    const rBytes = keccak256(new Uint8Array([...Buffer.from("blind"), ...baseMaterial]));
    const r = BigInt('0x' + Buffer.from(rBytes).toString('hex')) % CURVE_ORDER;

    return { spendPriv, spendAddressHex, spendAddressBytes, r };
}

/**
 * Maps the token secret to G1 and applies the multiplicative blinding factor.
 */
export function blindToken(spendAddressBytes: Uint8Array, r: bigint): BlindedPoints {
    const Y = hashToCurve(spendAddressBytes);
    const B = multiplyBN254(Y, r);
    return { Y, B };
}

/**
 * Removes the blinding factor from the Mint's signature.
 */
export function unblindSignature(S_prime: mcl.G1, r: bigint): mcl.G1 {
    const r_inv = modularInverse(r, CURVE_ORDER);
    const S = multiplyBN254(S_prime, r_inv);
    return S;
}



// ==============================================================================
// 3. MINT OPERATIONS (Server Daemon)
// ==============================================================================

/**
 * Blindly signs a user's point on G1 using the Mint's scalar private key.
 */
export function mintBlindSign(B: mcl.G1, skMint: bigint): mcl.G1 {
    return multiplyBN254(B, skMint);
}

// ==============================================================================
// 4. VERIFICATION LOGIC (EVM Equivalents)
// ==============================================================================

/**
 * Verifies the ECDSA signature mathematically (simulating ecrecover).
 */
export function verifyEcdsaMevProtection(msgHash: Uint8Array, signatureObj: any, expectedAddressHex: string): boolean {
    try {
        // Recover the uncompressed public key from the signature and hash
        let recoveredPubKey;
        if (typeof signatureObj.recoverPublicKey === 'function') {
            recoveredPubKey = signatureObj.recoverPublicKey(msgHash);
        } else {
            recoveredPubKey = (secp256k1 as any).recoverPublicKey(msgHash, signatureObj, signatureObj.recovery);
        }

        const pubKeyBytes = typeof recoveredPubKey.toRawBytes === 'function' 
            ? recoveredPubKey.toRawBytes(false) 
            : recoveredPubKey;

        // Hash and extract last 20 bytes for the address
        const recoveredHash = keccak256(pubKeyBytes.slice(1));
        const recoveredAddressHex = "0x" + Buffer.from(recoveredHash.slice(-20)).toString('hex');
        
        return recoveredAddressHex.toLowerCase() === expectedAddressHex.toLowerCase();
    } catch (e) {
        return false;
    }
}

/**
 * Simulates the EVM 0x08 ecPairing precompile.
 */
export function verifyBlsPairing(S: mcl.G1, Y: mcl.G1, pkMint: mcl.G2): boolean {
    return verifyPairingBN254(S, Y, pkMint);
}
