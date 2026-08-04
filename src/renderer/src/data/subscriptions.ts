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

// Категории — ХРАНИМЫЕ значения: они лежат в записях подписок и служат ключами CAT_COLOR.
// Переводить сами значения нельзя (сломается чтение уже сохранённых записей), поэтому русский
// текст живёт отдельной картой показа. «Infra» в списке выбора нет — эту категорию ставят
// устройства, приходящие в расходы из парка, но подписать её на экране всё равно надо.
export const CAT_LABEL: Record<string, string> = {
  Infra: 'Инфраструктура',
  AI: 'ИИ',
  Media: 'Медиа',
  Dev: 'Разработка',
  Hosting: 'Хостинг',
  Other: 'Другое'
}
export const catLabel = (c: string): string => CAT_LABEL[c] ?? c

// Rough display-only FX (USD base), 2026 approximations.
// ВАЖНО: должно 1-в-1 совпадать с картой FX в src/main/vault.ts — иначе стоимость
// сервера (конвертируется в main) и подписки (конвертируется здесь) разойдутся.
const RATES: Record<string, number> = {
  USD: 1, EUR: 1.08, RUB: 0.0126, GBP: 1.27, CNY: 0.14, JPY: 0.0067, CHF: 1.11,
  CAD: 0.73, AUD: 0.66, INR: 0.012, BRL: 0.2, KRW: 0.00075, TRY: 0.03, PLN: 0.25,
  UAH: 0.025, KZT: 0.0021, AED: 0.27, SEK: 0.095, NOK: 0.093, SGD: 0.74,
  PKR: 0.0036
}
export const toUsd = (amount: number, currency: string): number =>
  Math.round(amount * (RATES[currency] ?? 1) * 100) / 100

// Browser-preview fallback (no Electron API): app subscriptions in the vault shape.
export const MOCK_SUBSCRIPTIONS: Subscription[] = [
  { id: 'claude', name: 'Claude Pro', provider: 'Anthropic', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-14', notes: null, manualRenewal: false },
  { id: 'chatgpt', name: 'ChatGPT Plus', provider: 'OpenAI', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-09', notes: null, manualRenewal: false },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'GitHub', category: 'Dev', amount: 10, currency: 'USD', period: 'mo', nextRenewal: '2026-07-22', notes: null, manualRenewal: false },
  { id: 'spotify', name: 'Spotify Premium', provider: 'Spotify', category: 'Media', amount: 169, currency: 'RUB', period: 'mo', nextRenewal: '2026-07-20', notes: null, manualRenewal: false },
  { id: 'domains', name: 'Domains (HubVPN)', provider: 'Namecheap', category: 'Other', amount: 35, currency: 'USD', period: 'yr', nextRenewal: '2026-11-02', notes: null, manualRenewal: true }
]
