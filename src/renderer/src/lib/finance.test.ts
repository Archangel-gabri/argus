// Деньги на экране опаснее всего двумя способами: неизвестный остаток, показанный нулём, и
// давно вписанная цифра, показанная как сегодняшняя. Оба выглядят как нормальные данные.
import { describe, expect, it } from 'vitest'
import { balanceAge, groupByKind, totals } from './finance'
import type { FinanceAccount } from '@/types'

const NOW = Date.parse('2026-08-04T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const acc = (over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: 'a',
  kind: 'bank',
  name: 'Сбербанк',
  institution: '',
  currency: 'RUB',
  source: 'manual',
  balance: null,
  balanceAt: null,
  keyRef: null,
  notes: null,
  createdAt: 0,
  ...over
})

describe('возраст остатка', () => {
  it('свежий, стареющий и протухший различаются', () => {
    expect(balanceAge(NOW - 2 * DAY, NOW)).toEqual({ days: 2, level: 'fresh' })
    expect(balanceAge(NOW - 10 * DAY, NOW)).toEqual({ days: 10, level: 'aging' })
    expect(balanceAge(NOW - 40 * DAY, NOW)).toEqual({ days: 40, level: 'stale' })
  })

  it('без отметки времени возраста нет — и он не выдумывается', () => {
    expect(balanceAge(null, NOW)).toBeNull()
  })

  it('часы вперёд не дают отрицательного возраста', () => {
    expect(balanceAge(NOW + 5 * DAY, NOW)?.days).toBe(0)
  })
})

describe('итог по счетам', () => {
  it('неизвестный остаток НЕ считается нулём и в сумму не входит', () => {
    // Ноль означал бы «денег нет», а мы знаем лишь то, что не спрашивали.
    const t = totals([acc({ balance: 79_000 }), acc({ id: 'b', balance: null })], NOW)
    expect(t.known).toBe(1)
    expect(t.unknown).toBe(1)
    expect(t.usd).toBeGreaterThan(900)
    expect(t.usd).toBeLessThan(1100)
  })

  it('разные валюты сводятся в доллары', () => {
    const t = totals([acc({ balance: 100, currency: 'USD' }), acc({ id: 'b', balance: 100, currency: 'EUR' })], NOW)
    expect(t.usd).toBeCloseTo(208, 0)
  })

  it('протухшие остатки считаются отдельно — сумма ровно настолько же приблизительна', () => {
    const t = totals(
      [
        acc({ balance: 1000, balanceAt: NOW - 40 * DAY }),
        acc({ id: 'b', balance: 1000, balanceAt: NOW - DAY })
      ],
      NOW
    )
    expect(t.stale).toBe(1)
  })

  it('остаток, полученный опросом, тоже стареет', () => {
    // У опрашиваемого счёта дата — это время последнего УСПЕШНОГО опроса. Если она трёхмесячной
    // давности, значит опрос давно не удаётся: сессия кабинета банка живёт минуты. Считать такую
    // цифру свежей только потому, что «источник автоматический», — самый удобный способ соврать.
    const t = totals([acc({ source: 'api', balance: 500, currency: 'USD', balanceAt: NOW - 90 * DAY })], NOW)
    expect(t.stale).toBe(1)
  })

  it('пустой список даёт нули, а не ошибку', () => {
    expect(totals([], NOW)).toEqual({ usd: 0, known: 0, unknown: 0, stale: 0 })
  })
})

describe('группировка', () => {
  it('порядок групп постоянный, пустые не показываются', () => {
    const groups = groupByKind([acc({ kind: 'exchange' }), acc({ id: 'b', kind: 'bank' })])
    expect(groups.map((g) => g.kind)).toEqual(['bank', 'exchange'])
  })
})
