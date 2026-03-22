import { keccak256 } from 'ethereum-cryptography/keccak'

export const GHOST_MASTER_DERIVATION_MSG_VERSION = 'v1'

/**
 * Mensaje EIP-191 que el usuario firma con MetaMask.
 * Incluye cuenta y chain para atar el `masterSeed` derivado a ese contexto.
 */
export function buildGhostDerivationSignMessage(
  walletAddress: string,
  chainIdHex: string
): string {
  const id = Number.parseInt(chainIdHex, 16)
  const chainLabel = Number.isFinite(id) ? String(id) : chainIdHex
  return [
    'GhostTip — derivar secreto del vault (solo en este dispositivo)',
    '',
    `Versión: ${GHOST_MASTER_DERIVATION_MSG_VERSION}`,
    `Cuenta: ${walletAddress}`,
    `Chain ID: ${chainLabel}`,
    '',
    'No se envía ninguna transacción. La firma genera entropía local para deriveTokenSecrets.',
  ].join('\n')
}

function hexToBytesStrict(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '')
  if (h.length % 2 !== 0) throw new Error('Invalid hex length')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * `keccak256` de la firma cruda (65 bytes típicos ECDSA) → 32 bytes como `masterSeed`.
 */
export function masterSeedFromPersonalSignSignature(sigHex: string): Uint8Array {
  const bytes = hexToBytesStrict(sigHex)
  if (bytes.length < 64) {
    throw new Error('Firma demasiado corta')
  }
  return keccak256(bytes)
}
