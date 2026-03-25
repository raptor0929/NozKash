import { fujiRpcCall, getFujiRpcUrl } from './fujiJsonRpc'
import {
  DEPOSIT_LOCKED_TOPIC,
  GHOST_VAULT_ADDRESS,
  GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
  MINT_FULFILLED_TOPIC,
  ghostVaultMaxScannedTokenIndex,
  vaultDerivedAddressesForIndices,
  ghostVaultActivityDebug,
  GHOST_VAULT_ACTIVITY_MAX_BATCHES,
} from './ghostVault'
import type { VaultTx } from '../types/activity'

type VaultEventKind = 'DepositLocked' | 'MintFulfilled'

type DerivedToken = {
  tokenIndex: number
  depositId: string
  spendAddress: string
}

type LogLike = {
  blockNumber?: string
  transactionHash?: string
  logIndex?: string | number
  topics?: string[]
}

const SPENT_NULLIFIERS_SELECTOR = '0x2b2ba6e8'
const DEFAULT_BACKFILL_CHUNK_SPAN_BLOCKS = 2048

function txShort(hash: string): string {
  if (hash.length > 12) return `${hash.slice(0, 10)}…${hash.slice(-6)}`
  return hash
}

function addrShort(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`
}

function parseHexBlock(n: string | undefined): number {
  if (!n || n === '0x') return 0
  return Number.parseInt(n, 16)
}

function normalizeAddress(a: string): string {
  const h = a.replace(/^0x/i, '').toLowerCase()
  if (h.length !== 40) throw new Error(`Invalid address: ${a}`)
  return `0x${h}`
}

function parseTopic1ToDepositId(topic1: string): string {
  const h = topic1.replace(/^0x/i, '')
  return normalizeAddress(`0x${h.slice(-40)}`)
}

function parseLogId(log: LogLike): string {
  const txh = log.transactionHash ?? ''
  const li = log.logIndex ?? ''
  return `${txh}:${li}`
}

function sortVaultRowsCompare(a: VaultTx, b: VaultTx): number {
  const ba = a.blockNumber ?? -1
  const bb = b.blockNumber ?? -1
  if (bb !== ba) return bb - ba
  return b.id.localeCompare(a.id)
}

export function getFujiWsRpcUrl(): string | null {
  const raw = import.meta.env.VITE_FUJI_WS_RPC_URL as string | undefined
  const u = raw?.trim()
  if (u) return u

  const http = getFujiRpcUrl()
  const m = http.match(/^https?:\/\/([^/]+)\/v3\/(.+)$/i)
  if (!m) return null
  const host = m[1]!
  const projectId = m[2]!
  // Infura pattern: wss://<host>/ws/v3/<projectId>
  return `wss://${host}/ws/v3/${projectId}`
}

