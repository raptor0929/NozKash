import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useGhostMasterSeed } from '../context/GhostMasterSeedProvider'
import { fetchVaultActivityForFirstTokens } from '../lib/ghostVault'
import type { VaultTx } from '../types/activity'

export function Recovery() {
  const { effectiveMasterSeed } = useGhostMasterSeed()
  const [phrase, setPhrase] = useState('')
  const [startIdx, setStartIdx] = useState('0')
  const [endIdx, setEndIdx] = useState('99')
  const [scanning, setScanning] = useState(false)
  const [done, setDone] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanRows, setScanRows] = useState<VaultTx[]>([])

  const handleScan = async () => {
    setScanning(true)
    setDone(false)
    setScanError(null)
    setScanRows([])
    try {
      const seed = effectiveMasterSeed
      if (!seed) {
        setScanError(
          'Conectá la wallet y aceptá la firma del vault (válida mientras sigas conectado), o usá VITE_GHOST_MASTER_SEED_HEX (dev).'
        )
        return
      }
      void startIdx
      void endIdx
      void phrase
      const rows = await fetchVaultActivityForFirstTokens(seed, {
        networkLabel: 'Fuji',
      })
      setScanRows(rows)
      setDone(true)
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Error al consultar la red')
    } finally {
      setScanning(false)
    }
  }

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
          RECOVERY
        </div>
        <div className="modal-sub-label" style={{ marginBottom: 0 }}>
          Avalanche · Fuji · lectura GhostVault vía RPC
        </div>
      </div>

      <div className="deposit-info">
        <div className="type-row">
          <span className="type-label">Seed phrase (reservado)</span>
        </div>
        <textarea
          className="srp-textarea"
          style={{ height: 120 }}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="Integración futura: BIP39 → master seed…"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 12,
        }}
      >
        <div className="deposit-info" style={{ marginBottom: 0 }}>
          <div className="type-label" style={{ marginBottom: 8 }}>
            Start index
          </div>
          <input
            className="wd-search flow-field"
            type="number"
            min={0}
            value={startIdx}
            onChange={(e) => setStartIdx(e.target.value)}
          />
        </div>
        <div className="deposit-info" style={{ marginBottom: 0 }}>
          <div className="type-label" style={{ marginBottom: 8 }}>
            End index
          </div>
          <input
            className="wd-search flow-field"
            type="number"
            min={0}
            value={endIdx}
            onChange={(e) => setEndIdx(e.target.value)}
          />
        </div>
      </div>

      <p
        className="modal-sub-label"
        style={{ marginTop: 12, marginBottom: 0, fontSize: 11 }}
      >
        El escaneo actual usa solo la semilla del entorno (misma que el home), no
        la frase anterior.
      </p>

      <button
        type="button"
        className="btn-full"
        style={{ marginTop: 16, opacity: scanning ? 0.6 : 1 }}
        disabled={scanning}
        onClick={() => void handleScan()}
      >
        {scanning ? 'Scanning…' : 'Scan Blockchain'}
      </button>

      {scanError && (
        <div
          className="deposit-info"
          style={{
            marginTop: 16,
            borderColor: 'rgba(255,100,100,.3)',
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--red2)' }}>{scanError}</div>
        </div>
      )}

      {done && scanRows.length === 0 && !scanError && (
        <div className="deposit-info" style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>
            Sin actividad GhostVault para esta semilla en el rango escaneado.
          </div>
        </div>
      )}

      {done && scanRows.length > 0 && (
        <div
          className="deposit-info"
          style={{
            marginTop: 16,
            borderColor: 'rgba(0,229,160,.25)',
            background: 'var(--green-dim)',
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: 'var(--green)',
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            {scanRows.length} fila(s) on-chain
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 11,
              color: 'var(--text)',
              wordBreak: 'break-all',
            }}
          >
            {scanRows.map((r) => (
              <li key={r.id} style={{ marginBottom: 6 }}>
                {r.historyLabel} · {r.txHash}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
