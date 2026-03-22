import { setMasterSeed, deriveTokenSecrets, hexToBytes } from './ghostClient';

// Valores del .env de Ivan — estos son la fuente de verdad
const MASTER_SEED_HEX =
  '2b8c5855536fdf6354d78377fc1810b8c850cea4fdecd12478f31dd0f04e6671';

/** Matches `deriveTokenSecretsFromSeed` (4-byte BE index + GhostVault key schedule). */
const EXPECTED = {
  tokenIndex: 0,
  spendAddress: '0x2d2963a84058ca165d1226fe2142c25c4076866c',
  blindAddress: '0xcf95a5c7bde6d3d21fe675c63510d5ea807f6293',
  r: BigInt(
    '4438821886547857734666273869716575274965072606010662594780411669229936024370'
  ),
};

export function runParityCheck(): boolean {
  console.log('🔍 Ejecutando Parity Check contra valores de Ivan...');

  const seedBytes = hexToBytes(MASTER_SEED_HEX);
  setMasterSeed(seedBytes);

  const secrets = deriveTokenSecrets(EXPECTED.tokenIndex);

  const addressOk =
    secrets.spendAddress.toLowerCase() ===
    EXPECTED.spendAddress.toLowerCase();

  const blindOk =
    secrets.blindAddress.toLowerCase() ===
    EXPECTED.blindAddress.toLowerCase();

  const rOk = secrets.r === EXPECTED.r;

  console.log(
    `  Spend Address: ${addressOk ? '✅' : '❌'} Got: ${secrets.spendAddress}`
  );
  console.log(
    `  Blind (depositId): ${blindOk ? '✅' : '❌'} Got: ${secrets.blindAddress}`
  );
  console.log(`  Blinding r:    ${rOk ? '✅' : '❌'} Got: ${secrets.r}`);

  if (addressOk && blindOk && rOk) {
    console.log('✅ PARITY CHECK PASSED — crypto ready to use');
    return true;
  } else {
    console.error('❌ PARITY CHECK FAILED — NO avanzar hasta resolver esto');
    return false;
  }
}
