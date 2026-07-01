export type HoldingKind = 'cash' | 'crypto' | 'brokerage'

export interface Holding {
  id: string
  name: string
  kind: HoldingKind
  detail: string
  amount: number
  unit: string // RUB / ETH / TON …
  usd: number
  source: 'live' | 'manual' | 'soon'
}

// Honest RU reality: live = on-chain wallets (public RPC) + T-Invest; cash = manual; banks = import only.
export const MOCK_HOLDINGS: Holding[] = [
  { id: 'cash-rub', name: 'Cash (₽)', kind: 'cash', detail: 'manual entry', amount: 120000, unit: 'RUB', usd: 1512, source: 'manual' },
  { id: 'eth', name: 'Ethereum', kind: 'crypto', detail: '0x6f…a13 · Etherscan/Ankr RPC', amount: 0.84, unit: 'ETH', usd: 2310, source: 'live' },
  { id: 'ton', name: 'TON', kind: 'crypto', detail: 'UQ…7d · Ankr RPC', amount: 540, unit: 'TON', usd: 1290, source: 'live' },
  { id: 'tinvest', name: 'T-Invest brokerage', kind: 'brokerage', detail: 'T-Invest API (token)', amount: 85000, unit: 'RUB', usd: 1071, source: 'soon' },
  { id: 'sber', name: 'Sber (statement import)', kind: 'cash', detail: 'CSV/1C import — no live API', amount: 64000, unit: 'RUB', usd: 806, source: 'manual' }
]

export const KIND_COLOR: Record<HoldingKind, string> = {
  cash: '#22d3ee',
  crypto: '#a855f7',
  brokerage: '#22c55e'
}