async function blockNumberHexToDateIso(blockHex: string): Promise<string> {
  try {
    const block = await fujiRpcCall<{ timestamp?: string } | null>(
      'eth_getBlockByNumber',
      [blockHex, false]
    )
    const ts = block?.timestamp
      ? Number.parseInt(block.timestamp, 16)
      : Math.floor(Date.now() / 1000)
    return new Date(ts * 1000).toISOString().slice(0, 10)
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

async function spentNullifierIsSet(vault: string, spendAddress: string) {
  const addr = normalizeAddress(spendAddress).slice(2)
  const data = (SPENT_NULLIFIERS_SELECTOR + addr.padStart(64, '0')).toLowerCase()
  const result = await fujiRpcCall<string>('eth_call', [
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

type DepositState = {
  depositLocked?: { blockHex: string; txHash?: string }
  mintFulfilled?: { blockHex: string; txHash?: string }
  spent?: boolean
}

function buildRow(params: {
  vaultTxType: 'Pending' | 'Deposit' | 'Redeem'
  tokenIndex: number
  depositId: string
  spendAddress: string
  netLabel: string
  amount: string
  blockHex?: string
  blockNumber?: number
  txHash?: string
  spent?: boolean
  dateIso: string
}): VaultTx {
  const {
    vaultTxType,
    tokenIndex,
    depositId,
    spendAddress,
    netLabel,
    amount,
    blockNumber,
    txHash,
    dateIso,
  } = params

  const bn = blockNumber ?? 0
  const idBase = tokenIndex

  if (vaultTxType === 'Pending') {
    const blindShort = addrShort(depositId)
    const txh = txHash ?? '—'
    return {
      id: `vault-pending-${idBase}`,
      type: 'Pending',
      amount,
      counterparty: blindShort,
      txHash: txh,
      dateIso,
      time: dateIso,
      historyLabel: `Deposit · pending · token #${tokenIndex}`,
      historySub: `DepositLocked · ${txShort(txh)} · block ${
        bn || '?'
      } · ${netLabel}`,
      blockNumber: bn,
      tokenIndex,
    }
  }

  if (vaultTxType === 'Deposit') {
    const spendShort = addrShort(spendAddress)
    const txh = txHash ?? '—'
    return {
      id: `vault-deposit-${idBase}`,
      type: 'Deposit',
      amount,
      counterparty: spendShort,
      txHash: txh,
      dateIso,
      time: dateIso,
      historyLabel: `Deposit · mint fulfilled · token #${tokenIndex}`,
      historySub: `MintFulfilled · ${txShort(txh)} · block ${
        bn || '?'
      } · ${netLabel}`,
      blockNumber: bn,
      tokenIndex,
    }
  }

  // Redeem
  const spendShort = addrShort(spendAddress)
  const txh = txHash ?? '—'
  return {
    id: `vault-redeemed-${idBase}`,
    type: 'Redeem',
    amount,
    counterparty: spendShort,
    txHash: txh,
    dateIso,
    time: dateIso,
    historyLabel: `Redeem · spent · token #${tokenIndex}`,
    historySub: `spentNullifiers[${spendShort}] · block ${bn || '?'} · ${netLabel}`,
    blockNumber: bn,
    tokenIndex,
  }
}

export type GhostVaultLiveActivityController = {
  stop: () => void
}

/**
 * Incremental vault activity updates using WS logs subscriptions.
 *
 * v1 behavior:
 * - Bootstrap state is provided by caller (initial rows).
 * - WS pushes updates; we update only affected token rows.
 * - On reconnect, we backfill missed logs via HTTP `eth_getLogs` (chunked).
 */
export function startGhostVaultActivityLive(params: {
  masterSeed: Uint8Array
  /**
   * Network label used in UI strings (e.g. "Fuji").
   * Only works reliably when you're on that same chain.
   */
  networkLabel: string
  initialRows: VaultTx[]
  /**
   * Highest block already reflected in `initialRows`.
   * Backfill runs from `lastProcessedBlock + 1`.
   */
  lastProcessedBlock: number
  /**
   * Optional: cap how far we derive depositId mappings (tokenIndex range).
   * If a WS log depositId is outside this range it will be ignored.
   */
  maxBatches?: number
  /**
   * Optional: override contract address.
   */
  contractAddress?: string
  /**
   * Called with a fully re-sorted rows array after each incremental update.
   */
  onRows: (rows: VaultTx[]) => void
}): GhostVaultLiveActivityController {
  const {
    masterSeed,
    networkLabel,
    initialRows,
    lastProcessedBlock,
    maxBatches,
    contractAddress,
    onRows,
  } = params

  const vault = normalizeAddress(contractAddress ?? GHOST_VAULT_ADDRESS)
  const effectiveMaxBatches =
    maxBatches != null && maxBatches > 0
      ? Math.min(maxBatches, GHOST_VAULT_ACTIVITY_MAX_BATCHES)
      : GHOST_VAULT_ACTIVITY_MAX_BATCHES
  const maxTokenIndex = ghostVaultMaxScannedTokenIndex(effectiveMaxBatches)

  const tokenIndexToDepositId = new Map<number, string>()
  const tokenIndexToSpendAddress = new Map<number, string>()
  const depositIdToTokenIndex = new Map<string, number>()

  // Pre-derive depositId/spendAddress mappings so we can map WS events -> tokenIndex.
  // Chunked to keep peak allocations reasonable.
  const CHUNK = 2000
  for (let start = 0; start <= maxTokenIndex; start += CHUNK) {
    const end = Math.min(maxTokenIndex, start + CHUNK - 1)
    const indices: number[] = []
    for (let i = start; i <= end; i++) indices.push(i)
    const derived: DerivedToken[] = vaultDerivedAddressesForIndices(
      masterSeed,
      indices
    )
    for (const d of derived) {
      tokenIndexToDepositId.set(d.tokenIndex, d.depositId)
      tokenIndexToSpendAddress.set(d.tokenIndex, d.spendAddress)
      depositIdToTokenIndex.set(d.depositId, d.tokenIndex)
    }
  }

  const tokenIndexToRow = new Map<number, VaultTx>()
  for (const r of initialRows) {
    if (r.tokenIndex == null) continue
    tokenIndexToRow.set(r.tokenIndex, r)
  }

  const depositStates = new Map<string, DepositState>()
  const spentCache = new Map<string, boolean>()
  const spentInFlight = new Set<string>()

  // Cache block timestamps to reduce extra HTTP calls for each WS event.
  const blockDateCache = new Map<string, string>()

  const processedLogIds = new Set<string>()

  let lastAppliedBlock = lastProcessedBlock
  let stopped = false

  // Basic event loop coalescing for state updates.
  let emitTimer: number | null = null
  function scheduleEmit(): void {
    if (emitTimer != null) return
    emitTimer = window.setTimeout(() => {
      emitTimer = null
      const rows = [...tokenIndexToRow.values()].sort(sortVaultRowsCompare)
      onRows(rows)
    }, 100)
  }

  async function ensureBlockDateIso(blockHex: string): Promise<string> {
    const hit = blockDateCache.get(blockHex)
    if (hit) return hit
    const iso = await blockNumberHexToDateIso(blockHex)
    blockDateCache.set(blockHex, iso)
    return iso
  }

  function upsertDepositState(depositId: string): DepositState {
    const n = depositId
    const existing = depositStates.get(n)
    if (existing) return existing
    const next: DepositState = {}
    depositStates.set(n, next)
    return next
  }

  async function recomputeTokenRow(tokenIndex: number): Promise<void> {
    const depositId = tokenIndexToDepositId.get(tokenIndex)
    const spendAddress = tokenIndexToSpendAddress.get(tokenIndex)
    if (!depositId || !spendAddress) return
    const st = depositStates.get(depositId)
    const amount = GHOST_VAULT_DEPOSIT_AMOUNT_LABEL
    const depot = st ?? {}

    let rowType: 'Pending' | 'Deposit' | 'Redeem'
    let selectedBlockHex: string | undefined
    let txHash: string | undefined
    let blockNumber: number | undefined

    if (depot.mintFulfilled) {
      selectedBlockHex = depot.mintFulfilled.blockHex
      txHash = depot.mintFulfilled.txHash
      blockNumber = parseHexBlock(selectedBlockHex)
      rowType = depot.spent ? 'Redeem' : 'Deposit'
    } else if (depot.depositLocked) {
      selectedBlockHex = depot.depositLocked.blockHex
      txHash = depot.depositLocked.txHash
      blockNumber = parseHexBlock(selectedBlockHex)
      rowType = 'Pending'
    } else {
      // No longer tracked for this tokenIndex (should be rare).
      tokenIndexToRow.delete(tokenIndex)
      scheduleEmit()
      return
    }

    if (!selectedBlockHex) return
    const dateIso = await ensureBlockDateIso(selectedBlockHex)
    if (st == null) return

    const row = buildRow({
      vaultTxType: rowType,
      tokenIndex,
      depositId,
      spendAddress,
      netLabel: networkLabel,
      amount,
      blockHex: selectedBlockHex,
      blockNumber,
      txHash,
      dateIso,
      spent: depot.spent,
    })
    tokenIndexToRow.set(tokenIndex, row)
    scheduleEmit()
  }

  async function handleDepositLockedLog(log: LogLike): Promise<void> {
    const topics = log.topics ?? []
    const topic1 = topics[1]
    const bnHex = log.blockNumber
    if (!topic1 || !bnHex) return

    const depositId = parseTopic1ToDepositId(topic1)
    const tokenIndex = depositIdToTokenIndex.get(depositId)
    if (tokenIndex == null) return

    const logId = parseLogId(log)
    if (processedLogIds.has(logId)) return
    processedLogIds.add(logId)

    const bn = parseHexBlock(bnHex)
    if (bn <= lastAppliedBlock) return
    lastAppliedBlock = bn

    const st = upsertDepositState(depositId)
    st.depositLocked = {
      blockHex: bnHex,
      txHash: log.transactionHash,
    }

    // If MintFulfilled is already known we may also need to flip Deposit <-> Redeem.
    await recomputeTokenRow(tokenIndex)
  }

  async function handleMintFulfilledLog(log: LogLike): Promise<void> {
    const topics = log.topics ?? []
    const topic1 = topics[1]
    const bnHex = log.blockNumber
    if (!topic1 || !bnHex) return

    const depositId = parseTopic1ToDepositId(topic1)
    const tokenIndex = depositIdToTokenIndex.get(depositId)
    if (tokenIndex == null) return

    const logId = parseLogId(log)
    if (processedLogIds.has(logId)) return
    processedLogIds.add(logId)

    const bn = parseHexBlock(bnHex)
    if (bn <= lastAppliedBlock) return
    lastAppliedBlock = bn

    const st = upsertDepositState(depositId)
    st.mintFulfilled = {
      blockHex: bnHex,
      txHash: log.transactionHash,
    }

    // Ensure spent status is known (Redeem vs Deposit).
    if (st.spent === undefined && !spentInFlight.has(depositId)) {
      spentInFlight.add(depositId)
      void (async () => {
        try {
          const spendAddress = tokenIndexToSpendAddress.get(tokenIndex)
          if (!spendAddress) return
          const spent = await spentNullifierIsSet(vault, spendAddress)
          spentCache.set(depositId, spent)
          st.spent = spent
        } finally {
          spentInFlight.delete(depositId)
        }
        await recomputeTokenRow(tokenIndex)
      })()
    }

    // Optimistic: if spent unknown, show Deposit until eth_call resolves.
    await recomputeTokenRow(tokenIndex)
  }

  // (v1) We backfill per topic0 using `eth_getLogs` chunking.

  async function backfillFrom(fromBn: number): Promise<void> {
    if (stopped) return
    if (fromBn < 0) fromBn = 0
    const headHex = await fujiRpcCall<string>('eth_blockNumber', [])
    const toBn = parseHexBlock(headHex)
    if (fromBn > toBn) return

    for (const [topic0, handler] of [
      [DEPOSIT_LOCKED_TOPIC, handleDepositLockedLog],
      [MINT_FULFILLED_TOPIC, handleMintFulfilledLog],
    ] as const) {
      for (
        let cur = fromBn;
        cur <= toBn;
        cur += DEFAULT_BACKFILL_CHUNK_SPAN_BLOCKS
      ) {
        const end = Math.min(toBn, cur + DEFAULT_BACKFILL_CHUNK_SPAN_BLOCKS - 1)
        const hexFrom = `0x${cur.toString(16)}`
        const hexTo = `0x${end.toString(16)}`
        let logs: LogLike[] = []
        try {
          logs = (await fujiRpcCall<LogLike[]>('eth_getLogs', [
            { address: vault, topics: [topic0], fromBlock: hexFrom, toBlock: hexTo },
          ])) as LogLike[]
        } catch {
          // Backfill should be best-effort; WS will catch the tail.
          logs = []
        }
        if (!logs.length) continue
        for (const l of logs) {
          if (stopped) return
          await handler(l)
        }
      }
    }
  }

  // Seed depositStates from initial rows so future WS updates can recompute without extra RPC.
  for (const r of initialRows) {
    if (r.tokenIndex == null) continue
    const depositId = tokenIndexToDepositId.get(r.tokenIndex)
    const spendAddress = tokenIndexToSpendAddress.get(r.tokenIndex)
    if (!depositId || !spendAddress) continue
    const st = upsertDepositState(depositId)
    const bn = r.blockNumber ?? 0
    const blockHex = bn > 0 ? `0x${bn.toString(16)}` : undefined

    if (r.type === 'Pending' && blockHex) {
      st.depositLocked = { blockHex, txHash: r.txHash }
    } else if (r.type === 'Deposit' && blockHex) {
      st.mintFulfilled = { blockHex, txHash: r.txHash }
      st.spent = false
    } else if (r.type === 'Redeem' && blockHex) {
      st.mintFulfilled = { blockHex, txHash: r.txHash }
      st.spent = true
    }
  }

  const wsUrl = getFujiWsRpcUrl()
  if (!wsUrl) {
    // No WS configured (or provider doesn’t support WS URL derivation).
    ghostVaultActivityDebug(
      'ghostVault live: no WS URL configured; running HTTP-only'
    )
    // Still return a controller so callers can stop gracefully.
    return {
      stop: () => {
        stopped = true
      },
    }
  }

  const wsUrlSafe: string = wsUrl
  let ws: WebSocket | null = null
  let reconnectAttempt = 0
  const maxReconnectAttempts = 20
  let reconnectTimer: number | null = null

  function scheduleReconnect(): void {
    if (stopped) return
    if (reconnectAttempt >= maxReconnectAttempts) return
    reconnectAttempt += 1
    const delay = Math.min(30_000, 800 * 2 ** reconnectAttempt)
    reconnectTimer = window.setTimeout(() => void connect(), delay)
  }

  async function connect(): Promise<void> {
    if (stopped) return
    if (ws) return

    const socket = new WebSocket(wsUrlSafe)
    ws = socket

    const subs = new Map<string, VaultEventKind>()
    let jsonId = 1
    const depositSubId = jsonId++
    const mintSubId = jsonId++

    const depositSubFilter = {
      address: vault,
      topics: [DEPOSIT_LOCKED_TOPIC],
    }
    const mintSubFilter = {
      address: vault,
      topics: [MINT_FULFILLED_TOPIC],
    }

    socket.onopen = () => {
      reconnectAttempt = 0
      ghostVaultActivityDebug('ghostVault live: WS connected', { wsUrlSafe })
      // Backfill first so state jumps directly to “current”
      void backfillFrom(lastAppliedBlock + 1).finally(() => {
        if (stopped) return
      })

      void socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: depositSubId,
          method: 'eth_subscribe',
          params: ['logs', depositSubFilter],
        })
      )
      void socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: mintSubId,
          method: 'eth_subscribe',
          params: ['logs', mintSubFilter],
        })
      )
    }

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as any
        if (msg?.method === 'eth_subscription') {
          const subId = msg?.params?.subscription as string
          const kind = subs.get(subId)
          const res = msg?.params?.result as LogLike | undefined
          if (!res || !kind) return
          if (kind === 'DepositLocked') void handleDepositLockedLog(res)
          if (kind === 'MintFulfilled') void handleMintFulfilledLog(res)
        } else if (msg?.result && typeof msg?.id === 'number') {
          const id = msg.id as number
          if (id === depositSubId) subs.set(msg.result, 'DepositLocked')
          if (id === mintSubId) subs.set(msg.result, 'MintFulfilled')
        }
      } catch {
        // Ignore malformed frames.
      }
    }

    socket.onerror = () => {
      ghostVaultActivityDebug('ghostVault live: WS error')
      scheduleReconnect()
    }

    socket.onclose = () => {
      ws = null
      ghostVaultActivityDebug('ghostVault live: WS closed')
      if (!stopped) scheduleReconnect()
    }
  }

  void connect()

  return {
    stop: () => {
      stopped = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      reconnectTimer = null
      if (ws) {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
      ws = null
    },
  }
}

