/** Single source of mock truth for the Ghost-Tip wallet UI (no on-chain crypto). */

export const MOCK_CRYPTO = {
  spendAddress: '0x9355eb29da61d3a94343bf76e6458b6032c8c2e6',
  blindedPointX:
    '0x2199699490514eba0a2b2d86646b9f5301d0ad7b12315169b880cb4b10be8257',
  blindedPointY:
    '0xd52d3a55b22f9e020e437e40f54ce93a6bc42b67706b1220022b23bd16abb11',
  unblindedSigX:
    '0x937017581b5a126f39c4fd65a21331b25af3e39dd8c22fb938f3f9d092e7f3b',
  unblindedSigY:
    '0x1173c27673d294a2f4a7d4c79f36873a60f7c285af31b62d9c2f2daa090f2718',
  denominationEth: 0.01,
  denominationLabel: '0.01 AVAX',
  network: 'Fuji',
} as const

export type ActivityKind = 'Deposit' | 'Redeem' | 'Pending'

/** Home stats (fixed when switching account; aligned with eghostcash_wallet_v1_4e.html). */
export const MOCK_HOME_STATS = {
  validCount: 3,
  validEth: '0.03 AVAX',
  spentCount: 2,
  spentEth: '0.02 AVAX',
} as const

export interface MockRedeemToken {
  id: string
  tokenIndex: number
  label: string
}

export const MOCK_AVAILABLE_TOKENS: MockRedeemToken[] = [
  { id: 't42', tokenIndex: 42, label: 'Token #42' },
  { id: 't41', tokenIndex: 41, label: 'Token #41' },
]

export type HistoryFilterType = 'all' | 'deposit' | 'redeem' | 'pending'

export interface MockTx {
  id: string
  type: ActivityKind
  amount: string
  counterparty: string
  time: string
  txHash: string
  /** ISO date YYYY-MM-DD for filters. */
  dateIso: string
  /** Primary title in grouped list. */
  historyLabel: string
  /** Subtitle (second line). */
  historySub: string
}

const net = MOCK_CRYPTO.network

/** Parity with `historyData` from the HTML mock (2026 dates). */
export const MOCK_HISTORY: MockTx[] = [
  {
    id: 'tx-h1',
    type: 'Pending',
    amount: '0.01 AVAX',
    counterparty: '—',
    time: '2026-03-21',
    txHash: '—',
    dateIso: '2026-03-21',
    historyLabel: 'Deposit · pending',
    historySub: `Just now · ${net}`,
  },
  {
    id: 'tx-h2',
    type: 'Deposit',
    amount: '0.01 AVAX',
    counterparty: MOCK_CRYPTO.spendAddress.slice(0, 10) + '…',
    time: '2026-03-21',
    txHash: '0xa1b2…',
    dateIso: '2026-03-21',
    historyLabel: 'Deposit · 1 claim',
    historySub: `21 Mar · TX 0xa1b2... · ${net}`,
  },
  {
    id: 'tx-h3',
    type: 'Redeem',
    amount: '0.01 AVAX',
    counterparty: '0x71C7…9A2f',
    time: '2026-03-21',
    txHash: '0xf5e4…',
    dateIso: '2026-03-21',
    historyLabel: 'Redeem · Claim #4',
    historySub: `21 Mar · TX 0xf5e4... · ${net}`,
  },
  {
    id: 'tx-h4',
    type: 'Deposit',
    amount: '0.01 AVAX',
    counterparty: MOCK_CRYPTO.spendAddress.slice(0, 10) + '…',
    time: '2026-03-20',
    txHash: '0x9c8b…',
    dateIso: '2026-03-20',
    historyLabel: 'Deposit · 1 claim',
    historySub: `20 Mar · TX 0x9c8b... · ${net}`,
  },
  {
    id: 'tx-h5',
    type: 'Redeem',
    amount: '0.01 AVAX',
    counterparty: '0x71C7…9A2f',
    time: '2026-03-20',
    txHash: '0x2b1a…',
    dateIso: '2026-03-20',
    historyLabel: 'Redeem · Claim #5',
    historySub: `20 Mar · TX 0x2b1a... · ${net}`,
  },
  {
    id: 'tx-h6',
    type: 'Deposit',
    amount: '0.01 AVAX',
    counterparty: MOCK_CRYPTO.spendAddress.slice(0, 10) + '…',
    time: '2026-03-19',
    txHash: '0x8e7c…',
    dateIso: '2026-03-19',
    historyLabel: 'Deposit · 1 claim',
    historySub: `19 Mar · TX 0x8e7c... · ${net}`,
  },
  {
    id: 'tx-h7',
    type: 'Redeem',
    amount: '0.01 AVAX',
    counterparty: '0x71C7…9A2f',
    time: '2026-03-19',
    txHash: '0x4a3b…',
    dateIso: '2026-03-19',
    historyLabel: 'Redeem · Claim #3',
    historySub: `19 Mar · TX 0x4a3b... · ${net}`,
  },
  {
    id: 'tx-h8',
    type: 'Deposit',
    amount: '0.01 AVAX',
    counterparty: MOCK_CRYPTO.spendAddress.slice(0, 10) + '…',
    time: '2026-03-17',
    txHash: '0x1d2e…',
    dateIso: '2026-03-17',
    historyLabel: 'Deposit · 1 claim',
    historySub: `17 Mar · TX 0x1d2e... · ${net}`,
  },
]
