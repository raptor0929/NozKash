import {
  deriveTokenSecrets as deriveTokenSecretsLib,
  getDepositId,
  getR,
  getSpendAddress,
  getSpendPriv,
} from './ghost-library'

let masterSeed: Uint8Array | null = null

export function setMasterSeed(seed: Uint8Array) {
  masterSeed = seed
}

export function getMasterSeed(): Uint8Array {
  if (!masterSeed) throw new Error('Master seed not initialized')
  return masterSeed
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '')
  return new Uint8Array(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type DerivedTokenSecrets = {
  spendPriv: Uint8Array
  spendAddress: string
  blindPriv: Uint8Array
  blindAddress: string
  r: bigint
}

/**
 * Flat shape for wallet UI / vault helpers; crypto from `ghost-library.ts`.
 */
export function deriveTokenSecretsFromSeed(
  masterSeed: Uint8Array,
  tokenIndex: number
): DerivedTokenSecrets {
  const s = deriveTokenSecretsLib(masterSeed, tokenIndex)
  return {
    spendPriv: getSpendPriv(s),
    spendAddress: getSpendAddress(s),
    blindPriv: s.blind.priv,
    blindAddress: getDepositId(s),
    r: getR(s),
  }
}

/** Uses global seed from `setMasterSeed`. */
export function deriveTokenSecrets(tokenIndex: number): DerivedTokenSecrets {
  return deriveTokenSecretsFromSeed(getMasterSeed(), tokenIndex)
}

export { bytesToHex }
