import { useEffect, useState } from 'react'
import { useWallet } from '../../hooks/useWallet'
import {
  ensureFuji,
  estimateSimpleTransferGasNative,
  getEthereum,
  parseEthAddressList,
  waitForTransactionReceipt,
} from '../../lib/ethereum'
import { avaxDecimalStringToWeiHex } from '../../lib/avaxWei'

const PLACEHOLDER_TO = '0x0000000000000000000000000000000000000001'

/** Quick amounts; only `SUPPORTED_DEPOSIT_AVAX` is enabled until arbitrary amounts ship. */
const DEPOSIT_PRESETS = ['0.001', '0.01', '0.1', '1'] as const

const DEFAULT_AMOUNT = '0.01'
const SUPPORTED_DEPOSIT_AVAX = '0.01'
const SUPPORTED_DEPOSIT_WEI = 10n ** 16n // 0.01 * 10^18

const NOT_SUPPORTED_YET_MSG = 'Not supported yet'

type Props = {
  open: boolean
  onClose: () => void
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

/** Digits and at most one decimal point; max 18 fractional digits. */
function sanitizeAvaxInput(raw: string): string {
  let s = raw.replace(/[^\d.]/g, '')
  const dot = s.indexOf('.')
  if (dot !== -1) {
    s =
      s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '')
  }
  const [w = '', f] = s.split('.')
  const whole = w.slice(0, 24)
  if (f === undefined) return whole
  return `${whole}.${f.slice(0, 18)}`
}

/** Normalized string for `avaxDecimalStringToWeiHex` (must be > 0). */
function finalizeAmountForTx(s: string): string | null {
  let t = s.trim()
  if (!t) return null
  if (t === '.') return null
  if (t.endsWith('.')) t = t.slice(0, -1)
  if (t.startsWith('.')) t = `0${t}`
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return null
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  return t
}

function usdApproxForAvax(amountStr: string): string {
  const finalized = finalizeAmountForTx(amountStr)
  if (!finalized) return '—'
  const n = Number(finalized)
  const usd = n * 2417
  return `≈ $${usd.toFixed(2)} USD`
}

/** Exact 0.01 AVAX in wei; any other value is blocked for now. */
function isSupportedDepositAmount(finalized: string): boolean {
  try {
    return BigInt(avaxDecimalStringToWeiHex(finalized)) === SUPPORTED_DEPOSIT_WEI
  } catch {
    return false
  }
}

