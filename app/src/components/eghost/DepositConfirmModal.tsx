import { useEffect, useRef, useState } from 'react'
import { useGhostMasterSeed } from '../../context/GhostMasterSeedProvider'
import { useWallet } from '../../hooks/useWallet'
import {
  ensureFuji,
  getEthereum,
  waitForTransactionReceipt,
  weiHexToNativeLabel,
} from '../../lib/ethereum'
import { avaxDecimalStringToWeiHex } from '../../lib/avaxWei'
import { fujiRpcCall } from '../../lib/fujiJsonRpc'
import {
  GHOST_VAULT_ADDRESS,
  GHOST_VAULT_DEPOSIT_VALUE_WEI_HEX,
  GHOST_VAULT_RPC_POLL_MS,
  getNextVaultTokenIndexForDeposit,
} from '../../lib/ghostVault'
import {
  buildGhostVaultDepositCalldata,
  encodeDepositPendingCalldata,
  evmSelector4,
  GHOST_VAULT_DEPOSIT_SELECTOR_HEX,
  parseGhostVaultDepositCalldataArgs,
} from '../../crypto/ghostDeposit'

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

function addrPickLabel(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function DepositConfirmModal({ open, onClose, onToast }: Props) {
  const { network, account } = useWallet()
  const { effectiveMasterSeed, seedRevision, requestUnlockViaSign } =
    useGhostMasterSeed()
  const [gasLabel, setGasLabel] = useState('—')
  const [pending, setPending] = useState(false)
  const [amountAvax, setAmountAvax] = useState<string>(DEFAULT_AMOUNT)

  const seedRef = useRef(effectiveMasterSeed)
  const accountRef = useRef(account)
  seedRef.current = effectiveMasterSeed
  accountRef.current = account

  useEffect(() => {
    if (open) setAmountAvax(DEFAULT_AMOUNT)
  }, [open])

  useEffect(() => {
    if (!open || network !== 'Fuji') {
      setGasLabel('—')
      return
    }

    let cancelled = false

    async function refreshGasEstimate() {
      const seed = seedRef.current
      const from = accountRef.current
      if (!from || !seed) {
        if (!cancelled) setGasLabel('—')
        return
      }
      try {
        const nextIdx = await getNextVaultTokenIndexForDeposit(seed, {
          contractAddress: GHOST_VAULT_ADDRESS,
        })
        const { data } = await buildGhostVaultDepositCalldata(seed, nextIdx)
        const gasHex = await fujiRpcCall<string>('eth_estimateGas', [
          {
            from,
            to: GHOST_VAULT_ADDRESS,
            data,
            value: GHOST_VAULT_DEPOSIT_VALUE_WEI_HEX,
          },
        ])
        const priceHex = await fujiRpcCall<string>('eth_gasPrice', [])
        const wei = BigInt(gasHex) * BigInt(priceHex)
        const label = weiHexToNativeLabel(
          `0x${wei.toString(16)}`,
          'AVAX',
          6
        )
        if (!cancelled) setGasLabel(`~${label}`)
      } catch {
        if (!cancelled) setGasLabel('—')
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshGasEstimate()
    }, GHOST_VAULT_RPC_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [open, network, seedRevision, !!effectiveMasterSeed])

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

    if (!account) {
      onToast('Conectá la wallet en la app; el depósito usa esa misma cuenta', 'error')
      return
    }

    const from = account

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

      onToast('Confirmá el depósito en MetaMask', 'info')

      let seed = effectiveMasterSeed
      if (!seed) {
        onToast('Firmá el mensaje en MetaMask para derivar el vault…', 'info')
        seed = await requestUnlockViaSign(from)
      }
      if (!seed) {
        onToast('Hace falta firmar el mensaje para depositar', 'error')
        return
      }

      const tokenIndex = await getNextVaultTokenIndexForDeposit(seed, {
        contractAddress: GHOST_VAULT_ADDRESS,
      })

      let data: `0x${string}`
      let builtDepositId: string
      try {
        const built = await buildGhostVaultDepositCalldata(seed, tokenIndex)
        data = built.data
        builtDepositId = built.depositId
      } catch (err) {
        console.error('GhostVault deposit calldata', err)
        onToast('Could not build blind deposit payload', 'error')
        return
      }

      if (!data || data === '0x' || data.length < 10) {
        console.error('[GhostVault deposit] missing calldata — would be plain AVAX transfer', {
          data,
        })
        onToast('Internal error: deposit calldata missing', 'error')
        return
      }

      const sendParams = {
        from,
        to: GHOST_VAULT_ADDRESS,
        data,
        value: GHOST_VAULT_DEPOSIT_VALUE_WEI_HEX,
      }
      let depositFnArgs: ReturnType<typeof parseGhostVaultDepositCalldataArgs>
      try {
        depositFnArgs = parseGhostVaultDepositCalldataArgs(data)
      } catch (e) {
        depositFnArgs = {
          blindedPointB: ['?', '?'],
          depositId: builtDepositId,
        }
        console.warn('[GhostVault deposit debug] parse calldata failed', e)
      }
      const chainId = (await ethereum.request({
        method: 'eth_chainId',
      })) as string
      const calldataSelector = data.slice(0, 10).toLowerCase()
      const txValueWei = BigInt(sendParams.value)
      const selectorMatchesDepositAbi =
        calldataSelector === GHOST_VAULT_DEPOSIT_SELECTOR_HEX.toLowerCase()

      let onChainDenominationWeiHex: string | null = null
      let depositPendingView: boolean | null = null
      try {
        onChainDenominationWeiHex = await fujiRpcCall<string>('eth_call', [
          { to: GHOST_VAULT_ADDRESS, data: evmSelector4('DENOMINATION()') },
          'latest',
        ])
      } catch (denErr) {
        console.warn('[GhostVault deposit debug] DENOMINATION() eth_call failed', denErr)
      }
      try {
        const pendHex = await fujiRpcCall<string>('eth_call', [
          {
            to: GHOST_VAULT_ADDRESS,
            data: encodeDepositPendingCalldata(builtDepositId),
          },
          'latest',
        ])
        depositPendingView = BigInt(pendHex) !== 0n
      } catch (pendErr) {
        console.warn('[GhostVault deposit debug] depositPending eth_call failed', pendErr)
      }

      const onChainDenomWei =
        onChainDenominationWeiHex != null
          ? BigInt(onChainDenominationWeiHex)
          : null

      console.log('[GhostVault deposit debug] before eth_sendTransaction', {
        tokenIndex,
        chainId,
        vaultTo: GHOST_VAULT_ADDRESS,
        txValueWeiHex: sendParams.value,
        txValueWeiDecimal: txValueWei.toString(),
        calldataSelector,
        expectedDepositSelector: GHOST_VAULT_DEPOSIT_SELECTOR_HEX,
        selectorMatchesDepositAbi,
        onChainDenominationWeiHex,
        onChainDenominationWeiDecimal:
          onChainDenomWei != null ? onChainDenomWei.toString() : null,
        txValueMatchesOnChainDenomination:
          onChainDenomWei != null ? txValueWei === onChainDenomWei : null,
        depositPending_view: depositPendingView,
        eth_sendTransaction: { method: 'eth_sendTransaction' as const, params: [sendParams] },
        deposit_blindedPointB_uint256_decimal: depositFnArgs.blindedPointB,
        deposit_depositId: depositFnArgs.depositId,
        depositId_from_build_matches_calldata:
          builtDepositId.toLowerCase() === depositFnArgs.depositId.toLowerCase(),
      })

      try {
        await fujiRpcCall<string>('eth_call', [sendParams, 'latest'])
        console.log(
          '[GhostVault deposit debug] eth_call (same as tx): ok — sin revert en este RPC'
        )
      } catch (simErr) {
        console.warn(
          '[GhostVault deposit debug] eth_call (same as tx): revert / error (motivo útil si el nodo lo devuelve)',
          simErr
        )
      }

      const hash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [sendParams],
      })) as string

      const receipt = await waitForTransactionReceipt(hash)
      if (receipt.status === '0x0') {
        onToast('Transaction failed or was reverted', 'error')
        return
      }
      onClose()
      onToast(
        `Deposit confirmed · token #${tokenIndex} · ${finalized} AVAX`,
        'success'
      )
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
          Cuenta que paga: {account ? addrPickLabel(account) : '—'}. La firma del vault se
          pide al conectar y se mantiene en memoria mientras la wallet sigue conectada; acá solo
          confirmás el depósito en
          MetaMask.
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
