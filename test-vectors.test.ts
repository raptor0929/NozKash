import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import mcl from 'mcl-wasm';
import * as gl from './ghost-library.js';
import { initBN254, verifyPairingBN254 } from './bn254-crypto.js';

// ==============================================================================
// VECTOR DISCOVERY
// Loads all *.json files from test_vectors/<keypair_dir>/token_<index>.json.
// Falls back to the legacy vectors.json if the directory doesn't exist yet,
// so the suite keeps passing before generate_vectors.py has been run.
// ==============================================================================

interface VectorFile {
    id: string;
    v: Record<string, any>;
}

function loadAllVectors(): VectorFile[] {
    const vectorsDir = resolve('./test_vectors');

    if (existsSync(vectorsDir)) {
        const results: VectorFile[] = [];
        for (const keypairDir of readdirSync(vectorsDir, { withFileTypes: true })) {
            if (!keypairDir.isDirectory()) continue;
            const keypairPath = join(vectorsDir, keypairDir.name);
            for (const file of readdirSync(keypairPath)) {
                if (!file.endsWith('.json')) continue;
                const id = `${keypairDir.name}/${file.replace('.json', '')}`;
                const v = JSON.parse(readFileSync(join(keypairPath, file), 'utf-8'));
                results.push({ id, v });
            }
        }
        if (results.length > 0) return results;
    }

    // Fallback: legacy single vectors.json
    const legacy = resolve('./vectors.json');
    if (existsSync(legacy)) {
        return [{ id: 'legacy/vectors', v: JSON.parse(readFileSync(legacy, 'utf-8')) }];
    }

    return [];
}

const ALL_VECTORS = loadAllVectors();

// ==============================================================================
// PARAMETRIZED TESTS
// ==============================================================================

beforeAll(async () => {
    await initBN254();
});

describe.each(ALL_VECTORS.map(({ id, v }) => ({ id, v })))(
    '👻 Ghost-Tip Vectors [$id]',
    ({ v }) => {

        it('should derive token secrets deterministically', () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);

            expect(secrets.spendAddressHex.toLowerCase()).toBe(v.SPEND_ADDRESS.toLowerCase());
            expect(secrets.r.toString()).toBe(v.BLINDING_R);
        });

        it('should blind the token matching G1 vectors', () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);
            const { Y, B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);

            const yCoords = Y.getStr(16).split(' ');
            expect(yCoords[1]).toBe(v.Y_HASH_TO_CURVE.X);
            expect(yCoords[2]).toBe(v.Y_HASH_TO_CURVE.Y);

            const bCoords = B.getStr(16).split(' ');
            expect(bCoords[1]).toBe(v.B_BLINDED.X);
            expect(bCoords[2]).toBe(v.B_BLINDED.Y);
        });

        it('should generate the exact blind signature S_prime', () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);
            const { B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);
            const skMint = BigInt(v.MINT_BLS_PRIVKEY_INT);

            const S_prime = gl.mintBlindSign(B, skMint);

            const coords = S_prime.getStr(16).split(' ');
            expect(coords[1]).toBe(v.S_PRIME.X);
            expect(coords[2]).toBe(v.S_PRIME.Y);
        });

        it('should unblind to the exact final signature S', () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);
            const { B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);
            const skMint = BigInt(v.MINT_BLS_PRIVKEY_INT);
            const S_prime = gl.mintBlindSign(B, skMint);

            const S = gl.unblindSignature(S_prime, secrets.r);

            const coords = S.getStr(16).split(' ');
            expect(coords[1]).toBe(v.S_UNBLINDED.X);
            expect(coords[2]).toBe(v.S_UNBLINDED.Y);
        });

        it('should verify the MEV protection payload', async () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);
            const proof = await gl.generateRedemptionProof(
                secrets.spendPriv,
                '0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7',
            );

            expect(gl.verifyEcdsaMevProtection(proof, v.SPEND_ADDRESS)).toBe(true);
        });

        it('should satisfy the BLS pairing e(S, G2) == e(Y, PK_mint)', () => {
            const masterSeedBytes = Buffer.from(v.MASTER_SEED, 'utf-8');
            const secrets = gl.deriveTokenSecrets(masterSeedBytes, v.TOKEN_INDEX);
            const { Y, B } = gl.blindToken(secrets.spendAddressBytes, secrets.r);
            const skMint = BigInt(v.MINT_BLS_PRIVKEY_INT);
            const S_prime = gl.mintBlindSign(B, skMint);
            const S = gl.unblindSignature(S_prime, secrets.r);

            // Reconstruct PK_mint from the scalar so the test is self-contained
            const generatorG2 = mcl.hashAndMapToG2('GhostTipG2Generator');
            const skFr = new mcl.Fr();
            skFr.setStr(skMint.toString(10), 10);
            const pkMint = mcl.mul(generatorG2, skFr) as mcl.G2;

            expect(verifyPairingBN254(S, Y, pkMint)).toBe(true);
        });
    }
);
