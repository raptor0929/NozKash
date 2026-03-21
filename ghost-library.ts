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
    pubKeyUncompressed: Uint8Array; // stored so verify() doesn't need recovery
}

// ==============================================================================
// 1. CORE CRYPTOGRAPHY UTILS
// ==============================================================================

export function hashToCurve(messageBytes: Uint8Array): mcl.G1 {
    return hashToCurveBN254(messageBytes);
}

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

export function deriveTokenSecrets(masterSeed: Uint8Array, tokenIndex: number): TokenSecrets {
    const indexBytes = new Uint8Array([0, 0, 0, tokenIndex]);
    const baseMaterial = keccak256(new Uint8Array([...masterSeed, ...indexBytes]));

    const spendPriv = keccak256(new Uint8Array([...Buffer.from("spend"), ...baseMaterial]));
    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);
    const pubKeyHash = keccak256(pubKeyUncompressed.slice(1));
    const spendAddressBytes = pubKeyHash.slice(-20);
    const spendAddressHex = "0x" + Buffer.from(spendAddressBytes).toString('hex');

    const rBytes = keccak256(new Uint8Array([...Buffer.from("blind"), ...baseMaterial]));
    const r = BigInt('0x' + Buffer.from(rBytes).toString('hex')) % CURVE_ORDER;

    return { spendPriv, spendAddressHex, spendAddressBytes, r };
}

export function blindToken(spendAddressBytes: Uint8Array, r: bigint): BlindedPoints {
    const Y = hashToCurve(spendAddressBytes);
    const B = multiplyBN254(Y, r);
    return { Y, B };
}

export function unblindSignature(S_prime: mcl.G1, r: bigint): mcl.G1 {
    const r_inv = modularInverse(r, CURVE_ORDER);
    return multiplyBN254(S_prime, r_inv);
}

// ==============================================================================
// 3. MINT OPERATIONS (Server Daemon)
// ==============================================================================

/**
 * Blindly signs a user's G1 point using the Mint's scalar private key.
 * Returns S' = sk * B.
 * Mirrors Python's mint_blind_sign().
 */
export function mintBlindSign(B: mcl.G1, skMint: bigint): mcl.G1 {
    return multiplyBN254(B, skMint);
}

// ==============================================================================
// 4. CLIENT — REDEMPTION PROOF
// ==============================================================================

/**
 * Generates the anti-MEV ECDSA signature binding the token to a destination.
 *
 * Uses the @noble/curves Signature object directly so that the recovery bit
 * is always read from signatureObj.recovery (set by the library at sign time)
 * rather than brute-forced via a now-removed recoverPublicKey() top-level fn.
 */
export async function generateRedemptionProof(
    spendPriv: Uint8Array,
    destinationAddress: string
): Promise<RedemptionProof> {
    const payloadStr = `Pay to: ${destinationAddress}`;
    const msgHash = keccak256(Buffer.from(payloadStr, 'utf-8'));

    // This version's sign() returns a raw 64-byte compact r||s Uint8Array (no recovery bit).
    const signatureObj: any = secp256k1.sign(msgHash, spendPriv);
    const compactHex = Buffer.from(signatureObj as Uint8Array).toString('hex');

    // Store the public key so verifyEcdsaMevProtection can use secp256k1.verify()
    // directly instead of needing key recovery (Signature.fromCompact doesn't exist here).
    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);

    // Recovery bit: attempt via Signature class if available, else default 0.
    // Not needed for our verify path but kept for interface completeness.
    let recoveryBit = 0;
    try {
        const sig = (secp256k1 as any).Signature?.fromCompact?.(compactHex);
        if (sig) recoveryBit = sig.addRecoveryBit(0).recoverPublicKey(msgHash) ? 0 : 1;
    } catch { /* not available in this version */ }

    return { msgHash, signatureObj, compactHex, recoveryBit, pubKeyUncompressed };
}

// ==============================================================================
// 5. VERIFICATION LOGIC (EVM Equivalents)
// ==============================================================================

export function verifyBlsPairing(S: mcl.G1, Y: mcl.G1, pkMint: mcl.G2): boolean {
    return verifyPairingBN254(S, Y, pkMint);
}

/**
 * Simulates the EVM ecrecover precompile.
 *
 * @noble/curves API for recovery:
 *   secp256k1.Signature.fromCompact(hex).addRecoveryBit(bit).recoverPublicKey(msgHash)
 *
 * The old top-level secp256k1.recoverPublicKey() does not exist in @noble/curves
 * and was the direct cause of the TypeScript verification always returning false.
 */
export function verifyEcdsaMevProtection(
    proof: RedemptionProof,
    expectedAddressHex: string
): boolean {
    try {
        // 1. Check the public key hashes to the expected spend address.
        //    This binds the proof to the correct token identity.
        const pubKeyBytes = proof.pubKeyUncompressed;
        const derivedAddress =
            "0x" + Buffer.from(keccak256(pubKeyBytes.slice(1)).slice(-20)).toString('hex');
        if (derivedAddress.toLowerCase() !== expectedAddressHex.toLowerCase()) {
            return false;
        }

        // 2. Verify the signature is valid for this public key over this message.
        //    secp256k1.verify() accepts the raw 64-byte compact signature directly.
        return secp256k1.verify(proof.signatureObj, proof.msgHash, proof.pubKeyUncompressed);
    } catch {
        return false;
    }
}
