import {
  deriveTokenSecrets,
  getDepositId,
  getSpendAddress,
} from '../crypto/ghost-library'
import { fujiRpcCall } from './fujiJsonRpc'
import type { VaultTx } from '../types/activity'

type FujiRpcFn = typeof fujiRpcCall

/** Máx. llamadas JSON-RPC seguidas antes de pausar (`fetchVaultActivityForFirstTokens`). */
export const GHOST_VAULT_SCAN_RPC_BURST = 5
/** Pausa tras agotar el burst (ms). */
export const GHOST_VAULT_SCAN_RPC_PAUSE_MS = 30_000

/**
 * Cola serial: como máximo `burst` llamadas a `fujiRpcCall`; luego espera `pauseMs`.
 * Evita ráfagas que disparen rate limits del proveedor.
 */
function createVaultScanRpcLimiter(burst: number, pauseMs: number): FujiRpcFn {
  let used = 0
  let queue: Promise<unknown> = Promise.resolve()

  return function limited<T>(method: string, params: unknown[] = []): Promise<T> {
    const run = async (): Promise<T> => {
      if (used >= burst) {
        await new Promise((r) => setTimeout(r, pauseMs))
        used = 0
      }
      used += 1
      return fujiRpcCall<T>(method, params)
    }
    const next = queue.then(run) as Promise<T>
    queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}

/** Deployed GhostVault (Fuji) — override with `VITE_GHOST_VAULT_ADDRESS`. */
export const GHOST_VAULT_ADDRESS =
  (import.meta.env.VITE_GHOST_VAULT_ADDRESS as string | undefined) ??
  '0x0cd5b34e58c579105A3c080Bb3170d032a544352'

/**
 * Bloque del despliegue del vault por defecto (`GHOST_VAULT_ADDRESS`): no tiene sentido
 * pedir `eth_getLogs` antes — solo RPC de más. Ajustar si cambiás de contrato.
 */
export const GHOST_VAULT_SCAN_FROM_BLOCK_HEX = '0x329896c' // 53053804

/**
 * Scan / allocate in windows of this many token indices (0–4, 5–9, …).
 * Aligned with a privacy-pool-style counter: the **next** deposit uses
 * `lastUsedTokenIndex + 1`, not the lowest unused index (gaps are not backfilled).
 */
export const GHOST_VAULT_TOKEN_BATCH_SIZE = 5

/** Default cap: `maxBatches * GHOST_VAULT_TOKEN_BATCH_SIZE` token indices scanned upward. */
export const GHOST_VAULT_DEFAULT_MAX_BATCHES = 1

/** Intervalo entre refrescos agregados al vault vía HTTP RPC (Dashboard, Redeem, gas en modal). */
export const GHOST_VAULT_RPC_POLL_MS = 30_000

/** Highest token index we are willing to allocate without raising `maxBatches`. */
export function ghostVaultMaxScannedTokenIndex(
  maxBatches: number = GHOST_VAULT_DEFAULT_MAX_BATCHES
): number {
  return maxBatches * GHOST_VAULT_TOKEN_BATCH_SIZE - 1
}

/**
 * @deprecated Prefer `GHOST_VAULT_TOKEN_BATCH_SIZE` + batched scan; kept for older imports.
 */
export const GHOST_VAULT_TRACKED_TOKEN_INDICES = [0, 1, 2, 3, 4] as const

export const GHOST_VAULT_DEPOSIT_AMOUNT_LABEL = '0.01 AVAX' as const

/** `msg.value` for `GhostVault.deposit` — 0.01 native token (1e16 wei). */
export const GHOST_VAULT_DEPOSIT_VALUE_WEI_HEX = '0x2386f26fc10000' as const

/**
 * Topic0 for `DepositLocked(address indexed depositId, uint256[2] B)`.
 */
export const DEPOSIT_LOCKED_TOPIC =
  '0x862ec9340d087ce196a3c0e8813906101b8309ca08f1b34116302bb83558ed97'

/** `MintFulfilled(address indexed depositId, uint256[2] S_prime)` */
export const MINT_FULFILLED_TOPIC =
  '0x7416ef7e58ae7b94b7df89de0e6dc3e80de4ad46d77e62954dbe55de26829f79'

/** `spentNullifiers(address)` getter (`abi.json`). */
const SPENT_NULLIFIERS_SELECTOR = '0x2b2ba6e8'

function normalizeAddress(a: string): string {
  const h = a.replace(/^0x/i, '').toLowerCase()
  if (h.length !== 40) throw new Error(`Invalid address: ${a}`)
  return `0x${h}`
}

/** `depositId` as log topic: 32-byte left-padded (indexed address). */
export function depositIdToTopic(depositId: string): string {
  const addr = normalizeAddress(depositId).slice(2)
  return `0x${'0'.repeat(24)}${addr}`
}

/**
 * Derivación que usa el escáner para alinear con `DepositLocked` / `MintFulfilled`:
 * mismo `depositId` que en cadena (topic1) ⇔ `getDepositId(deriveTokenSecrets(seed, tokenIndex))`.
 * Útil para depurar “hay evento pero no aparece en la app”.
 */
export function vaultDerivedAddressesForIndices(
  masterSeed: Uint8Array,
  tokenIndices: number[]
): { tokenIndex: number; depositId: string; spendAddress: string }[] {
  return tokenIndices.map((tokenIndex) => {
    const secrets = deriveTokenSecrets(masterSeed, tokenIndex)
    return {
      tokenIndex,
      depositId: normalizeAddress(getDepositId(secrets)),
      spendAddress: normalizeAddress(getSpendAddress(secrets)),
    }
  })
}

function topic1ToDepositId(topic1: string): string {
  const h = topic1.replace(/^0x/i, '')
  return normalizeAddress(`0x${h.slice(-40)}`)
}

type RpcLog = {
  blockNumber?: string
  transactionHash?: string
  topics?: string[]
}

function parseHexBlock(n: string | undefined): number {
  if (!n || n === '0x') return 0
  return Number.parseInt(n, 16)
}

/** Filtro `eth_getLogs` (sin tocar `fromBlock` / `toBlock` en el caller parcial). */
type EthGetLogsPartialFilter = {
  address: string
  topics: (string | string[])[]
}

function parseMaxBlockSpanFromRpcError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const maxIs = msg.match(/maximum is set to (\d+)/i)
  if (maxIs) return Math.max(1, parseInt(maxIs[1], 10))
  const alchemy = msg.match(/up to a (\d+) block range/i)
  if (alchemy) return Math.max(1, parseInt(alchemy[1], 10))
  return null
}

function looksLikeBlockRangeRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /too many blocks|block range|maximum is set/i.test(msg)
}

/** Avalanche: `eth_blockNumber` puede ir por delante del último bloque aceptado para `eth_getLogs`. */
function parseLastAcceptedBlockFromRpcError(err: unknown): bigint | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/last accepted block (\d+)/i)
  if (!m) return null
  return BigInt(m[1])
}

async function ethGetLogsOnce(
  rpc: FujiRpcFn,
  filter: EthGetLogsPartialFilter & { fromBlock: string; toBlock: string }
): Promise<RpcLog[]> {
  const logs = await rpc<RpcLog[] | null>('eth_getLogs', [filter])
  return Array.isArray(logs) ? logs : []
}

/**
 * Recorre [fromBlock … toBlock] en ventanas de a lo sumo `maxSpan` bloques (inclusive).
 * Necesario en el RPC público Fuji (~2048) y en planes free de otros proveedores (~10).
 */
async function ethGetLogsChunked(
  rpc: FujiRpcFn,
  partial: EthGetLogsPartialFilter,
  fromBlock: string,
  toBlock: 'latest' | string,
  maxSpan: number
): Promise<RpcLog[]> {
  const toHexResolved =
    toBlock === 'latest'
      ? await rpc<string>('eth_blockNumber', [])
      : toBlock
  const fromBn = BigInt(fromBlock)
  let toBn = BigInt(toHexResolved)
  if (toBn < fromBn) return []

  const out: RpcLog[] = []
  let cur = fromBn
  const span = BigInt(maxSpan)
  while (cur <= toBn) {
    const end = cur + span - 1n <= toBn ? cur + span - 1n : toBn
    try {
      const chunk = await ethGetLogsOnce(rpc, {
        ...partial,
        fromBlock: `0x${cur.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      })
      out.push(...chunk)
      cur = end + 1n
    } catch (e) {
      const accepted = parseLastAcceptedBlockFromRpcError(e)
      if (accepted != null) {
        if (accepted < toBn) toBn = accepted
        if (cur > toBn) return out
        continue
      }
      throw e
    }
  }
  return out
}

async function ethGetLogsAutoChunk(
  rpc: FujiRpcFn,
  partial: EthGetLogsPartialFilter,
  fromBlock: string,
  toBlock: 'latest' | string
): Promise<RpcLog[]> {
  try {
    return await ethGetLogsOnce(rpc, {
      ...partial,
      fromBlock,
      toBlock: toBlock === 'latest' ? 'latest' : toBlock,
    })
  } catch (e) {
    const lastAcc = parseLastAcceptedBlockFromRpcError(e)
    if (lastAcc != null) {
      const fromBn = BigInt(fromBlock)
      if (fromBn > lastAcc) return []
      const cappedHex = `0x${lastAcc.toString(16)}`
      try {
        return await ethGetLogsOnce(rpc, {
          ...partial,
          fromBlock,
          toBlock: cappedHex,
        })
      } catch (e2) {
        const parsed = parseMaxBlockSpanFromRpcError(e2)
        const span = parsed ?? (looksLikeBlockRangeRpcError(e2) ? 2048 : null)
        if (span == null) throw e2
        return ethGetLogsChunked(rpc, partial, fromBlock, cappedHex, span)
      }
    }
    const parsed = parseMaxBlockSpanFromRpcError(e)
    const span = parsed ?? (looksLikeBlockRangeRpcError(e) ? 2048 : null)
    if (span == null) throw e
    return ethGetLogsChunked(rpc, partial, fromBlock, toBlock, span)
  }
}

function txShort(hash: string): string {
  if (hash.length > 12) return `${hash.slice(0, 10)}…${hash.slice(-6)}`
  return hash
}

function addrShort(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`
}

function batchTokenIndices(batchIndex: number): number[] {
  const base = batchIndex * GHOST_VAULT_TOKEN_BATCH_SIZE
  return Array.from({ length: GHOST_VAULT_TOKEN_BATCH_SIZE }, (_, j) => base + j)
}

async function blockHexToDateIso(
  blockNumberHex: string | undefined,
  rpc: FujiRpcFn = fujiRpcCall
): Promise<string> {
  if (!blockNumberHex) return new Date().toISOString().slice(0, 10)
  try {
    const block = await rpc<{ timestamp?: string } | null>(
      'eth_getBlockByNumber',
      [blockNumberHex, false]
    )
    const ts = block?.timestamp
      ? Number.parseInt(block.timestamp, 16)
      : Math.floor(Date.now() / 1000)
    return new Date(ts * 1000).toISOString().slice(0, 10)
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/**
 * `eth_getLogs` para varios `depositId`: intenta un filtro con OR en `topics[1]`.
 * Varios RPC (p. ej. públicos) devuelven `[]` sin error si no soportan bien el OR;
 * en ese caso repetimos **una query por `depositId`** (misma cola serial `rpc`).
 */
async function fetchLogsForDepositIds(
  vault: string,
  topic0: string,
  depositIds: string[],
  fromBlock: string,
  rpc: FujiRpcFn = fujiRpcCall
): Promise<RpcLog[]> {
  const topic1List = depositIds.map(depositIdToTopic)
  const partialOr: EthGetLogsPartialFilter = {
    address: vault,
    topics: [topic0, topic1List],
  }

  async function fetchPerTopic1(): Promise<RpcLog[]> {
    const parts = await Promise.all(
      topic1List.map((t1) =>
        ethGetLogsAutoChunk(
          rpc,
          { address: vault, topics: [topic0, t1] },
          fromBlock,
          'latest'
        )
      )
    )
    return parts.flat()
  }

  let logs: RpcLog[] = []
  try {
    logs = await ethGetLogsAutoChunk(rpc, partialOr, fromBlock, 'latest')
  } catch {
    logs = []
  }
  if (!Array.isArray(logs)) logs = []

  if (logs.length === 0 && topic1List.length > 0) {
    logs = await fetchPerTopic1()
  }
  return logs
}

function latestLogByDepositId(logs: RpcLog[]): Map<string, RpcLog> {
  const m = new Map<string, RpcLog>()
  for (const log of logs) {
    const t1 = log.topics?.[1]
    if (!t1) continue
    const id = topic1ToDepositId(t1)
    const prev = m.get(id)
    if (
      !prev ||
      parseHexBlock(log.blockNumber) >= parseHexBlock(prev.blockNumber)
    ) {
      m.set(id, log)
    }
  }
  return m
}

async function spentNullifierIsSet(
  vault: string,
  spendAddress: string,
  rpc: FujiRpcFn = fujiRpcCall
): Promise<boolean> {
  const addr = normalizeAddress(spendAddress).slice(2)
  const data = (SPENT_NULLIFIERS_SELECTOR + addr.padStart(64, '0')).toLowerCase()
  const result = await rpc<string>('eth_call', [
    { to: vault, data },
    'latest',
  ])
  if (!result || result === '0x') return false
  try {
    return BigInt(result) !== 0n
  } catch {
    return false
  }
}

function batchAllHaveDepositLocked(
  depositIds: string[],
  lockedById: Map<string, RpcLog>
): boolean {
  return depositIds.every((id) => lockedById.has(normalizeAddress(id)))
}

export type GhostVaultFetchOptions = {
  contractAddress?: string
  /** Hex; por defecto {@link GHOST_VAULT_SCAN_FROM_BLOCK_HEX}. */
  fromBlock?: string
  networkLabel?: string
  /** Solo `findLastUsedVaultTokenIndex` / `getNextVaultTokenIndexForDeposit`. Ignorado en `fetchVaultActivityForFirstTokens`. */
  maxBatches?: number
}

/**
 * Scans token indices in windows of {@link GHOST_VAULT_TOKEN_BATCH_SIZE}:
 * derives `depositId` via `deriveTokenSecrets` (ghost-library), matches
 * `DepositLocked` / `MintFulfilled`, and `spentNullifiers(spend.address)` for redeemed.
 *
 * Continues to the next batch only if **every** index in the current batch has a
 * `DepositLocked` log (sequential slot model). Stops after the first batch where
 * that is not the case (still listing activity for that batch). Sin tope de lotes:
 * avanza hasta la frontera natural del vault.
 *
 * **RPC:** como máximo {@link GHOST_VAULT_SCAN_RPC_BURST} llamadas JSON-RPC seguidas,
 * luego pausa {@link GHOST_VAULT_SCAN_RPC_PAUSE_MS} ms (cola serial).
 */
export async function fetchVaultActivityForFirstTokens(
  masterSeed: Uint8Array,
  options?: GhostVaultFetchOptions
): Promise<VaultTx[]> {
  const vault = normalizeAddress(
    options?.contractAddress ?? GHOST_VAULT_ADDRESS
  )
  const fromBlock = options?.fromBlock ?? GHOST_VAULT_SCAN_FROM_BLOCK_HEX
  const netLabel = options?.networkLabel ?? 'Fuji'
  const rpc = createVaultScanRpcLimiter(
    GHOST_VAULT_SCAN_RPC_BURST,
    GHOST_VAULT_SCAN_RPC_PAUSE_MS
  )

  type RowDraft = {
    row: Omit<VaultTx, 'dateIso' | 'time'>
    blockHex?: string
  }
  const drafts: RowDraft[] = []

  for (let b = 0; ; b++) {
    const indices = batchTokenIndices(b)
    // Comparación con cadena: depositId derivado ⇔ topic1 del log (ver `latestLogByDepositId`).
    // Depuración: `vaultDerivedAddressesForIndices(masterSeed, indices)`.
    const secretsList = indices.map((tokenIndex) =>
      deriveTokenSecrets(masterSeed, tokenIndex)
    )
    const depositIds = secretsList.map((s) => getDepositId(s))

    const [lockedRaw, fulfilledRaw] = await Promise.all([
      fetchLogsForDepositIds(
        vault,
        DEPOSIT_LOCKED_TOPIC,
        depositIds,
        fromBlock,
        rpc
      ),
      fetchLogsForDepositIds(
        vault,
        MINT_FULFILLED_TOPIC,
        depositIds,
        fromBlock,
        rpc
      ),
    ])

    const lockedById = latestLogByDepositId(lockedRaw)
    const fulfilledById = latestLogByDepositId(fulfilledRaw)

    const spentFlags = await Promise.all(
      secretsList.map((s) =>
        spentNullifierIsSet(vault, getSpendAddress(s), rpc)
      )
    )

    for (let j = 0; j < indices.length; j++) {
      const tokenIndex = indices[j]!
      const secrets = secretsList[j]!
      const depositId = normalizeAddress(getDepositId(secrets))
      const spendAddress = getSpendAddress(secrets)
      const blindShort = addrShort(depositId)
      const spendShort = addrShort(spendAddress)

      if (spentFlags[j]) {
        const mintLog = fulfilledById.get(depositId)
        const lockLog = lockedById.get(depositId)
        const refLog = mintLog ?? lockLog
        const blockHex = refLog?.blockNumber
        const bn = parseHexBlock(blockHex)
        const txh = refLog?.transactionHash ?? '—'
        drafts.push({
          blockHex,
          row: {
            id: `vault-redeemed-${tokenIndex}`,
            type: 'Redeem',
            amount: GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
            counterparty: spendShort,
            txHash: txh,
            historyLabel: `Redeem · spent · token #${tokenIndex}`,
            historySub: `spentNullifiers[${spendShort}] · block ${bn || '?'} · ${netLabel}`,
            blockNumber: bn,
            tokenIndex,
          },
        })
        continue
      }

      const fLog = fulfilledById.get(depositId)
      if (fLog) {
        const bn = parseHexBlock(fLog.blockNumber)
        const txh = fLog.transactionHash ?? '—'
        drafts.push({
          blockHex: fLog.blockNumber,
          row: {
            id: `vault-deposit-${tokenIndex}`,
            type: 'Deposit',
            amount: GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
            counterparty: spendShort,
            txHash: txh,
            historyLabel: `Deposit · mint fulfilled · token #${tokenIndex}`,
            historySub: `MintFulfilled · ${txShort(txh)} · block ${bn || '?'} · ${netLabel}`,
            blockNumber: bn,
            tokenIndex,
          },
        })
        continue
      }

      const lLog = lockedById.get(depositId)
      if (lLog) {
        const bn = parseHexBlock(lLog.blockNumber)
        const txh = lLog.transactionHash ?? '—'
        drafts.push({
          blockHex: lLog.blockNumber,
          row: {
            id: `vault-pending-${tokenIndex}`,
            type: 'Pending',
            amount: GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
            counterparty: blindShort,
            txHash: txh,
            historyLabel: `Deposit · pending · token #${tokenIndex}`,
            historySub: `DepositLocked · ${txShort(txh)} · block ${bn || '?'} · ${netLabel}`,
            blockNumber: bn,
            tokenIndex,
          },
        })
      }
    }

    if (!batchAllHaveDepositLocked(depositIds, lockedById)) break
  }

  const blockDateCache = new Map<string, string>()
  const dateIsos: string[] = []
  for (const d of drafts) {
    const hex = d.blockHex
    if (!hex) {
      dateIsos.push(new Date().toISOString().slice(0, 10))
      continue
    }
    let iso = blockDateCache.get(hex)
    if (!iso) {
      iso = await blockHexToDateIso(hex, rpc)
      blockDateCache.set(hex, iso)
    }
    dateIsos.push(iso)
  }

  const rows: VaultTx[] = drafts.map((d, i) => ({
    ...d.row,
    dateIso: dateIsos[i]!,
    time: dateIsos[i]!,
  }))

  rows.sort((a, b) => {
    const ba = a.blockNumber ?? -1
    const bb = b.blockNumber ?? -1
    if (bb !== ba) return bb - ba
    return b.id.localeCompare(a.id)
  })

  return rows
}

/**
 * Largest token index that already has `DepositLocked` or `MintFulfilled` for its
 * derived `depositId`. Returns `-1` if none. Scans in batches of
 * {@link GHOST_VAULT_TOKEN_BATCH_SIZE}; stops at the first batch with **no** such
 * activity (monotonic frontier, privacy-pool style).
 */
export async function findLastUsedVaultTokenIndex(
  masterSeed: Uint8Array,
  options?: Pick<
    GhostVaultFetchOptions,
    'contractAddress' | 'fromBlock' | 'maxBatches'
  >
): Promise<number> {
  const vault = normalizeAddress(
    options?.contractAddress ?? GHOST_VAULT_ADDRESS
  )
  const fromBlock = options?.fromBlock ?? GHOST_VAULT_SCAN_FROM_BLOCK_HEX
  const maxBatches =
    options?.maxBatches ?? GHOST_VAULT_DEFAULT_MAX_BATCHES

  let lastUsed = -1

  for (let b = 0; b < maxBatches; b++) {
    const indices = batchTokenIndices(b)
    const depositIds = indices.map((tokenIndex) =>
      getDepositId(deriveTokenSecrets(masterSeed, tokenIndex))
    )

    const [lockedRaw, fulfilledRaw] = await Promise.all([
      fetchLogsForDepositIds(vault, DEPOSIT_LOCKED_TOPIC, depositIds, fromBlock),
      fetchLogsForDepositIds(vault, MINT_FULFILLED_TOPIC, depositIds, fromBlock),
    ])
    const lockedById = latestLogByDepositId(lockedRaw)
    const fulfilledById = latestLogByDepositId(fulfilledRaw)

    let batchAny = false
    for (let j = 0; j < indices.length; j++) {
      const id = normalizeAddress(depositIds[j]!)
      if (lockedById.has(id) || fulfilledById.has(id)) {
        batchAny = true
        const idx = indices[j]!
        if (idx > lastUsed) lastUsed = idx
      }
    }

    if (!batchAny) break
  }

  return lastUsed
}

/**
 * Next token index for a **new** deposit: `findLastUsedVaultTokenIndex + 1`
 * (privacy pool–style progression; does not reuse skipped lower indices).
 */
export async function getNextVaultTokenIndexForDeposit(
  masterSeed: Uint8Array,
  options?: Pick<
    GhostVaultFetchOptions,
    'contractAddress' | 'fromBlock' | 'maxBatches'
  >
): Promise<number> {
  const last = await findLastUsedVaultTokenIndex(masterSeed, options)
  return last + 1
}

/**
 * @deprecated Use {@link getNextVaultTokenIndexForDeposit} (privacy-pool counter).
 * Previously returned the lowest index without `DepositLocked`; that backfilled gaps.
 */
export async function findFirstFreeVaultTokenIndex(
  masterSeed: Uint8Array,
  options?: Pick<
    GhostVaultFetchOptions,
    'contractAddress' | 'fromBlock' | 'maxBatches'
  >
): Promise<number> {
  return getNextVaultTokenIndexForDeposit(masterSeed, options)
}

/** @deprecated Use `fetchVaultActivityForFirstTokens` (includes MintFulfilled → Deposit). */
export async function fetchPendingDepositsFromEvents(
  masterSeed: Uint8Array,
  options?: GhostVaultFetchOptions
): Promise<VaultTx[]> {
  const all = await fetchVaultActivityForFirstTokens(masterSeed, options)
  return all.filter((x) => x.type === 'Pending')
}

/** Disparar tras firmar / borrar semilla derivada (refresco actividad, gas, etc.). */
export const GHOST_MASTER_SEED_CHANGED_EVENT = 'ghost:master-seed-changed'

/**
 * Solo `VITE_GHOST_MASTER_SEED_HEX` (opcional, p. ej. CI / dev sin MetaMask).
 * En la app normal el `masterSeed` sale de `personal_sign` vía `GhostMasterSeedProvider`.
 */
export function getGhostMasterSeedFromEnv(): Uint8Array | null {
  const raw = import.meta.env.VITE_GHOST_MASTER_SEED_HEX as string | undefined
  if (raw == null || String(raw).trim() === '') return null
  const hex = raw.replace(/^0x/i, '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Uint8Array.from(hex.match(/.{2}/g)!.map((x) => parseInt(x, 16)))
}
