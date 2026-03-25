import { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useGhostMasterSeed } from '../context/GhostMasterSeedProvider'
import {
  requestWalletBalanceRefresh,
  useWallet,
} from '../hooks/useWallet'
import {
  buildRedemptionDraftFromSeed,
  loadRedemptionDraft,
  redemptionDraftMatchesSecrets,
  saveRedemptionDraft,
} from '../crypto/ghostRedeem'
import { ensureFuji, getEthereum } from '../lib/ethereum'
import { GHOST_VAULT_DEPOSIT_AMOUNT_LABEL } from '../lib/ghostVault'
import { sendVaultRedeemTransaction } from '../lib/sendVaultRedeem'
import { useGhostVaultActivityLive } from '../hooks/useGhostVaultActivityLive'
import type { LayoutOutletContext } from '../layoutOutletContext'

function isEthAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim())
}

function addrPickLabel(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

type RedeemableRow = {
  id: string
  tokenIndex: number
  label: string
}

export function Redeem() {
  const { network, accounts, account, openWalletAccountPicker } =
    useWallet()
  const { effectiveMasterSeed, seedRevision } = useGhostMasterSeed()
  const { showToast } = useOutletContext<LayoutOutletContext>()
  const [tokens, setTokens] = useState<RedeemableRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [recipient, setRecipient] = useState('')
  const [recipientTouched, setRecipientTouched] = useState(false)
  const [pickerPending, setPickerPending] = useState(false)
  const [preparePending, setPreparePending] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [storedDraftSummary, setStoredDraftSummary] = useState<string | null>(
    null
  )

  const {
    rows: vaultRows,
    loading: vaultLoading,
    error: vaultError,
    scanBatch,
  } = useGhostVaultActivityLive({
    masterSeed: effectiveMasterSeed,
    seedRevision,
    network,
    networkLabel: network === 'Fuji' ? 'Fuji' : network,
  })

  useEffect(() => {
    if (account && !recipientTouched) {
      setRecipient(account)
    }
  }, [account, recipientTouched])

  useEffect(() => {
    if (!effectiveMasterSeed) {
      setTokens([])
      setLoadError(
        'Connect your wallet and accept the vault signature (valid while connected), or set VITE_GHOST_MASTER_SEED_HEX (dev).'
      )
      setLoading(false)
      return
    }

    const redeemable = vaultRows
      .filter((r) => r.type === 'Deposit' && r.tokenIndex !== undefined)
      .map((r) => ({
        id: r.id,
        tokenIndex: r.tokenIndex!,
        label: r.historyLabel,
      }))

    setTokens(redeemable)
    setSelectedId((prev) => {
      if (prev && redeemable.some((t) => t.id === prev)) return prev
      return redeemable[0]?.id ?? ''
    })

    setLoadError(vaultError)
    setLoading(vaultLoading)
  }, [vaultRows, vaultLoading, vaultError, effectiveMasterSeed])

  useEffect(() => {
    const d = loadRedemptionDraft()
    if (!d) {
      setStoredDraftSummary(null)
      return
    }
    setStoredDraftSummary(
      `Token #${d.tokenIndex} · depositId ${addrPickLabel(d.depositId)} · nullifier ${addrPickLabel(d.spendAddress)}`
    )
  }, [seedRevision, preparePending])

  const handlePrepareRedeem = () => {
    const seed = effectiveMasterSeed
    if (!seed) {
      showToast('Vault seed required (sign with your wallet or use env).', 'error')
      return
    }
    const t = tokens.find((x) => x.id === selectedId)
    if (!t) {
      showToast('Pick a token with mint fulfilled.', 'error')
      return
    }
    setPreparePending(true)
    try {
      const draft = buildRedemptionDraftFromSeed(
        seed,
        t.tokenIndex,
        account ?? undefined
      )
      saveRedemptionDraft(draft)
      setStoredDraftSummary(
        `Token #${draft.tokenIndex} · depositId ${addrPickLabel(draft.depositId)} · nullifier ${addrPickLabel(draft.spendAddress)}`
      )
      showToast(
        'Step 1 done: spend/blind keys saved in this browser. Switch to the account that pays gas and use “Send transaction”.',
        'info'
      )
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : 'Could not save redeem draft',
        'error'
      )
    } finally {
      setPreparePending(false)
    }
  }

  const handleSendRedeemTx = async () => {
    if (!isEthAddress(recipient)) {
      showToast('Enter a valid Ethereum address (0x + 40 hex).', 'error')
      return
    }
    const draft = loadRedemptionDraft()
    if (!draft) {
      showToast('First use “Step 1: save keys” for the selected token.', 'error')
      return
    }
    const seed = effectiveMasterSeed
    if (seed && !redemptionDraftMatchesSecrets(draft, seed)) {
      showToast(
        'Draft does not match the current seed. Prepare redeem again.',
        'error'
      )
      return
    }

    const ethereum = getEthereum()
    if (!ethereum) {
      showToast('No Ethereum wallet available', 'error')
      return
    }

    setSendPending(true)
    try {
      const okChain = await ensureFuji(ethereum)
      if (!okChain) {
        showToast('Switch to Avalanche Fuji (43113) in your wallet.', 'error')
        return
      }

      const { txHash } = await sendVaultRedeemTransaction({
        ethereum,
        recipient: recipient.trim(),
        draft,
        masterSeed: seed ?? null,
      })

      setStoredDraftSummary(null)
      requestWalletBalanceRefresh()
      showToast(`Redeem confirmed · ${txShort(txHash)}`, 'success')
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string }
      if (e?.code === 4001) {
        showToast('Transaction cancelled in your wallet', 'error')
        return
      }
      const msg = typeof e?.message === 'string' ? e.message : ''
      if (/user rejected|denied/i.test(msg)) {
        showToast('Transaction cancelled in your wallet', 'error')
      } else {
        showToast(
          msg || 'Could not send redeem transaction',
          'error'
        )
      }
    } finally {
      setSendPending(false)
    }
  }

  function txShort(hash: string): string {
    if (hash.length > 14) return `${hash.slice(0, 10)}…${hash.slice(-6)}`
    return hash
  }

  const openAccountPicker = async () => {
    setPickerPending(true)
    try {
      await openWalletAccountPicker()
    } finally {
      setPickerPending(false)
    }
  }

  const netLabel = network === 'Fuji' ? 'Avalanche · Fuji' : network

  return (
    <div className="page-inner">
      <div className="flow-page-head">
        <Link to="/" className="import-back">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 4L6 8l4 4"
              stroke="var(--text2)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Back
        </Link>
        <div className="modal-title" style={{ marginTop: 16 }}>
          REDEEM
        </div>
        <div className="modal-sub-label" style={{ marginBottom: 0 }}>
          Tokens with MintFulfilled · {netLabel}
        </div>
      </div>

      <div className="deposit-info">
        <div className="modal-title" style={{ fontSize: 12, marginBottom: 10 }}>
          Available tokens
        </div>
        {loading && (
          <div className="modal-sub-label" style={{ marginBottom: 8 }}>
            Loading…{scanBatch != null ? ` (batch ${scanBatch + 1})` : ''}
          </div>
        )}
        {loadError && (
          <div style={{ fontSize: 12, color: 'var(--red2)', marginBottom: 8 }}>
            {loadError}
          </div>
        )}
        {!loading && !loadError && tokens.length === 0 && (
          <div className="modal-sub-label">
            No deposits with mint fulfilled for this seed.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tokens.map((t) => (
            <label
              key={t.id}
              className="mm-wallet-item"
              style={{ cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="tok"
                checked={selectedId === t.id}
                onChange={() => setSelectedId(t.id)}
                style={{ display: 'none' }}
              />
              <div
                className="mm-wallet-avatar"
                style={{
                  background: '#003D2A',
                  color: 'rgba(255,255,255,.8)',
                  fontSize: 10,
                }}
              >
                {t.tokenIndex}
              </div>
              <div className="mm-wallet-info">
                <div className="mm-wallet-name">{t.label}</div>
                <div className="mm-wallet-addr">{GHOST_VAULT_DEPOSIT_AMOUNT_LABEL}</div>
              </div>
              <div className="mm-wallet-bal">{netLabel}</div>
            </label>
          ))}
        </div>
      </div>

      <div className="deposit-info" style={{ marginTop: 12 }}>
        <div className="type-row" style={{ marginBottom: 8 }}>
          <span className="type-label">Destination · account that receives the redeem</span>
        </div>
        <p
          className="modal-sub-label"
          style={{ marginBottom: 10, fontSize: 11, lineHeight: 1.45 }}
        >
          Pick a connected wallet account or enter another address. That address is the
          contract <strong>recipient</strong>: it receives the 0.01 AVAX. The app
          builds the redeem ECDSA signature with the <strong>spend</strong> key
          (nullifier), not the blind key.
        </p>
        {accounts.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 12,
            }}
          >
            {accounts.map((a) => (
              <button
                key={a}
                type="button"
                className={`preset-btn${
                  recipient.toLowerCase() === a.toLowerCase() ? ' active' : ''
                }`}
                onClick={() => {
                  setRecipientTouched(true)
                  setRecipient(a)
                }}
                style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
              >
                {addrPickLabel(a)}
                {account?.toLowerCase() === a.toLowerCase() ? ' · active' : ''}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          style={{ marginBottom: 12, width: '100%' }}
          disabled={pickerPending || network !== 'Fuji'}
          onClick={() => void openAccountPicker()}
        >
          {pickerPending
            ? 'Wallet…'
            : 'Choose another account in your wallet (more addresses)'}
        </button>
        <div className="type-row" style={{ marginBottom: 6 }}>
          <span className="type-label" style={{ fontSize: 11 }}>
            Manual address
          </span>
        </div>
        <input
          className="wd-search flow-field"
          type="text"
          value={recipient}
          onChange={(e) => {
            setRecipientTouched(true)
            setRecipient(e.target.value.trim())
          }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
        />
      </div>

      <div className="deposit-info" style={{ marginTop: 12 }}>
        <div className="modal-title" style={{ fontSize: 11, marginBottom: 8 }}>
          Two-step flow
        </div>
        <div className="modal-sub-label" style={{ fontSize: 11, lineHeight: 1.45 }}>
          <strong>Step 1</strong> (account that holds the vault seed): save per token
          in <code style={{ fontSize: 10 }}>localStorage</code>: <strong>blind</strong>{' '}
          private key, <strong>spend</strong> private key, and <strong>spend</strong>{' '}
          address (on-chain nullifier). The token deposit is tied by{' '}
          <code>depositId</code> (= blind address), same as <code>DepositLocked</code>.
        </div>
        <div
          className="modal-sub-label"
          style={{ fontSize: 11, lineHeight: 1.45, marginTop: 8 }}
        >
          <strong>Step 2</strong> (another wallet account, e.g. gas payer): the app
          reads S′ from <code>MintFulfilled</code> (not <code>DepositLocked</code>{' '}
          — that event carries blinded point <code>B</code>). With <code>r</code>{' '}
          from the <strong>blind</strong> key, compute{' '}
          <code>unblindSignature(S′, r)</code> → <code>unblindedSignatureS</code>. The
          ECDSA <code>spendSignature</code> must be{' '}
          <code>generateRedemptionProof(spendPriv)</code> — <strong>spend</strong>{' '}
          key, not blind — so <code>ecrecover</code> matches{' '}
          <code>nullifier</code> (= saved spend address). <code>recipient</code> is
          usually the destination account (e.g. Account 2).
        </div>
        <div
          className="modal-sub-label"
          style={{ fontSize: 11, lineHeight: 1.45, marginTop: 8 }}
        >
          Send <code>redeem(recipient, spendSignature, nullifier,
          unblindedSignatureS)</code>: your wallet only signs the EVM transaction;
          calldata is built in the app from the draft.
        </div>
        {storedDraftSummary ? (
          <div
            style={{
              fontSize: 11,
              marginTop: 10,
              fontFamily: 'var(--mono)',
              color: 'var(--text2)',
            }}
          >
            Draft: {storedDraftSummary}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: 12, width: '100%' }}
        onClick={() => void handlePrepareRedeem()}
        disabled={
          loading ||
          tokens.length === 0 ||
          !effectiveMasterSeed ||
          preparePending ||
          network !== 'Fuji'
        }
      >
        {preparePending
          ? 'Saving…'
          : 'Step 1: save keys (spend + blind)'}
      </button>

      <button
        type="button"
        className="btn-full"
        style={{ marginTop: 10 }}
        onClick={() => void handleSendRedeemTx()}
        disabled={
          loading ||
          !isEthAddress(recipient) ||
          sendPending ||
          network !== 'Fuji'
        }
      >
        {sendPending ? 'Wallet…' : 'Step 2: send redeem (confirm in wallet)'}
      </button>
    </div>
  )
}
