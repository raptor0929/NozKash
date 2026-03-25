import { keccak256 } from 'ethereum-cryptography/keccak'
import {
  deriveTokenSecrets,
  getDepositId,
  getSpendAddress,
} from '../crypto/ghost-library'
import { fujiRpcCall } from './fujiJsonRpc'
import type { VaultTx } from '../types/activity'

type FujiRpcFn = typeof fujiRpcCall

/** `.env` values like `60_000` must not use `parseInt` alone — it parses as `60`. */
function normalizeEnvIntString(raw: string | undefined): string {
  if (raw == null) return ''
  return String(raw).replace(/_/g, '').trim()
}

function parseEnvPositiveInt(
  raw: string | undefined,
  fallback: number
): number {
  const s = normalizeEnvIntString(raw)
  if (s === '') return fallback
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseEnvPositiveIntMin(
  raw: string | undefined,
  fallback: number,
  min: number
): number {
  return Math.max(min, parseEnvPositiveInt(raw, fallback))
}

function parseEnvPositiveIntClamp(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = parseEnvPositiveIntMin(raw, fallback, min)
  return Math.min(max, n)
}

const GHOST_VAULT_MAX_BATCHES_FALLBACK = 128
/** Safety clamp so a typo in env does not schedule millions of RPC rounds. */
const GHOST_VAULT_MAX_BATCHES_HARD_CAP = 10_000

function parseGhostVaultMaxBatchesFromEnv(): number {
  const n = parseEnvPositiveInt(
    import.meta.env.VITE_GHOST_VAULT_MAX_BATCHES,
    GHOST_VAULT_MAX_BATCHES_FALLBACK
  )
  return Math.min(GHOST_VAULT_MAX_BATCHES_HARD_CAP, Math.max(1, n))
}

/**
 * Max consecutive JSON-RPC calls before pausing (`fetchVaultActivityForFirstTokens`).
 * Public RPC defaults are conservative; raise with a dedicated endpoint.
 */
export const GHOST_VAULT_SCAN_RPC_BURST = parseEnvPositiveInt(
  import.meta.env.VITE_GHOST_VAULT_RPC_BURST,
  5
)
/** Pause after burst is exhausted (ms). */
export const GHOST_VAULT_SCAN_RPC_PAUSE_MS = parseEnvPositiveInt(
  import.meta.env.VITE_GHOST_VAULT_RPC_PAUSE_MS,
  7500
)

function scanCacheTtlMs(): number {
  const raw = import.meta.env.VITE_GHOST_VAULT_SCAN_CACHE_MS
  /** Default 60s so Dashboard polls (often 10s) hit cache instead of full log scans. */
  const s = normalizeEnvIntString(raw)
  if (s === '') return 60_000
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n)) return 60_000
  return Math.max(0, n)
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function masterSeedCacheKey(seed: Uint8Array): string {
  return bytesToHex(keccak256(seed))
}

function getVaultActivityCacheKey(
  masterSeed: Uint8Array,
  vault: string,
  fromBlock: string
): string {
  return `${vault}|${fromBlock}|${masterSeedCacheKey(masterSeed)}`
}

/**
 * Largest token index with `DepositLocked` or `MintFulfilled` implied by activity rows
 * (same notion as scanning batches for last-used).
 */
function lastUsedFromVaultActivityRows(rows: VaultTx[]): number {
  let last = -1
  for (const r of rows) {
    if (r.tokenIndex === undefined || r.tokenIndex < 0) continue
    if (r.type !== 'Deposit' && r.type !== 'Pending' && r.type !== 'Redeem')
      continue
    if (r.tokenIndex > last) last = r.tokenIndex
  }
  return last
}

type ScanCacheEntry = { at: number; rows: VaultTx[] }
const vaultActivityCache = new Map<string, ScanCacheEntry>()
let inflightActivityKey: string | null = null
let inflightActivityPromise: Promise<VaultTx[]> | null = null

/** Dev or `VITE_GHOST_VAULT_ACTIVITY_DEBUG=true` — enables {@link ghostVaultActivityDebug}. */
export function isGhostVaultActivityDebug(): boolean {
  return (
    import.meta.env.DEV === true ||
    import.meta.env.VITE_GHOST_VAULT_ACTIVITY_DEBUG === 'true'
  )
}