export function DepositConfirmModal({ open, onClose, onToast }: Props) {
  const { network } = useWallet()
  const [gasLabel, setGasLabel] = useState('—')
  const [pending, setPending] = useState(false)
  const [amountAvax, setAmountAvax] = useState<string>(DEFAULT_AMOUNT)

  useEffect(() => {
    if (open) setAmountAvax(DEFAULT_AMOUNT)
  }, [open])

  useEffect(() => {
    if (!open) {
      setGasLabel('—')
      return
    }
    const eth = getEthereum()
    if (!eth) return
    let cancelled = false
    ;(async () => {
      const g = await estimateSimpleTransferGasNative(eth, 'AVAX')
      if (!cancelled) setGasLabel(g)
    })()
    return () => {
      cancelled = true
    }
  }, [open, network])

  const close = () => {
    if (!pending) onClose()
  }

  const handleContinue = async () => {
    if (pending) return
    const ethereum = getEthereum()
    if (!ethereum) {
      onToast('MetaMask is not installed', 'error')
      return
    }

    const finalized = finalizeAmountForTx(amountAvax)
    if (!finalized) {
      onToast('Enter a valid amount greater than 0', 'error')
      return
    }

    if (!isSupportedDepositAmount(finalized)) {
      onToast(NOT_SUPPORTED_YET_MSG, 'error')
      return
    }

    let valueHex: string
    try {
      valueHex = avaxDecimalStringToWeiHex(finalized)
    } catch {
      onToast('Invalid deposit amount', 'error')
      return
    }

    setPending(true)
    try {
      const okChain = await ensureFuji(ethereum)
      if (!okChain) {
        onToast(
          'You need Avalanche Fuji Testnet (43113) to deposit',
          'error'
        )
        return
      }

      onToast(
        'Deposit · step 1/2: in MetaMask confirm which account to use (pick from the list and Accept)',
        'info'
      )

      try {
        await ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }],
        })
      } catch (permErr: unknown) {
        const pe = permErr as { code?: number }
        if (pe.code === 4001) {
          onToast('Account selection cancelled in MetaMask', 'error')
          return
        }
        /* Wallets without wallet_requestPermissions: fall through to requestAccounts */
      }

      let accs: string[]
      try {
        accs = parseEthAddressList(
          await ethereum.request({ method: 'eth_requestAccounts' })
        )
      } catch {
        onToast('Could not get MetaMask accounts', 'error')
        return
      }

      if (accs.length === 0) {
        onToast('No connected account in MetaMask', 'error')
        return
      }

      await new Promise((r) => window.setTimeout(r, 300))

      onToast(
        'Deposit · step 2/2: confirm the transaction in MetaMask',
        'info'
      )

      const fresh = parseEthAddressList(
        await ethereum.request({ method: 'eth_accounts' })
      )
      const from = fresh[0] ?? accs[0]
      if (!from) {
        onToast('No account selected in MetaMask', 'error')
        return
      }

      const hash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from,
            to: PLACEHOLDER_TO,
            value: valueHex,
            data: '0x',
          },
        ],
      })) as string

      const receipt = await waitForTransactionReceipt(ethereum, hash)
      if (receipt.status === '0x0') {
        onToast('Transaction failed or was reverted', 'error')
        return
      }
      onClose()
      onToast(`Deposit confirmed · ${finalized} AVAX`, 'success')
    } catch (err: unknown) {
      console.error('Deposit tx', err)
      const e = err as { code?: number; message?: string }
      if (e?.code === 4001) {
        onToast('Transaction cancelled in MetaMask', 'error')
        return
      }
      const msg = typeof e?.message === 'string' ? e.message : ''
      if (/user rejected|denied|rejected/i.test(msg)) {
        onToast('Transaction cancelled in MetaMask', 'error')
      } else {
        onToast('Could not send the transaction', 'error')
      }
    } finally {
      setPending(false)
    }
  }

  if (!open) return null

  const finalized = finalizeAmountForTx(amountAvax)
  const amountLabel = finalized ? `${finalized} AVAX` : '—'

  return (
    <div
      className="modal-overlay open"
      style={{ zIndex: 220 }}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) close()
      }}
    >
      <div
        className="modal-sheet"
        style={{ paddingBottom: 28 }}
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
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 14,
              color: 'var(--text)',
              letterSpacing: '0.5px',
            }}
          >
            ADD DEPOSIT
          </span>
          <button
            type="button"
            className="import-close"
            disabled={pending}
            onClick={close}
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

        <p className="modal-sub-label" style={{ marginBottom: 14 }}>
          Select amount to shield on Avalanche
        </p>

        <div className="amount-display">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            className="amount-display-input"
            aria-label="Amount in AVAX"
            placeholder="0.01"
            disabled={pending}
            value={amountAvax}
            onChange={(e) => {
              const next = sanitizeAvaxInput(e.target.value)
              setAmountAvax(next)
              const fin = finalizeAmountForTx(next)
              if (fin !== null && !isSupportedDepositAmount(fin)) {
                onToast(NOT_SUPPORTED_YET_MSG, 'error')
              }
            }}
          />
          <span className="amount-display-cur">AVAX</span>
        </div>

        <div className="deposit-preset-row">
          {DEPOSIT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`preset-btn${amountAvax === p ? ' active' : ''}`}
              disabled={pending}
              onClick={() => {
                if (p !== SUPPORTED_DEPOSIT_AVAX) {
                  onToast(NOT_SUPPORTED_YET_MSG, 'error')
                  return
                }
                setAmountAvax(p)
              }}
            >
              {p}
            </button>
          ))}
        </div>

        <p
          className="modal-sub-label"
          style={{ marginBottom: 12, marginTop: 4 }}
        >
          Two steps in MetaMask: choose your account, then confirm the
          transaction.
        </p>

        <div className="deposit-info" style={{ marginBottom: 18 }}>
          <div className="info-row">
            <span className="info-key">Amount</span>
            <span
              className="info-val"
              style={{
                fontFamily: 'var(--mono)',
                color: 'var(--history-accent)',
              }}
            >
              {amountLabel}
            </span>
          </div>
          <div className="info-row">
            <span className="info-key">≈ USD</span>
            <span className="info-val" style={{ fontFamily: 'var(--mono)' }}>
              {usdApproxForAvax(amountAvax)}
            </span>
          </div>
          <div className="info-row">
            <span className="info-key">Claims to mint</span>
            <span className="info-val" style={{ fontFamily: 'var(--mono)' }}>
              1
            </span>
          </div>
          <div className="info-row">
            <span className="info-key">Network</span>
            <span
              className="info-val"
              style={{
                fontFamily: 'var(--mono)',
                color:
                  network === 'Fuji' ? 'var(--green)' : 'var(--yellow)',
              }}
            >
              {network === 'Fuji' ? 'Avalanche · Fuji' : network}
            </span>
          </div>
          <div className="info-row">
            <span className="info-key">Gas fee (est.)</span>
            <span className="info-val" style={{ fontFamily: 'var(--mono)' }}>
              {gasLabel}
            </span>
          </div>
          <div className="info-row">
            <span className="info-key">Privacy</span>
            <span
              className="info-val"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                maxWidth: '58%',
                textAlign: 'right',
              }}
            >
              Blind-Signature
            </span>
          </div>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={handleContinue}
          >
            {pending ? (
              <span className="inline-flex items-center justify-center gap-2">
                <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
                Waiting…
              </span>
            ) : (
              'Continue'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
