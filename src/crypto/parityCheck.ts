import { setMasterSeed, deriveTokenSecrets, hexToBytes } from './ghostClient';

// Valores del .env de Ivan — estos son la fuente de verdad
const MASTER_SEED_HEX =
  '2b8c5855536fdf6354d78377fc1810b8c850cea4fdecd12478f31dd0f04e6671';

const EXPECTED = {
  tokenIndex: 42,
  spendAddress: '0x9355eb29da61d3a94343bf76e6458b6032c8c2e6',
  r: BigInt(
    '9975352312114225588461889601612248069121371598217675252585165987882766246602'
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

  const rOk = secrets.r === EXPECTED.r;

  console.log(
    `  Spend Address: ${addressOk ? '✅' : '❌'} Got: ${secrets.spendAddress}`
  );
  console.log(`  Blinding r:    ${rOk ? '✅' : '❌'} Got: ${secrets.r}`);

  if (addressOk && rOk) {
    console.log('✅ PARITY CHECK PASSED — crypto ready to use');
    return true;
  } else {
    console.error('❌ PARITY CHECK FAILED — NO avanzar hasta resolver esto');
    return false;
  }
}
