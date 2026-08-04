import { toUsd } from '@/data/subscriptions'
import type { FinanceAccount, FinanceKind } from '@/types'

/**
 * Возраст вписанного руками остатка.
 *
 * Остаток на карте — не свойство счёта, а замер: он был верен в момент, когда его вписали, и
 * с тех пор устарел ровно настолько, сколько прошло времени. Показывать цифру месячной давности
 * так же, как снятую сегодня, — значит выдавать память за факт.
 *
 * Порогов два, и оба про поведение денег, а не про красоту: неделя — срок, за который зарплата
 * и регулярные списания успевают заметно сдвинуть остаток; месяц — срок, после которого цифра
 * не значит уже ничего.
 */
export type Freshness = 'fresh' | 'aging' | 'stale'

export interface BalanceAge {
  days: number
  level: Freshness
}

const DAY = 24 * 60 * 60 * 1000

export function balanceAge(balanceAt: number | null, now: number): BalanceAge | null {
  if (!balanceAt) return null
  const days = Math.max(0, Math.floor((now - balanceAt) / DAY))
  return { days, level: days < 7 ? 'fresh' : days < 30 ? 'aging' : 'stale' }
}

export interface Totals {
  /** Сумма известных остатков в долларах. */
  usd: number
  /** У скольких счетов остаток известен. */
  known: number
  /** У скольких неизвестен — эти в сумму не входят вовсе. */
  unknown: number
  /** Сколько известных остатков старше месяца: сумма настолько же приблизительна. */
  stale: number
}

/**
 * Итог по счетам.
 *
 * Неизвестный остаток НЕ считается нулём и не входит в сумму: ноль означал бы «денег нет», а мы
 * знаем только то, что не спросили. Поэтому рядом с суммой всегда стоит, из скольких счетов она
 * собрана, — иначе «120 000 ₽» из двух счетов при семи заведённых читается как всё состояние.
 */
export function totals(accounts: FinanceAccount[], now: number): Totals {
  let usd = 0
  let known = 0
  let unknown = 0
  let stale = 0
  for (const a of accounts) {
    if (a.balance == null) {
      unknown++
      continue
    }
    known++
    usd += toUsd(a.balance, a.currency)
    if (a.source === 'manual' && balanceAge(a.balanceAt, now)?.level === 'stale') stale++
  }
  return { usd: Math.round(usd * 100) / 100, known, unknown, stale }
}

export const KIND_LABEL: Record<FinanceKind, string> = {
  bank: 'Банки',
  broker: 'Брокерские счета',
  exchange: 'Биржи',
  ewallet: 'Электронные кошельки',
  cash: 'Наличные'
}

/** Порядок групп: сначала то, где обычно лежит основное, потом мелочь. */
const ORDER: FinanceKind[] = ['bank', 'broker', 'exchange', 'ewallet', 'cash']

export function groupByKind(accounts: FinanceAccount[]): Array<{ kind: FinanceKind; items: FinanceAccount[] }> {
  return ORDER.map((kind) => ({ kind, items: accounts.filter((a) => a.kind === kind) })).filter(
    (g) => g.items.length > 0
  )
}
