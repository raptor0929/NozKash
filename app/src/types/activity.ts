/** GhostVault activity / history row (on-chain or derived data only). */

export type ActivityKind = 'Deposit' | 'Redeem' | 'Pending' | 'Refunded'

export type HistoryFilterType =
  | 'all'
  | 'deposit'
  | 'redeem'
  | 'pending'
  | 'refunded'

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
  /** Token index when the row comes from scanned vault activity. */
  tokenIndex?: number
}
