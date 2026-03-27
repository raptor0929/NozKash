import { useEffect, useMemo, useRef, useState } from 'react'
import { TARGET_NETWORK_LABEL } from '../lib/ethereum'
import {
  fetchVaultActivityForFirstTokens,
  fetchVaultRowForTokenIndex,
  GHOST_VAULT_ACTIVITY_REFRESH_EVENT,
  GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
  GHOST_VAULT_OPTIMISTIC_PENDING_EVENT,
  GHOST_VAULT_RPC_POLL_MS,
  setGhostVaultLiveActive,
  type GhostVaultOptimisticPendingDetail,
} from '../lib/ghostVault'
import { startGhostVaultActivityLive, getChainWsRpcUrl } from '../lib/ghostVaultLiveActivity'
import type { VaultTx } from '../types/activity'

export function useGhostVaultActivityLive(params: {
  masterSeed: Uint8Array | undefined | null
  seedRevision: number
  network: string
  /**
   * Optional: cap how far the live controller derives tokenIndex mappings.
   * Defaults to the same cap as the HTTP scanner.
   */
  maxBatches?: number
  /**
   * For UI strings (typically equals `TARGET_NETWORK_LABEL` when on the target chain).
   */
  networkLabel: string
}): { rows: VaultTx[]; loading: boolean; error: string | null; scanBatch: number | null } {
  const { masterSeed, seedRevision, network, maxBatches, networkLabel } = params

  const [rows, setRows] = useState<VaultTx[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scanBatch, setScanBatch] = useState<number | null>(null)

  const wsUrl = useMemo(() => getChainWsRpcUrl(), [])

  const controllerRef = useRef<ReturnType<typeof startGhostVaultActivityLive> | null>(null)
  const lastSeedRevisionRef = useRef<number>(seedRevision)
  const optimisticByTokenRef = useRef<Map<number, VaultTx>>(new Map())
  const prioritizeOptimisticTickRef = useRef(true)

  const mergeWithOptimistic = (base: VaultTx[]): VaultTx[] => {
    if (optimisticByTokenRef.current.size === 0) return base
    // Keep optimistic/probed rows sticky while progressive scan runs:
    // partial snapshots may temporarily omit higher token indices.
    const next = [...base]
    for (const [tokenIndex, optimistic] of optimisticByTokenRef.current.entries()) {
      const withoutSameToken = next.filter((r) => r.tokenIndex !== tokenIndex)
      withoutSameToken.unshift(optimistic)
      next.splice(0, next.length, ...withoutSameToken)
    }
    return next
  }

  useEffect(() => {
    let cancelled = false
    controllerRef.current?.stop()
    controllerRef.current = null

    optimisticByTokenRef.current.clear()
    setRows([])
    setError(null)
    setScanBatch(null)

    if (network !== TARGET_NETWORK_LABEL || !masterSeed) {
      setLoading(false)
      setGhostVaultLiveActive(false)
      return () => {
        cancelled = true
      }
    }

    const wsEnabled = Boolean(wsUrl)
    setLoading(true)
    setGhostVaultLiveActive(wsEnabled)
    const seed = masterSeed as Uint8Array

    async function initialLoad() {
      try {
        const rowsForUi = await fetchVaultActivityForFirstTokens(seed, {
          networkLabel,
          onProgress: (r) => {
            if (cancelled) return
            setRows(mergeWithOptimistic(r))
          },
          onBatchProgress: (b) => {
            if (cancelled) return
            setScanBatch(b)
          },
          maxBatches,
        })
        if (cancelled) return

        setRows(mergeWithOptimistic(rowsForUi))
        setLoading(false)
        setScanBatch(null)

        const lastBlock = Math.max(
          -1,
          ...rowsForUi.map((r) => r.blockNumber ?? -1)
        )
        const controller = startGhostVaultActivityLive({
          masterSeed: seed,
          networkLabel,
          initialRows: rowsForUi,
          lastProcessedBlock: lastBlock,
          maxBatches,
          onRows: (next) => {
            if (cancelled) return
            setRows(mergeWithOptimistic(next))
          },
        })
        controllerRef.current = controller
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load vault activity')
        setRows([])
        setLoading(false)
        setScanBatch(null)
      }
    }

    void initialLoad()

    const intervalId = window.setInterval(() => {
      if (cancelled) return
      const optimisticTokens = Array.from(optimisticByTokenRef.current.keys())
      const shouldProbeOptimistic =
        optimisticTokens.length > 0 && prioritizeOptimisticTickRef.current

      if (shouldProbeOptimistic) {
        // Prioritize current optimistic token so Pending -> Deposit/Refunded appears fast.
        const tokenIndex = optimisticTokens[0]!
        prioritizeOptimisticTickRef.current = false
        void (async () => {
          try {
            const row = await fetchVaultRowForTokenIndex(seed, tokenIndex, {
              networkLabel,
            })
            if (!row || cancelled) return
            // Promote optimistic pending to the freshest known real state for this token
            // and keep it sticky while ordered scan catches up.
            optimisticByTokenRef.current.set(tokenIndex, row)
            setRows((prev) => {
              const next = prev.filter((r) => r.tokenIndex !== tokenIndex)
              next.unshift(row)
              return mergeWithOptimistic(next)
            })
          } catch {
            // Best effort.
          }
        })()
        return
      }

      prioritizeOptimisticTickRef.current = true
      // Keep previous behavior when WS is active: avoid full snapshot overwrite.
      if (wsEnabled) return
      void (async () => {
        try {
          const snap = await fetchVaultActivityForFirstTokens(seed, {
            networkLabel,
            maxBatches,
          })
          if (!cancelled) setRows(mergeWithOptimistic(snap))
        } catch {
          // Best effort: keep WS-driven state.
        }
      })()
    }, GHOST_VAULT_RPC_POLL_MS)

    const onRefresh = () => {
      if (wsEnabled) return
      void (async () => {
        try {
          const snap = await fetchVaultActivityForFirstTokens(seed, {
            networkLabel,
            maxBatches,
          })
          if (!cancelled) setRows(mergeWithOptimistic(snap))
        } catch {
          // ignore
        }
      })()
    }
    window.addEventListener(GHOST_VAULT_ACTIVITY_REFRESH_EVENT, onRefresh)
    const onOptimisticPending = (ev: Event) => {
      const d = (ev as CustomEvent<GhostVaultOptimisticPendingDetail>).detail
      if (!d || typeof d.tokenIndex !== 'number') return
      if (network !== TARGET_NETWORK_LABEL) return
      const today = new Date().toISOString().slice(0, 10)
      setRows((prev) => {
        const withoutSameToken = prev.filter(
          (r) =>
            !(
              r.tokenIndex === d.tokenIndex &&
              (r.type === 'Pending' || r.type === 'Deposit')
            )
        )
        const optimistic: VaultTx = {
          id: `vault-pending-optimistic-${d.tokenIndex}-${Date.now()}`,
          type: 'Pending',
          amount: GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
          counterparty: '—',
          txHash: d.txHash,
          dateIso: today,
          time: today,
          historyLabel: `Deposit · pending · token #${d.tokenIndex}`,
          historySub: `Submitted · awaiting mint fulfillment · ${d.networkLabel}`,
          blockNumber: Number.MAX_SAFE_INTEGER,
          tokenIndex: d.tokenIndex,
        }
        optimisticByTokenRef.current.set(d.tokenIndex, optimistic)
        return [optimistic, ...withoutSameToken]
      })
    }
    window.addEventListener(
      GHOST_VAULT_OPTIMISTIC_PENDING_EVENT,
      onOptimisticPending as EventListener
    )

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener(GHOST_VAULT_ACTIVITY_REFRESH_EVENT, onRefresh)
      window.removeEventListener(
        GHOST_VAULT_OPTIMISTIC_PENDING_EVENT,
        onOptimisticPending as EventListener
      )
      controllerRef.current?.stop()
      controllerRef.current = null
      setGhostVaultLiveActive(false)
      lastSeedRevisionRef.current = seedRevision
    }
  }, [network, masterSeed, seedRevision, maxBatches, networkLabel, wsUrl])

  return { rows, loading, error, scanBatch }
}

