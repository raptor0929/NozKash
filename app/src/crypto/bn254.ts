/** Reexporta la implementación en `bn254-crypto.ts`. */
export {
  FIELD_MODULUS,
  CURVE_ORDER,
  initBN254,
  modularInverse,
  hashToCurveBN254,
  multiplyBN254,
  verifyPairingBN254,
  formatG1ForSolidity,
  getG2Generator,
  padHex64,
} from './bn254-crypto'