export function ghostVaultActivityDebug(...args: unknown[]): void {
  if (!isGhostVaultActivityDebug()) return
  console.log('[GhostVault activity]', ...args)
}

/**
 * Invalidates the `fetchVaultActivityForFirstTokens` cache (e.g. after a confirmed deposit).
 */
export function invalidateVaultActivityCache(): void {
  ghostVaultActivityDebug('invalidateVaultActivityCache: cleared')
  vaultActivityCache.clear()
}

/** Dispatched after deposit/redeem so UIs refetch activity without waiting for the poll interval. */
export const GHOST_VAULT_ACTIVITY_REFRESH_EVENT = 'ghost:vault-activity-refresh'

let ghostVaultLiveActive = false

/**
 * When vault live (WebSocket incremental updates) is active, we avoid clearing
 * the HTTP activity cache on deposit/redeem so the app doesn’t immediately
 * re-scan large log ranges and trigger 429s.
 */
export function setGhostVaultLiveActive(active: boolean): void {
  ghostVaultLiveActive = active
}

let vaultActivityRefreshDebounce: number | null = null

/**
 * Notifies listeners (e.g. Dashboard) to refetch soon (debounced to avoid
 * duplicate scans). When live updates are active we skip clearing the HTTP
 * cache to keep the app stable on public RPC.
 */
export function requestVaultActivityRefresh(): void {
  if (!ghostVaultLiveActive) invalidateVaultActivityCache()
  if (vaultActivityRefreshDebounce != null) {
    window.clearTimeout(vaultActivityRefreshDebounce)
  }
  vaultActivityRefreshDebounce = window.setTimeout(() => {
    vaultActivityRefreshDebounce = null
    window.dispatchEvent(new Event(GHOST_VAULT_ACTIVITY_REFRESH_EVENT))
  }, 350)
}

/**
 * Serial queue: at most `burst` calls to `fujiRpcCall`, then wait `pauseMs`.
 * Avoids bursts that hit provider rate limits.
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
 * Default vault deployment block (`GHOST_VAULT_ADDRESS`): no point querying
 * `eth_getLogs` earlier — extra RPC only. Update if you change contracts.
 */
export const GHOST_VAULT_SCAN_FROM_BLOCK_HEX = '0x329896c' // 53053804

/**
 * Scan / allocate in windows of this many token indices (0–4, 5–9, …).
 * Aligned with a privacy-pool-style counter: the **next** deposit uses
 * `max(lastUsedTokenIndex + 1, GHOST_VAULT_MIN_NEW_DEPOSIT_TOKEN_INDEX)`, not the
 * lowest unused index (gaps are not backfilled).
 */
export const GHOST_VAULT_TOKEN_BATCH_SIZE = parseEnvPositiveIntClamp(
  import.meta.env.VITE_GHOST_VAULT_TOKEN_BATCH_SIZE,
  5,
  1,
  50
)

/**
 * Lowest token index the UI will allocate for a **new** deposit (`lastUsed + 1`, but
 * never below this). Use 2 to leave indices 0–1 unused by the auto counter.
 */
export const GHOST_VAULT_MIN_NEW_DEPOSIT_TOKEN_INDEX = 2

/**
 * Upper bound on batches for activity scan and {@link findLastUsedVaultTokenIndex} /
 * {@link getNextVaultTokenIndexForDeposit} (each batch = {@link GHOST_VAULT_TOKEN_BATCH_SIZE} indices).
 * Default 128 → token indices 0…639 max when every batch is non-empty.
 * Override: `VITE_GHOST_VAULT_MAX_BATCHES` (clamped 1…10000).
 */
export const GHOST_VAULT_ACTIVITY_MAX_BATCHES = parseGhostVaultMaxBatchesFromEnv()

/**
 * Default batch cap for {@link findLastUsedVaultTokenIndex} / {@link getNextVaultTokenIndexForDeposit}.
 * Must cover every batch that can hold on-chain activity, or `lastUsed` stops at index 4 (batch 0 only)
 * and the next deposit can reuse an existing `depositId` → `DepositIdAlreadyUsed` on-chain.
 */
