import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  buildRedemptionDraftFromSeed,
  isHomeRedeemReady,
  loadRedemptionDraft,
  saveRedemptionDraft,
  type RedemptionDraftV1,
} from '../crypto/ghostRedeem'
import { useGhostMasterSeed } from '../context/GhostMasterSeedProvider'
import { usePrivacy } from '../context/usePrivacy'
import {
  requestWalletBalanceRefresh,
  useWallet,
} from '../hooks/useWallet'
import { DateRangePill } from '../components/DateRangePill'
import { deriveTokenSecrets, getDepositId } from '../crypto/ghost-library'
import {
  getEthereum,
  NATIVE_CURRENCY_SYMBOL,
  targetChainMismatchUserMessage,
  TARGET_NETWORK_LABEL,
} from '../lib/ethereum'
import {
  ACTIVITY_TYPE_FILTERS,
  filterVaultActivity,
  formatTxAmountDisplay,
} from '../lib/historyQuery'
import { sendVaultRedeemTransaction } from '../lib/sendVaultRedeem'
import { sendVaultRefundTransaction } from '../lib/sendVaultRefund'
import { isStartRedeemVisible, shouldShowRedeemHere } from '../lib/redeemUiGates'
import { mergeVaultRowsWithRedeemDraft } from '../lib/vaultRedeemMerge'
import { useGhostVaultActivityLive } from '../hooks/useGhostVaultActivityLive'
import type { LayoutOutletContext } from '../layoutOutletContext'
import type { ActivityKind, HistoryFilterType, VaultTx } from '../types/activity'

/** Matches `GHOST_VAULT_DEPOSIT_AMOUNT_LABEL` (0.001 ETH per deposit). */
const VAULT_DENOMINATION_ETH = 0.001

