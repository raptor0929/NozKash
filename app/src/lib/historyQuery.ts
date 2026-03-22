import type { ActivityKind, HistoryFilterType, VaultTx } from '../types/activity'

export function activityKindToFilter(
  t: ActivityKind
): Exclude<HistoryFilterType, 'all'> {
  switch (t) {
    case 'Deposit':
      return 'deposit'
    case 'Redeem':
      return 'redeem'
    case 'Pending':
      return 'pending'
  }
}

export function filterVaultActivity(
  items: VaultTx[],
  activeFilter: HistoryFilterType,
  dateFrom: string,
  dateTo: string
): VaultTx[] {
  return items.filter((item) => {
    if (
      activeFilter !== 'all' &&
      activityKindToFilter(item.type) !== activeFilter
    ) {
      return false
    }
    if (dateFrom && item.dateIso < dateFrom) return false
    if (dateTo && item.dateIso > dateTo) return false
    return true
  })
}

export function formatTxAmountDisplay(item: VaultTx): string {
  if (item.type === 'Deposit') return `+${item.amount}`
  if (item.type === 'Redeem') return `-${item.amount}`
  return item.amount
}

export function redeemSignMessageForTx(item: VaultTx): string {
  return [
    'NozKash — Redeem claim',
    `Ref: ${item.id}`,
    item.historyLabel,
    `Amount: ${item.amount}`,
    `Date: ${item.dateIso}`,
  ].join('\n')
}

export const ACTIVITY_TYPE_FILTERS: {
  key: HistoryFilterType
  label: string
}[] = [
  { key: 'all', label: 'All' },
  { key: 'deposit', label: 'Deposits' },
  { key: 'redeem', label: 'Redeems' },
  { key: 'pending', label: 'Pending' },
]
