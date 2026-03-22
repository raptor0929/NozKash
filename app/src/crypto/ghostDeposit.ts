import { keccak256 } from 'ethereum-cryptography/keccak'
import { initBN254, formatG1ForSolidity } from './bn254'
import {
  blindToken,
  deriveTokenSecrets,
  getDepositId,
  getR,
  getSpendAddressBytes,
  type TokenSecrets,
} from './ghost-library'

let mclInit: Promise<void> | null = null

export async function ensureGhostCrypto(): Promise<void> {
  if (!mclInit) mclInit = initBN254()
  await mclInit
}

function u256be(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let x = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

function hex0x(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Igual que `deriveTokenSecrets`: índice en 4 bytes big-endian. */
function tokenIndexU32BE(tokenIndex: number): Uint8Array {
  const buf = new ArrayBuffer(4)
  new DataView(buf).setUint32(0, tokenIndex, false)
  return new Uint8Array(buf)
}

export function evmSelector4(signature: string): `0x${string}` {
  const h = keccak256(new TextEncoder().encode(signature)).subarray(0, 4)
  return hex0x(h) as `0x${string}`
}

/** Misma firma que `GhostVault.deposit` en Solidity (probada con Python). */
const DEPOSIT_ABI_SIG = 'deposit(address,uint256[2])' as const
const DEPOSIT_SELECTOR_BYTES = keccak256(
  new TextEncoder().encode(DEPOSIT_ABI_SIG)
).subarray(0, 4)

/** Primeros 4 bytes del calldata de `deposit` — para comprobar que coincide con el contrato. */
export const GHOST_VAULT_DEPOSIT_SELECTOR_HEX = hex0x(
  DEPOSIT_SELECTOR_BYTES
) as `0x${string}`

/**
 * ABI `deposit(address,uint256[2])`: palabra 0 = `depositId` (address en 32 bytes),
 * palabras 1–2 = `blindedPointB` (uint256 BE).
 */
export function encodeGhostVaultDepositCalldata(
  depositId: string,
  bx: bigint,
  by: bigint
): `0x${string}` {
  const wx = u256be(bx)
  const wy = u256be(by)
  const addrHex = depositId.replace(/^0x/i, '')
  const addrBytes = new Uint8Array(20)
  for (let i = 0; i < 20; i++) {
    addrBytes[i] = Number.parseInt(addrHex.slice(i * 2, i * 2 + 2), 16)
  }
  const wordAddr = new Uint8Array(32)
  wordAddr.set(addrBytes, 12)

  const body = new Uint8Array(96)
  body.set(wordAddr, 0)
  body.set(wx, 32)
  body.set(wy, 64)

  const out = new Uint8Array(4 + 96)
  out.set(DEPOSIT_SELECTOR_BYTES, 0)
  out.set(body, 4)
  return (
    '0x' +
    Array.from(out)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  ) as `0x${string}`
}

/** Decodifica el cuerpo ABI de `deposit(address,uint256[2])` (sin el selector). */
export function parseGhostVaultDepositCalldataArgs(data: `0x${string}`): {
  blindedPointB: [string, string]
  depositId: string
} {
  const h = data.replace(/^0x/i, '')
  if (h.length < 8 + 192) {
    throw new Error('GhostVault deposit calldata too short')
  }
  const body = h.slice(8)
  const word0 = body.slice(0, 64)
  const depositId = ('0x' + word0.slice(24)).toLowerCase()
  const bx = BigInt('0x' + body.slice(64, 128)).toString(10)
  const by = BigInt('0x' + body.slice(128, 192)).toString(10)
  return { blindedPointB: [bx, by], depositId }
}

/** `depositPending(address)` — lectura view para depurar “ya hay depósito con este depositId”. */
export function encodeDepositPendingCalldata(depositId: string): `0x${string}` {
  const sel = keccak256(
    new TextEncoder().encode('depositPending(address)')
  ).subarray(0, 4)
  const h = depositId.replace(/^0x/i, '').toLowerCase()
  if (h.length !== 40) {
    throw new Error(`encodeDepositPendingCalldata: invalid address ${depositId}`)
  }
  const word = `${'0'.repeat(24)}${h}`
  const selHex = Array.from(sel)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return (`0x${selHex}${word}`) as `0x${string}`
}

/**
 * `GhostVault.deposit(depositId, blindedPointB)` — payload criptográfico (orden Solidity).
 *
 * - `depositId`: dirección de **`secrets.blind`** (mismo `getDepositId`).
 * - `blindedPointB`: coordenadas de **`B`** donde
 *   `blindToken(spendAddressBytes, r)` con
 *   `spendAddressBytes` = dirección de **`secrets.spend`** (20 bytes),
 *   `r` = escalar BN254 derivado del material privado de **`secrets.blind`** (`getR`).
 */
async function assembleGhostVaultDeposit(secrets: TokenSecrets): Promise<{
  depositId: string
  data: `0x${string}`
  r: bigint
  bxDec: string
  byDec: string
}> {
  await ensureGhostCrypto()
  const depositId = getDepositId(secrets)
  const r = getR(secrets)
  if (r === 0n) {
    throw new Error('Invalid blinding factor (r = 0); retry with another seed')
  }
  const { B } = blindToken(getSpendAddressBytes(secrets), r)
  const [xs, ys] = formatG1ForSolidity(B)
  const data = encodeGhostVaultDepositCalldata(depositId, BigInt(xs), BigInt(ys))
  if (data.length < 10) {
    throw new Error('encodeGhostVaultDepositCalldata produced empty selector')
  }
  return { depositId, data, r, bxDec: xs, byDec: ys }
}

export async function buildGhostVaultDepositFromSecrets(
  secrets: TokenSecrets
): Promise<{ depositId: string; data: `0x${string}` }> {
  const { depositId, data } = await assembleGhostVaultDeposit(secrets)
  return { depositId, data }
}

/**
 * Igual que {@link buildGhostVaultDepositFromSecrets}, con
 * `secrets = deriveTokenSecrets(masterSeed, tokenIndex)`.
 * `masterSeed` debe ser **32 bytes** (p. ej. clave privada EVM en bruto).
 */
export async function buildGhostVaultDepositCalldata(
  masterSeed: Uint8Array,
  tokenIndex: number
): Promise<{ depositId: string; data: `0x${string}` }> {
  const secrets = deriveTokenSecrets(masterSeed, tokenIndex)
  const indexBe = tokenIndexU32BE(tokenIndex)
  const baseMaterial = keccak256(
    new Uint8Array([...masterSeed, ...indexBe])
  )

  console.log('[GhostVault deposit debug] derivation inputs + keypairs', {
    tokenIndex,
    masterSeedHex: hex0x(masterSeed),
    tokenIndexU32BE_Hex: hex0x(indexBe),
    baseMaterialHex: hex0x(baseMaterial),
    spend: {
      privHex: hex0x(secrets.spend.priv),
      pubHex: secrets.spend.pubHex,
      address: secrets.spend.address,
      addressBytesHex: hex0x(secrets.spend.addressBytes),
    },
    blind: {
      privHex: hex0x(secrets.blind.priv),
      pubHex: secrets.blind.pubHex,
      address: secrets.blind.address,
      addressBytesHex: hex0x(secrets.blind.addressBytes),
    },
  })

  const { depositId, data, r, bxDec, byDec } =
    await assembleGhostVaultDeposit(secrets)

  console.log('[GhostVault deposit debug] deposit(address,uint256[2]) payload', {
    tokenIndex,
    rDecimal: r.toString(),
    rHex: '0x' + r.toString(16),
    Bx_uint256_decimalString: bxDec,
    By_uint256_decimalString: byDec,
    depositId,
    calldata: data,
  })

  return { depositId, data }
}