export const GHOST_VAULT_DEFAULT_MAX_BATCHES = GHOST_VAULT_ACTIVITY_MAX_BATCHES

/**
 * Interval between vault refreshes over HTTP RPC (Dashboard, Redeem, modal gas).
 * Override with `VITE_GHOST_VAULT_RPC_POLL_MS` (min 2000 ms).
 */
export const GHOST_VAULT_RPC_POLL_MS = parseEnvPositiveIntMin(
  import.meta.env.VITE_GHOST_VAULT_RPC_POLL_MS,
  10_000,
  2000
)

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
 * Derivation the scanner uses to align with `DepositLocked` / `MintFulfilled`:
 * same on-chain `depositId` (topic1) ⇔ `getDepositId(deriveTokenSecrets(seed, tokenIndex))`.
 * Useful to debug “event exists but row missing in the app”.
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
  /** ABI event body (e.g. `uint256[2]` in `MintFulfilled`). */
  data?: string
}

function parseHexBlock(n: string | undefined): number {
  if (!n || n === '0x') return 0
  return Number.parseInt(n, 16)
}

/** `eth_getLogs` filter partial (caller supplies `fromBlock` / `toBlock`). */
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

/** Avalanche: `eth_blockNumber` may be ahead of the last block accepted for `eth_getLogs`. */
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
 * Walks [fromBlock … toBlock] in windows of at most `maxSpan` blocks (inclusive).
 * Needed on public Fuji RPC (~2048) and free tiers of other providers (~10).
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
 * `eth_getLogs` for several `depositId`s: tries an OR filter on `topics[1]`.
 * Some RPCs (e.g. public) return `[]` without error if OR is flaky;
 * then we fall back to **one query per `depositId`** (same serial `rpc` queue).
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
    /** Sequential to avoid N parallel `eth_getLogs` against the same RPC. */
    const out: RpcLog[] = []
    for (const t1 of topic1List) {
      const chunk = await ethGetLogsAutoChunk(
        rpc,
        { address: vault, topics: [topic0, t1] },
        fromBlock,
        'latest'
      )
      out.push(...chunk)
    }
    return out
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

/**
 * Reads `MintFulfilled` for a `depositId` and returns S′ (G1) as integers from the event.
 */
