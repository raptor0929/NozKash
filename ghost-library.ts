import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import mcl from 'mcl-wasm';
import {
    hashToCurveBN254, multiplyBN254,
    modularInverse, verifyPairingBN254, CURVE_ORDER
} from './bn254-crypto.js';

// ==============================================================================
// ERROR HIERARCHY
//
// All errors thrown by this library inherit from GhostError so callers can
// catch the whole family with a single `catch (e) { if (e instanceof GhostError) }`
// while still discriminating by subclass when needed.
// ==============================================================================

export class GhostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class DerivationError extends GhostError {}

export class VerificationError extends GhostError {}

export class RecoveryBitError extends VerificationError {
    constructor(message = 'Could not determine a valid recovery bit for the ECDSA signature') {
        super(message);
    }
}

// ==============================================================================
// INTERFACES
// ==============================================================================

export interface TokenSecrets {
    spendPriv:          Uint8Array;
    spendAddressHex:    string;
    spendAddressBytes:  Uint8Array;
    r:                  bigint;
}

export interface BlindedPoints {
    Y: mcl.G1;
    B: mcl.G1;
}

export interface RedemptionProof {
    msgHash:            Uint8Array;
    signatureObj:       Uint8Array;     // Raw 64-byte compact r||s
    compactHex:         string;         // 128-char hex of signatureObj
    recoveryBit:        0 | 1;          // Guaranteed valid — never a silent default
    pubKeyUncompressed: Uint8Array;     // 65-byte uncompressed secp256k1 pubkey
}

// ==============================================================================
// 1. CORE CRYPTOGRAPHY UTILS
// ==============================================================================

export function hashToCurve(messageBytes: Uint8Array): mcl.G1 {
    return hashToCurveBN254(messageBytes);
}

export function generateMintKeypair(): { skMint: bigint; pkMint: mcl.G2 } {
    const skBytes = secp256k1.utils.randomPrivateKey();
    const skMint = BigInt('0x' + Buffer.from(skBytes).toString('hex')) % CURVE_ORDER;

    const generatorG2 = mcl.hashAndMapToG2('GhostTipG2Generator');
    const skFr = new mcl.Fr();
    skFr.setStr(skMint.toString(10), 10);

    const pkMint = mcl.mul(generatorG2, skFr) as mcl.G2;
    return { skMint, pkMint };
}

// ==============================================================================
// 2. CLIENT OPERATIONS (User Wallet)
// ==============================================================================

export function deriveTokenSecrets(masterSeed: Uint8Array, tokenIndex: number): TokenSecrets {
    if (tokenIndex < 0 || tokenIndex > 0xFFFFFFFF || !Number.isInteger(tokenIndex)) {
        throw new DerivationError(
            `tokenIndex must be a non-negative 32-bit integer, got ${tokenIndex}`
        );
    }

    // DataView ensures correct 32-bit big-endian encoding for all token indices.
    // Uint8Array([0, 0, 0, tokenIndex]) silently truncates indices >= 256 (modulo-wraps),
    // breaking parity with Python's token_index.to_bytes(4, 'big') above that threshold.
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, tokenIndex, false); // false = big-endian
    const indexBytes = new Uint8Array(buffer);
    const baseMaterial = keccak256(new Uint8Array([...masterSeed, ...indexBytes]));

    const spendPriv = keccak256(new Uint8Array([...Buffer.from('spend'), ...baseMaterial]));
    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);
    const pubKeyHash = keccak256(pubKeyUncompressed.slice(1));
    const spendAddressBytes = pubKeyHash.slice(-20);
    const spendAddressHex = '0x' + Buffer.from(spendAddressBytes).toString('hex');

    const rBytes = keccak256(new Uint8Array([...Buffer.from('blind'), ...baseMaterial]));
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
 * Returns S' = sk * B. Mirrors Python's mint_blind_sign().
 */
export function mintBlindSign(B: mcl.G1, skMint: bigint): mcl.G1 {
    return multiplyBN254(B, skMint);
}

// ==============================================================================
// 4. CLIENT — REDEMPTION PROOF
// ==============================================================================

/**
 * Derives the Ethereum address from an uncompressed public key.
 * Mirrors the EVM address derivation: keccak256(pubKey[1:])[12:]
 */
function pubKeyToAddress(pubKeyUncompressed: Uint8Array): string {
    return '0x' + Buffer.from(keccak256(pubKeyUncompressed.slice(1)).slice(-20)).toString('hex');
}

/**
 * Derives the recovery bit by trial: tries bit 0 and bit 1, returns whichever
 * reproduces the expected Ethereum address via ecrecover simulation.
 *
 * This is the only reliable approach when the sign() implementation doesn't
 * expose a recovery bit — and is used as a fallback even when it does, to
 * guarantee the bit is correct rather than trusting a library property.
 *
 * Throws RecoveryBitError if neither bit recovers the correct address, which
 * indicates a broken sign() implementation or corrupted signature bytes.
 */
