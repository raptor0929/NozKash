import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { BottomGhostDecor } from './BottomGhostDecor'
import { DepositConfirmModal } from './eghost/DepositConfirmModal'
import { EgcNavbarLogo } from './eghost/EgcNavbarLogo'
import { SplashScreen } from './eghost/SplashScreen'
import { usePrivacy } from '../context/usePrivacy'
import { loadRedemptionDraft } from '../crypto/ghostRedeem'
import { useWallet, WALLET_BALANCE_POLL_MS } from '../hooks/useWallet'
import {
  getEthereum,
  isTargetEthereumSepolia,
  SEPOLIA_ETH_FAUCET_GCP_URL,
  weiHexToNativeLabel,
} from '../lib/ethereum'
import {
  invalidateVaultActivityCache,
  requestVaultActivityRefresh,
} from '../lib/ghostVault'
import type { LayoutOutletContext } from '../layoutOutletContext'

const AVATAR_PALETTE = ['#3D0F18', '#1A1A3D', '#003D2A', '#4B0082'] as const

function addrInitials(address: string) {
  const hex = address.replace(/^0x/i, '')
  return (hex.slice(0, 2) || '?').toUpperCase()
}

function truncateAddr(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

type MmRow = {
  address: string
  name: string
  addrShort: string
  bal: string
  color: string
  initials: string
}

export function Layout() {
  const { privacyOn, togglePrivacy } = usePrivacy()
  const {
    connectWallet,
    disconnectWallet,
    account,
    accounts,
    network,
  } = useWallet()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [balancesByAddr, setBalancesByAddr] = useState<Record<string, string>>(
    {}
  )
  const [depositModalOpen, setDepositModalOpen] = useState(false)
  const [toast, setToast] = useState<{
    msg: string
    type: 'success' | 'error' | 'info'
    show: boolean
  } | null>(null)

  const pillRef = useRef<HTMLDivElement | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  /** Tracks last connected account for redeem draft → origin refresh. */
  const prevAccountForRedeemDraftRef = useRef<string | null>(null)

  const showToast = useCallback(
    (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
      setToast({ msg, type, show: true })
      window.setTimeout(() => {
        setToast((t) => (t ? { ...t, show: false } : null))
      }, 3200)
    },
    []
  )

  const openDepositModal = useCallback(() => setDepositModalOpen(true), [])

  useEffect(() => {
    const eth = getEthereum()
    if (!eth || accounts.length === 0) return
    let cancelled = false
    const fetchAll = async () => {
      const next: Record<string, string> = {}
      for (const addr of accounts) {
        try {
          const hex = (await eth.request({
            method: 'eth_getBalance',
            params: [addr, 'latest'],
          })) as string
          next[addr] = weiHexToNativeLabel(hex, 'ETH', 4)
        } catch {
          next[addr] = '—'
        }
      }
      if (!cancelled) setBalancesByAddr(next)
    }
    void fetchAll()
    const id = window.setInterval(() => void fetchAll(), WALLET_BALANCE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [accounts, network])

  const walletRows: MmRow[] = useMemo(() => {
    return accounts.map((addr, i) => ({
      address: addr,
      name: 'Connected wallet',
      addrShort: truncateAddr(addr),
      bal: balancesByAddr[addr] ?? '…',
      color: AVATAR_PALETTE[i % AVATAR_PALETTE.length],
      initials: addrInitials(addr),
    }))
  }, [accounts, balancesByAddr])

  const activeWallet = useMemo(
    () => walletRows.find((w) => w.address === account) ?? null,
    [walletRows, account]
  )

  const accountIndex = account ? accounts.findIndex((a) => a === account) : -1
  const pillColor =
    accountIndex >= 0
      ? AVATAR_PALETTE[accountIndex % AVATAR_PALETTE.length]
      : '#3D0F18'
  const pillName =
    account && accountIndex >= 0
      ? truncateAddr(account)
      : accounts[0]
        ? `Connect ${truncateAddr(accounts[0])}`
        : 'Connect Wallet'
  const pillInitials = account ? addrInitials(account) : 'MM'

  useEffect(() => {
    if (!dropdownOpen) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (pillRef.current?.contains(t)) return
      if (dropRef.current?.contains(t)) return
      setDropdownOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [dropdownOpen])

  /**
   * After redeem step 2 (executor wallet), switching back to the prepare/origin wallet
   * should refresh vault activity + next-token index for that account’s seed. We always
   * invalidate here so the origin view is not stuck on stale cache (incl. when WS live
   * mode skips invalidate on generic refresh).
   */
  useEffect(() => {
    const draft = loadRedemptionDraft()
    const prep = draft?.prepareAccount?.toLowerCase()
    const curr = account?.toLowerCase() ?? null
    const prev = prevAccountForRedeemDraftRef.current

    if (
      prep &&
      prev != null &&
      prev !== prep &&
      curr === prep
    ) {
      invalidateVaultActivityCache()
      requestVaultActivityRefresh()
    }

    prevAccountForRedeemDraftRef.current = curr
  }, [account])

  const eyeBorderStyle = privacyOn
    ? { borderColor: 'rgba(0,229,160,.3)' as const }
    : undefined

  return (
    <div className="egc-root">
      <div className="egc-app">
        <SplashScreen />

        {toast && (
          <div className={`toast ${toast.type} ${toast.show ? 'show' : ''}`}>
            {toast.msg}
          </div>
        )}

        <div className="navbar">
          <div className="navbar-left">
            <EgcNavbarLogo />
            {isTargetEthereumSepolia() ? (
              <a
                className="navbar-sepolia-faucet-link"
                href={SEPOLIA_ETH_FAUCET_GCP_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Get Sepolia ETH (opens Google Cloud faucet in a new tab)"
              >
                Sepolia ETH
              </a>
            ) : null}
          </div>
          <div className="navbar-right">
            <button
              type="button"
              className="eye-btn"
              style={eyeBorderStyle}
              onClick={togglePrivacy}
              aria-label={privacyOn ? 'Show amounts' : 'Hide amounts'}
            >
              {privacyOn ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"
                    stroke="var(--green)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M1 1l22 22"
                    stroke="var(--green)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                    stroke="var(--text2)"
                    strokeWidth="1.5"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3"
                    stroke="var(--text2)"
                    strokeWidth="1.5"
                  />
                </svg>
              )}
            </button>

            {!account ? (
              <button
                type="button"
                className="wallet-pill"
                onClick={() => connectWallet()}
              >
                <span className="wallet-name" style={{ maxWidth: 120 }}>
                  {pillName}
                </span>
              </button>
            ) : (
              <div
                ref={pillRef}
                className={`wallet-pill ${dropdownOpen ? 'open' : ''}`}
                onClick={() => setDropdownOpen((o) => !o)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setDropdownOpen((o) => !o)
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div
                  className="wallet-avatar"
                  style={{
                    background: pillColor,
                    color: 'rgba(255,255,255,.7)',
                    fontSize: 9,
                    fontFamily: 'var(--mono)',
                  }}
                >
                  {pillInitials}
                </div>
                <span className="wallet-name">{pillName}</span>
                <svg
                  className="wallet-chevron"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <path
                    d="M2 4l4 4 4-4"
                    stroke="var(--text2)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}
          </div>
        </div>

        <div
          ref={dropRef}
          className={`wallet-dropdown ${dropdownOpen ? '' : 'hidden'}`}
        >
          <div className="wd-header">
            <span className="wd-title">CONNECTED ACCOUNT</span>
          </div>
          <div className="wd-list">
            {!activeWallet ? (
              <div
                className="wd-item"
                style={{
                  cursor: 'default',
                  color: 'var(--text3)',
                  fontSize: 12,
                  fontFamily: 'var(--mono)',
                }}
              >
                No connected account
              </div>
            ) : (
              <div
                key={activeWallet.address}
                className="wd-item active-wallet"
                style={{ cursor: 'default' }}
                role="status"
                aria-live="polite"
                tabIndex={-1}
              >
                <div
                  className="wd-avatar"
                  style={{
                    background: activeWallet.color,
                    color: 'rgba(255,255,255,.8)',
                    fontSize: 10,
                  }}
                >
                  {activeWallet.initials}
                </div>
                <div className="wd-info">
                  <div className="wd-wname">{activeWallet.name}</div>
                  <div className="wd-addr">{activeWallet.addrShort}</div>
                </div>
                <div className="wd-bal">
                  {privacyOn ? '••••' : activeWallet.bal}
                </div>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle
                    cx="8"
                    cy="8"
                    r="7"
                    stroke="var(--history-accent)"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M5 8l2 2 4-4"
                    stroke="var(--history-accent)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}
          </div>
          <div className="wd-divider" />
          <div
            className="wd-action danger"
            role="button"
            tabIndex={0}
            onClick={async () => {
              setDropdownOpen(false)
              await disconnectWallet()
              showToast('Wallet disconnected', 'success')
            }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                setDropdownOpen(false)
                await disconnectWallet()
                showToast('Wallet disconnected', 'success')
              }
            }}
          >
            <div className="wd-action-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"
                  stroke="var(--red2)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="wd-action-text-col">
              <span className="wd-action-label">Disconnect</span>
              <span className="wd-action-sub">Revoke site access in your wallet</span>
            </div>
          </div>
        </div>

        <main className="screen active">
          <Outlet
            context={
              { openDepositModal, showToast } satisfies LayoutOutletContext
            }
          />
        </main>

        <DepositConfirmModal
          open={depositModalOpen}
          onClose={() => setDepositModalOpen(false)}
          onToast={showToast}
        />

        <BottomGhostDecor />
      </div>
    </div>
  )
}
