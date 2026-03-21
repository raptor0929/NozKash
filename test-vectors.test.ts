import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import mcl from 'mcl-wasm';
import * as gl from './ghost-library.js';
import { initBN254 } from './bn254-crypto.js';

// Load the known-good test vectors
const vectors = JSON.parse(readFileSync('./vectors.json', 'utf-8'));

describe('👻 Ghost-Tip Cryptographic Vectors (TypeScript)', () => {

    beforeAll(async () => {
        await initBN254();
    });

    it('should derive the exact token secrets deterministically', () => {
        const masterSeedBytes = Buffer.from(vectors.MASTER_SEED, 'utf-8');
        const secrets = gl.deriveTokenSecrets(masterSeedBytes, vectors.TOKEN_INDEX);

        expect(secrets.spendAddressHex.toLowerCase()).toBe(vectors.SPEND_ADDRESS.toLowerCase());
        expect(secrets.r.toString()).toBe(vectors.BLINDING_R);
    });

    it('should blind the token exactly matching G1 vectors', () => {
        const masterSeedBytes = Buffer.from(vectors.MASTER_SEED, 'utf-8');
        const secrets = gl.deriveTokenSecrets(masterSeedBytes, vectors.TOKEN_INDEX);

        const { Y, B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);

        const yCoords = Y.getStr(16).split(' ');
        expect(yCoords[1]).toBe(vectors.Y_HASH_TO_CURVE.X);
        expect(yCoords[2]).toBe(vectors.Y_HASH_TO_CURVE.Y);

        const bCoords = B.getStr(16).split(' ');
        expect(bCoords[1]).toBe(vectors.B_BLINDED.X);
        expect(bCoords[2]).toBe(vectors.B_BLINDED.Y);
    });

    it('should generate the exact same blind signature S_prime', () => {
        const masterSeedBytes = Buffer.from(vectors.MASTER_SEED, 'utf-8');
        const secrets = gl.deriveTokenSecrets(masterSeedBytes, vectors.TOKEN_INDEX);
        const { B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);

        const skMint = BigInt(vectors.MINT_BLS_PRIVKEY_INT);
        const S_prime = gl.mintBlindSign(B, skMint);

        const sPrimeCoords = S_prime.getStr(16).split(' ');
        expect(sPrimeCoords[1]).toBe(vectors.S_PRIME.X);
        expect(sPrimeCoords[2]).toBe(vectors.S_PRIME.Y);
    });

    it('should unblind to the exact same final signature S', () => {
        const masterSeedBytes = Buffer.from(vectors.MASTER_SEED, 'utf-8');
        const secrets = gl.deriveTokenSecrets(masterSeedBytes, vectors.TOKEN_INDEX);
        const { B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);
        const skMint = BigInt(vectors.MINT_BLS_PRIVKEY_INT);
        const S_prime = gl.mintBlindSign(B, skMint);

        const S = gl.unblindSignature(S_prime, secrets.r);

        const sCoords = S.getStr(16).split(' ');
        expect(sCoords[1]).toBe(vectors.S_UNBLINDED.X);
        expect(sCoords[2]).toBe(vectors.S_UNBLINDED.Y);
    });

    it('should successfully verify the MEV protection payload', async () => {
        const masterSeedBytes = Buffer.from(vectors.MASTER_SEED, 'utf-8');
        const secrets = gl.deriveTokenSecrets(masterSeedBytes, vectors.TOKEN_INDEX);
        
        // Generate the strict standard proof
        const proof = await gl.generateRedemptionProof(secrets.spendPriv, "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7");
        
        // Pass the full proof object and the expected address
        const isValid = gl.verifyEcdsaMevProtection(proof, vectors.SPEND_ADDRESS);
        
        expect(isValid).toBe(true);
    });
});
