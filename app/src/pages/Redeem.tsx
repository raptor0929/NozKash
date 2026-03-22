import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useGhostMasterSeed } from '../context/GhostMasterSeedProvider'
import { useWallet } from '../hooks/useWallet'
import {
  fetchVaultActivityForFirstTokens,
  GHOST_VAULT_DEPOSIT_AMOUNT_LABEL,
  GHOST_VAULT_RPC_POLL_MS,
} from '../lib/ghostVault'

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
  const { network, accounts, account, openMetaMaskAccountPicker } = useWallet()
  const { effectiveMasterSeed, seedRevision } = useGhostMasterSeed()
  const [tokens, setTokens] = useState<RedeemableRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [recipient, setRecipient] = useState('')
  const [recipientTouched, setRecipientTouched] = useState(false)
  const [pickerPending, setPickerPending] = useState(false)

  const seedRef = useRef(effectiveMasterSeed)
  const networkRef = useRef(network)
  seedRef.current = effectiveMasterSeed
  networkRef.current = network

  useEffect(() => {
    if (account && !recipientTouched) {
      setRecipient(account)
    }
  }, [account, recipientTouched])

  useEffect(() => {
    if (!effectiveMasterSeed) {
      setTokens([])
      setLoadError(
        'Conectá la wallet y aceptá la firma del vault (válida mientras sigas conectado), o definí VITE_GHOST_MASTER_SEED_HEX (dev).'
      )
      setLoading(false)
      return
    }

    let cancelled = false
    setTokens([])
    setLoadError(null)
    setLoading(true)

    let firstTick = true

    async function load(isInitial: boolean) {
      const seed = seedRef.current
      const net = networkRef.current
      if (!seed) return
      if (isInitial) {
        setLoading(true)
        setLoadError(null)
      }
      try {
        const rows = await fetchVaultActivityForFirstTokens(seed, {
          networkLabel: net === 'Fuji' ? 'Fuji' : net,
        })
        if (cancelled) return
        const redeemable = rows
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
        if (isInitial) setLoadError(null)
      } catch (e) {
        if (!cancelled && isInitial) {
          setLoadError(
            e instanceof Error ? e.message : 'No se pudo cargar el vault'
          )
          setTokens([])
        }
      } finally {
        if (!cancelled && isInitial) setLoading(false)
      }
    }

    const intervalId = window.setInterval(() => {
      void load(firstTick)
      firstTick = false
    }, GHOST_VAULT_RPC_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [network, seedRevision, account, !!effectiveMasterSeed])

  const handleRedeem = () => {
    if (!isEthAddress(recipient)) {
      window.alert('Indicá una dirección Ethereum válida (0x + 40 hex).')
      return
    }
    const t = tokens.find((x) => x.id === selectedId)
    window.alert(
      `Redeem (pendiente tx): token #${t?.tokenIndex ?? '?'} → ${recipient}`
    )
  }

  const openAccountPicker = async () => {
    setPickerPending(true)
    try {
      await openMetaMaskAccountPicker()
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
          Tokens con MintFulfilled · {netLabel}
        </div>
      </div>

      <div className="deposit-info">
        <div className="modal-title" style={{ fontSize: 12, marginBottom: 10 }}>
          Available tokens
        </div>
        {loading && (
          <div className="modal-sub-label" style={{ marginBottom: 8 }}>
            Cargando…
          </div>
        )}
        {loadError && (
          <div style={{ fontSize: 12, color: 'var(--red2)', marginBottom: 8 }}>
            {loadError}
          </div>
        )}
        {!loading && !loadError && tokens.length === 0 && (
          <div className="modal-sub-label">
            Ningún depósito con mint cumplido para esta semilla.
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
          <span className="type-label">Destino · a qué cuenta va el redeem</span>
        </div>
        <p
          className="modal-sub-label"
          style={{ marginBottom: 10, fontSize: 11, lineHeight: 1.45 }}
        >
          Elegí una de las cuentas de MetaMask o escribí otra dirección. El
          depósito en vault sigue usando solo la cuenta conectada en el home;
          aquí definís el <strong>recipient</strong> del canje.
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
                {account?.toLowerCase() === a.toLowerCase() ? ' · activa' : ''}
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
            ? 'MetaMask…'
            : 'Elegir otra cuenta en MetaMask (más direcciones)'}
        </button>
        <div className="type-row" style={{ marginBottom: 6 }}>
          <span className="type-label" style={{ fontSize: 11 }}>
            Dirección manual
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
          Unblinded signature
        </div>
        <div className="modal-sub-label" style={{ fontSize: 11, lineHeight: 1.45 }}>
          Se obtiene de los datos del evento MintFulfilled (S′) y la derivación
          local; la integración con `GhostVault.redeem` va en el siguiente paso.
        </div>
      </div>

      <button
        type="button"
        className="btn-full"
        style={{ marginTop: 16 }}
        onClick={handleRedeem}
        disabled={
          loading || tokens.length === 0 || !isEthAddress(recipient)
        }
      >
        Redeem
      </button>
    </div>
  )
}
