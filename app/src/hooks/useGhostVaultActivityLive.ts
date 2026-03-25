import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchVaultActivityForFirstTokens,
  GHOST_VAULT_ACTIVITY_REFRESH_EVENT,
  GHOST_VAULT_RPC_POLL_MS,
  setGhostVaultLiveActive,
} from '../lib/ghostVault'
import { startGhostVaultActivityLive, getFujiWsRpcUrl } from '../lib/ghostVaultLiveActivity'
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
   * For UI strings (e.g. "Fuji").
   */
  networkLabel: string
}): { rows: VaultTx[]; loading: boolean; error: string | null; scanBatch: number | null } {
  const { masterSeed, seedRevision, network, maxBatches, networkLabel } = params

  const [rows, setRows] = useState<VaultTx[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scanBatch, setScanBatch] = useState<number | null>(null)

  const wsUrl = useMemo(() => getFujiWsRpcUrl(), [])

  const controllerRef = useRef<ReturnType<typeof startGhostVaultActivityLive> | null>(null)
  const lastSeedRevisionRef = useRef<number>(seedRevision)

  useEffect(() => {
    let cancelled = false
    controllerRef.current?.stop()
    controllerRef.current = null

    setRows([])
    setError(null)
    setScanBatch(null)

    if (network !== 'Fuji' || !masterSeed) {
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
            setRows(r)
          },
          onBatchProgress: (b) => {
            if (cancelled) return
            setScanBatch(b)
          },
          maxBatches,
        })
        if (cancelled) return

        setRows(rowsForUi)
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
            setRows(next)
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
      // When WS is active, we avoid overwriting WS state with a full HTTP snapshot.
      // The live controller already does reconnect backfill when it needs HTTP.
      if (wsEnabled) return
      // Health poll: if cache is valid, this is cheap (no heavy rescan).
      void (async () => {
        try {
          const snap = await fetchVaultActivityForFirstTokens(seed, {
            networkLabel,
            maxBatches,
          })
          if (!cancelled) setRows(snap)
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
          if (!cancelled) setRows(snap)
        } catch {
          // ignore
        }
      })()
    }
    window.addEventListener(GHOST_VAULT_ACTIVITY_REFRESH_EVENT, onRefresh)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener(GHOST_VAULT_ACTIVITY_REFRESH_EVENT, onRefresh)
      controllerRef.current?.stop()
      controllerRef.current = null
      setGhostVaultLiveActive(false)
      lastSeedRevisionRef.current = seedRevision
    }
  }, [network, masterSeed, seedRevision, maxBatches, networkLabel, wsUrl])

  return { rows, loading, error, scanBatch }
}

