/** Fila de actividad GhostVault / historial (solo datos on-chain o derivados). */

export type ActivityKind = 'Deposit' | 'Redeem' | 'Pending'

export type HistoryFilterType = 'all' | 'deposit' | 'redeem' | 'pending'

export interface VaultTx {
  id: string
  type: ActivityKind
  amount: string
  counterparty: string
  time: string
  txHash: string
  dateIso: string
  historyLabel: string
  historySub: string
  blockNumber?: number
  /** Índice de token cuando la fila viene del vault escaneado. */
  tokenIndex?: number
}
