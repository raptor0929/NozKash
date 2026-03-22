import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useGhostMasterSeed } from '../context/GhostMasterSeedProvider'
import { usePrivacy } from '../context/usePrivacy'
import { useRedeemSign } from '../hooks/useRedeemSign'
import { useWallet } from '../hooks/useWallet'
import { DateRangePill } from '../components/DateRangePill'
import {
  ACTIVITY_TYPE_FILTERS,
  filterVaultActivity,
  formatTxAmountDisplay,
  redeemSignMessageForTx,
} from '../lib/historyQuery'
import {
  fetchVaultActivityForFirstTokens,
  GHOST_VAULT_RPC_POLL_MS,
} from '../lib/ghostVault'
import type { LayoutOutletContext } from '../layoutOutletContext'
import type { ActivityKind, HistoryFilterType, VaultTx } from '../types/activity'

/** Coincide con `GHOST_VAULT_DEPOSIT_AMOUNT_LABEL` (0.01 AVAX por depósito). */
const VAULT_DENOMINATION_AVAX = 0.01

function kindToClass(k: ActivityKind) {
  switch (k) {
    case 'Deposit':
      return 'deposit'
    case 'Redeem':
      return 'redeem'
    case 'Pending':
      return 'pending'
  }
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const cls = kindToClass(kind)
  if (cls === 'deposit') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 5v14M5 12l7 7 7-7"
          stroke="var(--green)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (cls === 'redeem') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 19V5M5 12l7-7 7 7"
          stroke="var(--red2)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="var(--yellow)" strokeWidth="2" />
      <path d="M12 6v6l4 2" stroke="var(--yellow)" strokeWidth="2" />
    </svg>
  )
}

function FilterFunnelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16M7 12h10M10 18h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Dashboard() {
  const { privacyOn } = usePrivacy()
  const { effectiveMasterSeed, seedRevision } = useGhostMasterSeed()
  const { network, account, homeBalanceMain, homeBalanceUsd } = useWallet()
  const { openDepositModal, showToast } =
    useOutletContext<LayoutOutletContext>()
  const { signingId, redeemPhase, signRedeem } = useRedeemSign(showToast)

  const [activeFilter, setActiveFilter] =
    useState<HistoryFilterType>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterWrapRef = useRef<HTMLDivElement>(null)
  const [vaultChainRows, setVaultChainRows] = useState<VaultTx[]>([])

  const seedRef = useRef(effectiveMasterSeed)
  const networkRef = useRef(network)
  seedRef.current = effectiveMasterSeed
  networkRef.current = network

  useEffect(() => {
    let cancelled = false
    const clearRows = () => {
      queueMicrotask(() => {
        if (!cancelled) setVaultChainRows([])
      })
    }

    if (network !== 'Fuji') {
      clearRows()
      return () => {
        cancelled = true
      }
    }
    if (!effectiveMasterSeed) {
      clearRows()
      return () => {
        cancelled = true
      }
    }

    setVaultChainRows([])

    async function loadVault() {
      if (cancelled) return
      const net = networkRef.current
      const seed = seedRef.current
      if (net !== 'Fuji' || !seed) {
        if (!cancelled) setVaultChainRows([])
        return
      }
      try {
        const rows = await fetchVaultActivityForFirstTokens(seed, {
          networkLabel: net,
        })
        if (!cancelled) setVaultChainRows(rows)
      } catch (e) {
        console.error('GhostVault activity fetch', e)
        if (!cancelled) setVaultChainRows([])
      }
    }

    const intervalId = window.setInterval(() => {
      void loadVault()
    }, GHOST_VAULT_RPC_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [network, seedRevision, account, !!effectiveMasterSeed])

  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      const el = filterWrapRef.current
      if (el && !el.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [filterOpen])

  const filtered = useMemo(() => {
    const list = filterVaultActivity(
      vaultChainRows,
      activeFilter,
      dateFrom,
      dateTo
    )
    return [...list].sort((a, b) => {
      const d = b.dateIso.localeCompare(a.dateIso)
      if (d !== 0) return d
      const ba = a.blockNumber ?? -1
      const bb = b.blockNumber ?? -1
      if (bb !== ba) return bb - ba
      return b.id.localeCompare(a.id)
    })
  }, [activeFilter, dateFrom, dateTo, vaultChainRows])

  const homeStats = useMemo(() => {
    const validCount = vaultChainRows.filter((r) => r.type === 'Deposit').length
    const spentCount = vaultChainRows.filter((r) => r.type === 'Redeem').length
    return {
      validCount,
      spentCount,
      validEth: `${(validCount * VAULT_DENOMINATION_AVAX).toFixed(2)} AVAX`,
      spentEth: `${(spentCount * VAULT_DENOMINATION_AVAX).toFixed(2)} AVAX`,
    }
  }, [vaultChainRows])

  const clearDates = () => {
    setDateFrom('')
    setDateTo('')
  }

  const balStr = homeBalanceMain ?? '—'
  const usdStr = homeBalanceUsd ?? '—'

  return (
    <div className="page-inner page-inner--home">
      <div className="balance-card">
        <div className="balance-card-top">
          <div className="balance-label">PRIVATE BALANCE</div>
          <div className={`shield-badge ${privacyOn ? 'on' : 'off'}`}>
            <span className={`shield-dot ${privacyOn ? '' : 'off'}`} />
            <span>{privacyOn ? 'SHIELDED' : 'HIDDEN'}</span>
          </div>
        </div>
        <div className="balance-cols">
          <div className="balance-main">
            <div className="balance-amount">
              {privacyOn ? '••••' : balStr}
            </div>
            <div className="balance-usd">
              {privacyOn ? '••••' : usdStr}
            </div>
          </div>
          <div className="balance-stats-col">
            <div className="stat-block">
              <div className="stat-block-row">
                <span className="stat-block-label valid">VALID</span>
                <span className="stat-block-num valid">
                  {privacyOn ? '••' : homeStats.validCount}
                </span>
              </div>
              <div className="stat-block-eth">
                {privacyOn ? '••••' : homeStats.validEth}
              </div>
            </div>
            <div className="stat-block">
              <div className="stat-block-row">
                <span className="stat-block-label spent">SPENT</span>
                <span className="stat-block-num spent">
                  {privacyOn ? '••' : homeStats.spentCount}
                </span>
              </div>
              <div className="stat-block-eth">
                {privacyOn ? '••••' : homeStats.spentEth}
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="add-deposit-btn"
        onClick={() => openDepositModal()}
      >
        <div className="add-deposit-left">
          <div className="add-deposit-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 5v14M5 12h14"
                stroke="var(--text2)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <div className="add-deposit-label">Add deposit</div>
            <div className="add-deposit-sub">Shield AVAX · {network}</div>
          </div>
        </div>
        <span className="add-deposit-badge">+ MINT</span>
      </button>

      <div className="home-activity-block">
        <div className="section-title home-activity-title">Activity</div>
        <div className="home-date-toolbar">
          <DateRangePill
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            onClear={clearDates}
            className="date-range-pill--toolbar"
          />
          <div className="home-filter-wrap" ref={filterWrapRef}>
            <button
              type="button"
              className="home-filter-btn home-filter-btn--toolbar"
              aria-expanded={filterOpen}
              aria-haspopup="menu"
              aria-label="Filter by type"
              onClick={() => setFilterOpen((o) => !o)}
            >
              <FilterFunnelIcon />
            </button>
            {filterOpen ? (
              <div className="home-filter-pop" role="menu">
                {ACTIVITY_TYPE_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    role="menuitem"
                    className={`home-filter-option${activeFilter === f.key ? ' active' : ''}`}
                    onClick={() => {
                      setActiveFilter(f.key)
                      setFilterOpen(false)
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div>
          {filtered.length === 0 ? (
            <div className="no-results">No transactions found</div>
          ) : (
            filtered.map((item) => {
              const ic = kindToClass(item.type)
              const amt = formatTxAmountDisplay(item)
              return (
                <div key={item.id} className="activity-item">
                  <div className="activity-left">
                    <div className={`activity-icon ${ic}`}>
                      <ActivityIcon kind={item.type} />
                    </div>
                    <div className="activity-text">
                      <div className="activity-type">{item.historyLabel}</div>
                      <div className="activity-time">{item.historySub}</div>
                    </div>
                  </div>
                  <div className="activity-right-col">
                    <span
                      className={`activity-amount ${ic} bal-amount`}
                      data-val={amt}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {privacyOn ? '••••' : amt}
                    </span>
                    {item.type === 'Deposit' && (
                      <button
                        type="button"
                        className="history-redeem-btn"
                        disabled={signingId === item.id}
                        onClick={() =>
                          signRedeem(
                            item.id,
                            redeemSignMessageForTx(item)
                          )
                        }
                      >
                        {signingId === item.id
                          ? redeemPhase === 'account'
                            ? 'Account…'
                            : 'Signing…'
                          : 'Redeem'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