function kindToClass(k: ActivityKind) {
  switch (k) {
    case 'Deposit':
      return 'deposit'
    case 'Redeem':
      return 'redeem'
    case 'Pending':
      return 'pending'
    case 'Refunded':
      return 'refunded'
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
  if (cls === 'refunded') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 12h16M8 8l-4 4 4 4"
          stroke="var(--text2)"
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
  const { network, account, homeBalanceMain } = useWallet()
  const { openDepositModal, showToast } =
    useOutletContext<LayoutOutletContext>()

  const [redemptionDraft, setRedemptionDraft] = useState<RedemptionDraftV1 | null>(
    () => loadRedemptionDraft()
  )
  const [redeemingId, setRedeemingId] = useState<string | null>(null)
  const [refundingId, setRefundingId] = useState<string | null>(null)
  const [startingRedeemId, setStartingRedeemId] = useState<string | null>(null)
  const [changeWalletModalOpen, setChangeWalletModalOpen] = useState(false)

  const [activeFilter, setActiveFilter] =
    useState<HistoryFilterType>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterWrapRef = useRef<HTMLDivElement>(null)
  const { rows: vaultChainRows, loading: vaultLoading, scanBatch } = useGhostVaultActivityLive({
    masterSeed: effectiveMasterSeed,
    seedRevision,
    network,
    networkLabel:
      network === TARGET_NETWORK_LABEL ? TARGET_NETWORK_LABEL : network,
  })

  useEffect(() => {
    setRedemptionDraft(loadRedemptionDraft())
  }, [account, seedRevision])

  // Vault activity is loaded/updated via `useGhostVaultActivityLive`.

  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      const el = filterWrapRef.current
      if (el && !el.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [filterOpen])

  /** Includes a synthetic row if there is a redeem draft and the active account is the executor (≠ prepareAccount). */
  const displayRows = useMemo(
    () =>
      mergeVaultRowsWithRedeemDraft(vaultChainRows, redemptionDraft, account),
    [vaultChainRows, redemptionDraft, account]
  )

  const filtered = useMemo(() => {
    const list = filterVaultActivity(
      displayRows,
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
  }, [activeFilter, dateFrom, dateTo, displayRows])

  const homeStats = useMemo(() => {
    const validCount = vaultChainRows.filter((r) => r.type === 'Deposit').length
    const spentCount = vaultChainRows.filter((r) => r.type === 'Redeem').length
    return {
      validCount,
      spentCount,
      validEth: `${(validCount * VAULT_DENOMINATION_ETH).toFixed(3)} ETH`,
      spentEth: `${(spentCount * VAULT_DENOMINATION_ETH).toFixed(3)} ETH`,
    }
  }, [vaultChainRows])

  const clearDates = () => {
    setDateFrom('')
    setDateTo('')
  }

  const handleStartRedeem = (item: VaultTx) => {
    if (item.tokenIndex === undefined || !effectiveMasterSeed) {
      showToast('Unlock the vault (sign) to prepare redeem.', 'error')
      return
    }
    if (!account) {
      showToast('Connect your wallet first.', 'error')
      return
    }
    if (network !== TARGET_NETWORK_LABEL) {
      showToast(targetChainMismatchUserMessage(), 'error')
      return
    }
    setStartingRedeemId(item.id)
    try {
      const draft = buildRedemptionDraftFromSeed(
        effectiveMasterSeed,
        item.tokenIndex,
        account
      )
      saveRedemptionDraft(draft)
      setRedemptionDraft(draft)
      setChangeWalletModalOpen(true)
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : 'Could not prepare redeem',
        'error'
      )
    } finally {
      setStartingRedeemId(null)
    }
  }

  const handleRefund = async (item: VaultTx) => {
    if (item.type !== 'Pending' || item.tokenIndex === undefined) return
    if (!effectiveMasterSeed) {
      showToast('Unlock the vault (sign) to refund.', 'error')
      return
    }
    if (!account) {
      showToast('Connect your wallet first.', 'error')
      return
    }
    if (network !== TARGET_NETWORK_LABEL) {
      showToast(targetChainMismatchUserMessage(), 'error')
      return
    }
    const ethereum = getEthereum()
    if (!ethereum) {
      showToast('No Ethereum wallet found', 'error')
      return
    }
    setRefundingId(item.id)
    try {
      const secrets = deriveTokenSecrets(effectiveMasterSeed, item.tokenIndex)
      const depositId = getDepositId(secrets)
      await sendVaultRefundTransaction({ ethereum, depositId })
      requestWalletBalanceRefresh()
      showToast('Refund confirmed · ETH returned to this wallet', 'success')
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string }
      if (e?.code === 4001) {
        showToast('Transaction cancelled in your wallet', 'error')
        return
      }
      const msg =
        typeof e?.message === 'string' ? e.message : 'Could not refund deposit'
      if (/user rejected|denied/i.test(msg)) {
        showToast('Transaction cancelled in your wallet', 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setRefundingId(null)
    }
  }

  const handleHomeRedeem = async (item: VaultTx) => {
    if (!account || item.tokenIndex === undefined) return
    const draft = loadRedemptionDraft()
    if (!draft || !isHomeRedeemReady(item, draft, account)) return

    const ethereum = getEthereum()
    if (!ethereum) {
      showToast('No Ethereum wallet found', 'error')
      return
    }

    setRedeemingId(item.id)
    try {
      await sendVaultRedeemTransaction({
        ethereum,
        recipient: account,
        draft,
        masterSeed: effectiveMasterSeed,
      })
      requestWalletBalanceRefresh()
      showToast('Redeem confirmed · funds sent to this account', 'success')
      setRedemptionDraft(null)
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string }
      if (e?.code === 4001) {
        showToast('Transaction cancelled in your wallet', 'error')
        return
      }
      const msg =
        typeof e?.message === 'string' ? e.message : 'Could not complete redeem'
      if (/user rejected|denied/i.test(msg)) {
        showToast('Transaction cancelled in your wallet', 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setRedeemingId(null)
    }
  }

  const balStr = homeBalanceMain ?? '—'

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
          </div>
          <div className="balance-stats-col">
            <div className="stat-block">
              <div className="stat-block-row">
                <span className="stat-block-label valid">AVAILABLE</span>
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
            <div className="add-deposit-sub">Shield ETH · {network}</div>
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
          {scanBatch != null ? (
            <div className="no-results">
              Loading activity · batch {scanBatch + 1}…
            </div>
          ) : null}

          {filtered.length === 0 ? (
            scanBatch == null && vaultLoading ? (
              <div className="no-results">Loading activity…</div>
            ) : scanBatch == null ? (
              <div className="no-results">No transactions found</div>
            ) : null
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
                    {item.type === 'Pending' ? (
                      <div className="activity-redeem-actions">
                        {effectiveMasterSeed ? (
                          <button
                            type="button"
                            className="history-redeem-btn history-redeem-btn--secondary"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                            disabled={
                              refundingId === item.id ||
                              redeemingId === item.id ||
                              startingRedeemId === item.id ||
                              network !== TARGET_NETWORK_LABEL
                            }
                            onClick={() => void handleRefund(item)}
                          >
                            {refundingId === item.id ? 'Refunding…' : 'Refund'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {item.type === 'Deposit' ? (
                      <div className="activity-redeem-actions">
                        {isStartRedeemVisible(
                          account,
                          redemptionDraft,
                          item
                        ) &&
                          effectiveMasterSeed && (
                            <button
                              type="button"
                              className="history-redeem-btn history-redeem-btn--secondary"
                              disabled={
                                startingRedeemId === item.id ||
                                redeemingId === item.id ||
                                network !== TARGET_NETWORK_LABEL
                              }
                              onClick={() => handleStartRedeem(item)}
                            >
                              {startingRedeemId === item.id
                                ? 'Saving…'
                                : 'Start redeem'}
                            </button>
                          )}
                        {shouldShowRedeemHere(
                          account,
                          isHomeRedeemReady(
                            item,
                            redemptionDraft,
                            account
                          )
                        ) && (
                          <button
                            type="button"
                            className="history-redeem-btn"
                            disabled={
                              redeemingId === item.id ||
                              network !== TARGET_NETWORK_LABEL
                            }
                            onClick={() => void handleHomeRedeem(item)}
                          >
                            {redeemingId === item.id
                              ? 'Sending…'
                              : 'Redeem here'}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {changeWalletModalOpen ? (
        <div
          className="modal-overlay open"
          style={{ zIndex: 220 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="change-wallet-redeem-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChangeWalletModalOpen(false)
          }}
        >
          <div
            className="modal-sheet"
            style={{ paddingBottom: 24, maxWidth: 400 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-handle" />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <span
                id="change-wallet-redeem-title"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 14,
                  color: 'var(--text)',
                  letterSpacing: '0.5px',
                }}
              >
                Change wallet
              </span>
              <button
                type="button"
                className="import-close"
                onClick={() => setChangeWalletModalOpen(false)}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="var(--text2)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <p
              className="modal-sub-label"
              style={{ marginBottom: 16, lineHeight: 1.45 }}
            >
              In your wallet, switch to the account that will{' '}
              <strong>pay gas</strong> and <strong>receive</strong> the 0.001{' '}
              {NATIVE_CURRENCY_SYMBOL}
              (e.g. Account 2). When you come back to this page,{' '}
              <strong>Redeem here</strong> will appear on the mint row.
            </p>
            <button
              type="button"
              className="btn-full"
              onClick={() => setChangeWalletModalOpen(false)}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}

    </div>
  )
}
