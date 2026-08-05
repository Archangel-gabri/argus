import type { Subscription } from '@/types'
import { FX_TO_USD } from '../../../shared/fx'

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

// Display-only перевод в доллары; курсы — общие на всё приложение (src/shared/fx.ts),
// приблизительные и вшитые. Своя таблица здесь уже разошлась с таблицей vault.ts, хотя
// комментарий в обеих требовал держать их одинаковыми: комментарий ничего не проверяет.
//
// Контракт числовой: вызывающие складывают результат в итоги и графики, null им не отдать,
// не тронув все экраны денег. Неизвестной валюты здесь и не бывает — хранилище пускает только
// CURRENCY_CODES, а курс каждой из них гарантирован (satisfies + fx-tables.test.ts). Но если
// она всё же придёт (запись из базы более новой версии) — это NaN, а не «доллар за единицу»:
// NaN отравляет итог и виден сразу, тогда как курс 1 уже превращал «100 BTC» в «$100» —
// правдоподобно и неверно (см. src/main/device-cost.test.ts).
export const toUsd = (amount: number, currency: string): number =>
  Math.round(amount * (FX_TO_USD[currency] ?? NaN) * 100) / 100

// Browser-preview fallback (no Electron API): app subscriptions in the vault shape.
export const MOCK_SUBSCRIPTIONS: Subscription[] = [
  { id: 'claude', name: 'Claude Pro', provider: 'Anthropic', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-14', renewalDay: 14, notes: null, manualRenewal: false },
  { id: 'chatgpt', name: 'ChatGPT Plus', provider: 'OpenAI', category: 'AI', amount: 20, currency: 'USD', period: 'mo', nextRenewal: '2026-07-09', renewalDay: 9, notes: null, manualRenewal: false },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'GitHub', category: 'Dev', amount: 10, currency: 'USD', period: 'mo', nextRenewal: '2026-07-22', renewalDay: 22, notes: null, manualRenewal: false },
  { id: 'spotify', name: 'Spotify Premium', provider: 'Spotify', category: 'Media', amount: 169, currency: 'RUB', period: 'mo', nextRenewal: '2026-07-20', renewalDay: 20, notes: null, manualRenewal: false },
  { id: 'domains', name: 'Domains (HubVPN)', provider: 'Namecheap', category: 'Other', amount: 35, currency: 'USD', period: 'yr', nextRenewal: '2026-11-02', renewalDay: 2, notes: null, manualRenewal: true }
]