function deriveRecoveryBit(
    msgHash: Uint8Array,
    compactHex: string,
    expectedAddress: string,
): 0 | 1 {
    const sigBytes = Buffer.from(compactHex, 'hex');

    for (const bit of [0, 1] as const) {
        try {
            // secp256k1.Signature.fromCompact + addRecoveryBit is the @noble/curves API.
            // If unavailable (older version), the catch block handles it.
            const recovered = (secp256k1 as any).Signature
                .fromCompact(sigBytes)
                .addRecoveryBit(bit)
                .recoverPublicKey(msgHash);
            const pubBytes: Uint8Array = recovered.toRawBytes(false);
            if (pubKeyToAddress(pubBytes).toLowerCase() === expectedAddress.toLowerCase()) {
                return bit;
            }
        } catch {
            // Library doesn't support fromCompact — try legacy recoverPublicKey
            try {
                const pt = (secp256k1 as any).recoverPublicKey(msgHash, sigBytes, bit, false);
                const pubBytes: Uint8Array =
                    typeof pt?.toRawBytes === 'function' ? pt.toRawBytes(false) : pt;
                if (pubKeyToAddress(pubBytes).toLowerCase() === expectedAddress.toLowerCase()) {
                    return bit;
                }
            } catch { /* try next bit */ }
        }
    }

    throw new RecoveryBitError();
}

/**
 * Generates the anti-MEV ECDSA signature binding the token to a destination.
 *
 * The recovery bit is ALWAYS mathematically derived by trial — never read
 * from a library property that may not be present. This guarantees the
 * recovery bit in the returned proof will produce the correct address when
 * passed to the EVM ecrecover precompile.
 *
 * Throws RecoveryBitError if a valid recovery bit cannot be derived
 * (indicates a broken sign() implementation — should never happen in practice).
 */
export async function generateRedemptionProof(
    spendPriv: Uint8Array,
    destinationAddress: string,
): Promise<RedemptionProof> {
    const payloadStr = `Pay to: ${destinationAddress}`;
    const msgHash = keccak256(Buffer.from(payloadStr, 'utf-8'));

    // sign() in this version of @noble/curves returns a raw 64-byte Uint8Array.
    // We use `any` because the type declarations vary across minor versions.
    const rawSig: any = secp256k1.sign(msgHash, spendPriv);

    // Normalise to a 64-byte Uint8Array regardless of library version
    let signatureObj: Uint8Array;
    if (rawSig instanceof Uint8Array) {
        signatureObj = rawSig.slice(0, 64); // strip any appended recovery byte
    } else {
        // Signature object with .r and .s bigint properties
        const rHex = (rawSig.r as bigint).toString(16).padStart(64, '0');
        const sHex = (rawSig.s as bigint).toString(16).padStart(64, '0');
        signatureObj = Buffer.from(rHex + sHex, 'hex');
    }
    const compactHex = Buffer.from(signatureObj).toString('hex');

    const pubKeyUncompressed = secp256k1.getPublicKey(spendPriv, false);
    const spendAddress = pubKeyToAddress(pubKeyUncompressed);

    // Always derive the bit mathematically — never trust a property that may silently
    // default to 0. A wrong recovery bit causes 50% of on-chain redemptions to revert.
    const recoveryBit = deriveRecoveryBit(msgHash, compactHex, spendAddress);

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
 * Derives the signer address from (msgHash, compactHex, recoveryBit) using
 * the same key-recovery logic as Solidity's ecrecover. Does NOT use the stored
 * pubKeyUncompressed — that would bypass recovery bit validation and hide
 * incorrect bits that would cause on-chain redemptions to revert.
 *
 * Returns false for invalid signatures. Throws VerificationError only for
 * structurally invalid inputs (wrong hex length) that indicate a programming
 * error rather than a failed verification.
 */
export function verifyEcdsaMevProtection(
    proof: RedemptionProof,
    expectedAddressHex: string,
): boolean {
    if (proof.compactHex.length !== 128) {
        throw new VerificationError(
            `compactHex must be 128 hex chars (64 bytes), got ${proof.compactHex.length}`
        );
    }

    try {
        // Attempt 1: Modern @noble/curves Signature.fromCompact API
        const sig = (secp256k1 as any).Signature
            .fromCompact(proof.compactHex)
            .addRecoveryBit(proof.recoveryBit);
        const recovered = sig.recoverPublicKey(proof.msgHash);
        const pubBytes: Uint8Array = recovered.toRawBytes(false);
        return pubKeyToAddress(pubBytes).toLowerCase() === expectedAddressHex.toLowerCase();
    } catch {
        // Attempt 2: Legacy recoverPublicKey fallback
        try {
            const sigBytes = Buffer.from(proof.compactHex, 'hex');
            const pt = (secp256k1 as any).recoverPublicKey(
                proof.msgHash, sigBytes, proof.recoveryBit, false
            );
            const pubBytes: Uint8Array =
                typeof pt?.toRawBytes === 'function' ? pt.toRawBytes(false) : pt;
            return pubKeyToAddress(pubBytes).toLowerCase() === expectedAddressHex.toLowerCase();
        } catch {
            return false;
        }
    }
}
