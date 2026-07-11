import type { Subscription } from '@/types'

export const CAT_COLOR: Record<string, string> = {
  Infra: '#f59e0b',
  AI: '#a855f7',
  Media: '#22c55e',
  Dev: '#38bdf8',
  Hosting: '#0ea5e9',
  Other: '#64748b'
}
export const catColor = (c: string): string => CAT_COLOR[c] ?? '#64748b'

export const SUB_CATEGORIES = ['AI', 'Media', 'Dev', 'Hosting', 'Other'] as const

// Rough display-only FX (USD base). Real rates land with the Banks tab.
const RATES: Record<string, number> = { USD: 1, EUR: 1.08, RUB: 0.011 }
export const toUsd = (amount: number, currency: string): number =>
  Math.round(amount * (RATES[currency] ?? 1) * 100) / 100

// Browser-preview fallback (no Electron API): app subscriptions in the vault shape.
export const MOCK_SUBSCRIPTIONS: Subscription[] = [
  { id: 'claude', name: 'Claude Pro', provider: 'Anthropic', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-14', notes: null },
  { id: 'chatgpt', name: 'ChatGPT Plus', provider: 'OpenAI', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-09', notes: null },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'GitHub', category: 'Dev', amount: 10, currency: 'USD', period: 'mo', nextRenewal: '2026-07-22', notes: null },
  { id: 'spotify', name: 'Spotify Premium', provider: 'Spotify', category: 'Media', amount: 169, currency: 'RUB', period: 'mo', nextRenewal: '2026-07-20', notes: null },
  { id: 'domains', name: 'Domains (HubVPN)', provider: 'Namecheap', category: 'Other', amount: 35, currency: 'USD', period: 'yr', nextRenewal: '2026-11-02', notes: null }
]