export async function fetchMintFulfilledSPrime(
  depositId: string,
  options?: Pick<GhostVaultFetchOptions, 'contractAddress' | 'fromBlock'>
): Promise<{ sx: bigint; sy: bigint } | null> {
  const vault = normalizeAddress(
    options?.contractAddress ?? GHOST_VAULT_ADDRESS
  )
  const fromBlock = options?.fromBlock ?? GHOST_VAULT_SCAN_FROM_BLOCK_HEX
  const id = normalizeAddress(depositId)
  const logs = await fetchLogsForDepositIds(
    vault,
    MINT_FULFILLED_TOPIC,
    [id],
    fromBlock,
    fujiRpcCall
  )
  const log = latestLogByDepositId(logs).get(id)
  const data = log?.data?.replace(/^0x/i, '') ?? ''
  if (data.length < 128) return null
  const sx = BigInt('0x' + data.slice(0, 64))
  const sy = BigInt('0x' + data.slice(64, 128))
  return { sx, sy }
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

/** True if any derived `depositId` in this batch has `DepositLocked` or `MintFulfilled` on-chain. */
function batchHasAnyVaultActivity(
  depositIds: string[],
  lockedById: Map<string, RpcLog>,
  fulfilledById: Map<string, RpcLog>
): boolean {
  return depositIds.some((id) => {
    const n = normalizeAddress(id)
    return lockedById.has(n) || fulfilledById.has(n)
  })
}

export type GhostVaultFetchOptions = {
  contractAddress?: string
  /** Hex; defaults to {@link GHOST_VAULT_SCAN_FROM_BLOCK_HEX}. */
  fromBlock?: string
  networkLabel?: string
  /**
   * `findLastUsedVaultTokenIndex` / `getNextVaultTokenIndexForDeposit`: default {@link GHOST_VAULT_DEFAULT_MAX_BATCHES}.
   * `fetchVaultActivityForFirstTokens`: optional cap (clamped to {@link GHOST_VAULT_ACTIVITY_MAX_BATCHES}).
   */
  maxBatches?: number
  /** If true, skips activity cache (still dedupes identical in-flight requests). */
  skipCache?: boolean
  /**
   * Called after each scanned batch with merged sorted rows so far (faster first paint).
   * Also invoked once on cache hit with the full cached list.
   */
  onProgress?: (rows: VaultTx[]) => void
  /**
   * Called after each scanned batch (including empty ones) with the current
   * batch index and merged rows so far. Useful to show "progressive loading"
   * without waiting for the final scan result.
   */
  onBatchProgress?: (batchIndex: number, rows: VaultTx[], tokenIndices: number[]) => void
}

/**
 * Scans token indices in windows of {@link GHOST_VAULT_TOKEN_BATCH_SIZE}:
 * derives `depositId` with `deriveTokenSecrets(masterSeed, i)` (same `masterSeed` as the app:
 * `personal_sign` or `VITE_GHOST_MASTER_SEED_HEX`; **not** the raw EVM private key except in dev).
 * Joins **`DepositLocked`** (deposit), **`MintFulfilled`** (mint delivered; there is no `MintLocked` on the contract),
 * and `spentNullifiers(nullifier)` where `nullifier = spend.address`.
 *
 * - **Pending:** `DepositLocked` for that `depositId` but no `MintFulfilled` yet.
 * - **Deposited (mint fulfilled):** `DepositLocked` + `MintFulfilled`, and `spentNullifiers` false.
 * - **Redeemed:** `spentNullifiers(spend.address)` true (only queried if `MintFulfilled` exists, to save RPC).
 *
 * Scans batches of 5 indices until **two consecutive** batches have **no** `DepositLocked` or
 * `MintFulfilled` (so a single empty batch still scans higher indices — avoids gaps at 0–4 hiding 5+).
 *
 * **RPC:** burst/pause queue; cache TTL + dedupe of identical concurrent requests.
 *
 * **`onProgress`:** after each batch with at least one row, receives merged sorted rows so far (faster UI).
 */
export async function fetchVaultActivityForFirstTokens(
  masterSeed: Uint8Array,
  options?: GhostVaultFetchOptions
): Promise<VaultTx[]> {
  const vault = normalizeAddress(
    options?.contractAddress ?? GHOST_VAULT_ADDRESS
  )
  const fromBlock = options?.fromBlock ?? GHOST_VAULT_SCAN_FROM_BLOCK_HEX
  const cacheKey = getVaultActivityCacheKey(masterSeed, vault, fromBlock)
  const ttl = scanCacheTtlMs()
  const now = Date.now()

  if (!options?.skipCache && ttl > 0) {
    const hit = vaultActivityCache.get(cacheKey)
    if (hit && now - hit.at < ttl) {
      ghostVaultActivityDebug('cache hit', {
        ageMs: now - hit.at,
        ttlMs: ttl,
        rowCount: hit.rows.length,
        tokenIndices: hit.rows.map((r) => r.tokenIndex),
      })
      options?.onProgress?.(hit.rows)
      return hit.rows
    }
  }

  if (inflightActivityKey === cacheKey && inflightActivityPromise) {
    ghostVaultActivityDebug('awaiting inflight fetch (deduped)')
    return inflightActivityPromise
  }

  ghostVaultActivityDebug('fetch start', {
    skipCache: options?.skipCache ?? false,
    ttlMs: ttl,
    vault,
    fromBlock,
    cacheKeyPrefix: `${vault.slice(0, 10)}…|${fromBlock}`,
  })

  inflightActivityKey = cacheKey
  inflightActivityPromise = fetchVaultActivityForFirstTokensImpl(
    masterSeed,
    options,
    vault,
    fromBlock
  ).then((rows) => {
    if (!options?.skipCache && ttl > 0) {
      vaultActivityCache.set(cacheKey, { at: Date.now(), rows })
    }
    return rows
  })

  try {
    return await inflightActivityPromise
  } finally {
    inflightActivityKey = null
    inflightActivityPromise = null
  }
}

type VaultRowDraft = {
  row: Omit<VaultTx, 'dateIso' | 'time'>
  blockHex?: string
}

function sortVaultRowsCompare(a: VaultTx, b: VaultTx): number {
  const ba = a.blockNumber ?? -1
  const bb = b.blockNumber ?? -1
  if (bb !== ba) return bb - ba
  return b.id.localeCompare(a.id)
}

function mergeVaultRowsSorted(a: VaultTx[], b: VaultTx[]): VaultTx[] {
  return [...a, ...b].sort(sortVaultRowsCompare)
}

async function finalizeDraftsToRows(
  drafts: VaultRowDraft[],
  rpc: FujiRpcFn
): Promise<VaultTx[]> {
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
  return drafts.map((d, i) => ({
    ...d.row,
    dateIso: dateIsos[i]!,
    time: dateIsos[i]!,
  }))
}

async function fetchVaultActivityForFirstTokensImpl(
  masterSeed: Uint8Array,
  options: GhostVaultFetchOptions | undefined,
  vault: string,
  fromBlock: string
): Promise<VaultTx[]> {
  const netLabel = options?.networkLabel ?? 'Fuji'
  const rpc = createVaultScanRpcLimiter(
    GHOST_VAULT_SCAN_RPC_BURST,
    GHOST_VAULT_SCAN_RPC_PAUSE_MS
  )
  const maxBatches =
    options?.maxBatches != null && options.maxBatches > 0
      ? Math.min(options.maxBatches, GHOST_VAULT_ACTIVITY_MAX_BATCHES)
      : GHOST_VAULT_ACTIVITY_MAX_BATCHES

  ghostVaultActivityDebug('scan batches', {
    burst: GHOST_VAULT_SCAN_RPC_BURST,
    pauseMs: GHOST_VAULT_SCAN_RPC_PAUSE_MS,
    batchSize: GHOST_VAULT_TOKEN_BATCH_SIZE,
    maxBatches,
    note: 'stop after 2 consecutive batches with no DepositLocked / MintFulfilled',
  })

  let mergedRows: VaultTx[] = []
  /** Stop only after 2 consecutive batches with no logs — one empty batch can be a gap (0–4 unused, 5+ used). */
  let consecutiveEmptyBatches = 0

  for (let b = 0; b < maxBatches; b++) {
    const indices = batchTokenIndices(b)
    // On-chain match: derived depositId ⇔ log topic1 (see `latestLogByDepositId`).
    // Debug: `vaultDerivedAddressesForIndices(masterSeed, indices)`.
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

    const spentFlags: boolean[] = []
    for (let j = 0; j < indices.length; j++) {
      const secrets = secretsList[j]!
      const depositId = normalizeAddress(getDepositId(secrets))
      const hasMint = fulfilledById.has(depositId)
      if (!hasMint) {
        spentFlags.push(false)
      } else {
        const spent = await spentNullifierIsSet(
          vault,
          getSpendAddress(secrets),
          rpc
        )
        spentFlags.push(spent)
      }
    }

    const lockedFlags = indices.map((_, j) =>
      lockedById.has(normalizeAddress(depositIds[j]!))
    )
    const fulfilledFlags = indices.map((_, j) =>
      fulfilledById.has(normalizeAddress(depositIds[j]!))
    )
    ghostVaultActivityDebug(`batch ${b}`, {
      tokenIndices: indices,
      depositLocked: lockedFlags,
      mintFulfilled: fulfilledFlags,
      spentNullifier: spentFlags,
    })

    const batchDrafts: VaultRowDraft[] = []

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
        batchDrafts.push({
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
        batchDrafts.push({
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
        batchDrafts.push({
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

    if (batchDrafts.length > 0) {
      const batchRows = await finalizeDraftsToRows(batchDrafts, rpc)
      mergedRows = mergeVaultRowsSorted(mergedRows, batchRows)
      options?.onProgress?.(mergedRows)
    }

    const batchAny = batchHasAnyVaultActivity(
      depositIds,
      lockedById,
      fulfilledById
    )

    // Progressive loading: update UI after each batch, even if it yielded no new rows.
    options?.onBatchProgress?.(b, mergedRows, indices)
    if (batchAny) {
      consecutiveEmptyBatches = 0
    } else {
      consecutiveEmptyBatches += 1
      if (consecutiveEmptyBatches >= 2) {
        ghostVaultActivityDebug(
          'scan stop: two consecutive batches with no DepositLocked / MintFulfilled',
          { batchIndex: b, tokenIndices: indices }
        )
        break
      }
    }

    if (b === maxBatches - 1) {
      ghostVaultActivityDebug('scan stop: reached maxBatches cap', {
        maxBatches,
        lastBatchTokenIndices: indices,
      })
    }
  }

  ghostVaultActivityDebug('scan done', {
    rowCount: mergedRows.length,
    rows: mergedRows.map((r) => ({
      tokenIndex: r.tokenIndex,
      type: r.type,
      historyLabel: r.historyLabel,
    })),
  })

  return mergedRows
}

/**
 * Largest token index that already has `DepositLocked` or `MintFulfilled` for its
 * derived `depositId`. Returns `-1` if none.
 *
 * **RPC:** Reuses the same in-memory cache and in-flight request as
 * {@link fetchVaultActivityForFirstTokens} (no duplicate `eth_getLogs` sweep when
 * Dashboard already scanned). On cache miss, delegates to that scan (one burst-limited
 * pass with the same stop rule as before).
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
  const cacheKey = getVaultActivityCacheKey(masterSeed, vault, fromBlock)
  const ttl = scanCacheTtlMs()
  const now = Date.now()

  if (ttl > 0) {
    const hit = vaultActivityCache.get(cacheKey)
    if (hit && now - hit.at < ttl) {
      const lastUsed = lastUsedFromVaultActivityRows(hit.rows)
      ghostVaultActivityDebug('findLastUsedVaultTokenIndex: cache hit', {
        lastUsed,
      })
      return lastUsed
    }
  }

  if (inflightActivityKey === cacheKey && inflightActivityPromise) {
    ghostVaultActivityDebug(
      'findLastUsedVaultTokenIndex: awaiting inflight activity fetch'
    )
    const rows = await inflightActivityPromise
    return lastUsedFromVaultActivityRows(rows)
  }

  const rows = await fetchVaultActivityForFirstTokens(masterSeed, {
    contractAddress: options?.contractAddress,
    fromBlock: options?.fromBlock,
    maxBatches: options?.maxBatches,
  })
  return lastUsedFromVaultActivityRows(rows)
}

/**
 * Next token index for a **new** deposit: `max(findLastUsedVaultTokenIndex + 1,
 * {@link GHOST_VAULT_MIN_NEW_DEPOSIT_TOKEN_INDEX})` (privacy pool–style progression;
 * does not reuse skipped lower indices).
 */
export async function getNextVaultTokenIndexForDeposit(
  masterSeed: Uint8Array,
  options?: Pick<
    GhostVaultFetchOptions,
    'contractAddress' | 'fromBlock' | 'maxBatches'
  >
): Promise<number> {
  const last = await findLastUsedVaultTokenIndex(masterSeed, options)
  return Math.max(last + 1, GHOST_VAULT_MIN_NEW_DEPOSIT_TOKEN_INDEX)
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

/** Fire after signing / clearing derived seed (refresh activity, gas, etc.). */
export const GHOST_MASTER_SEED_CHANGED_EVENT = 'ghost:master-seed-changed'

/**
 * Only `VITE_GHOST_MASTER_SEED_HEX` (optional, e.g. CI / dev without a wallet).
 * In normal use `masterSeed` comes from `personal_sign` via `GhostMasterSeedProvider`.
 */
export function getGhostMasterSeedFromEnv(): Uint8Array | null {
  const raw = import.meta.env.VITE_GHOST_MASTER_SEED_HEX as string | undefined
  if (raw == null || String(raw).trim() === '') return null
  const hex = raw.replace(/^0x/i, '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Uint8Array.from(hex.match(/.{2}/g)!.map((x) => parseInt(x, 16)))
}
