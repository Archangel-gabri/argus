// Квоты приходят от разных сервисов в разных форматах, и путаница «остаток против
// израсходованного» переворачивает полосу задом наперёд.
import { describe, expect, it } from 'vitest'
import { parseFirecrawl, parseTavily } from './ai-quota'

describe('квота Firecrawl', () => {
  it('остаток превращается в израсходованное', () => {
    // Сервис отдаёт ОСТАТОК, а показываем мы «сколько ушло из сколько» — иначе полная полоса
    // означала бы исчерпанную квоту.
    const q = parseFirecrawl({
      data: { remainingCredits: 940, planCredits: 1000, billingPeriodEnd: '2026-08-30T00:17:32.860Z' }
    })
    expect(q?.used).toBe(60)
    expect(q?.limit).toBe(1000)
    expect(q?.unit).toBe('кредитов')
    expect(new Date(q?.periodEnd as number).getUTCMonth()).toBe(7)
  })

  it('нетронутая квота — это ноль израсходованного, а не пустой ответ', () => {
    expect(parseFirecrawl({ data: { remainingCredits: 1000, planCredits: 1000 } })?.used).toBe(0)
  })

  it('мусор вместо ответа не превращается в нули', () => {
    expect(parseFirecrawl(null)).toBeNull()
    expect(parseFirecrawl({ data: {} })).toBeNull()
  })
})

describe('квота Tavily', () => {
  it('берёт израсходованное и предел плана, а не счётчик ключа', () => {
    // У ключа свой счётчик без лимита; предел живёт на уровне аккаунта.
    const q = parseTavily({
      key: { usage: 54, limit: null },
      account: { current_plan: 'Researcher', plan_usage: 54, plan_limit: 1000 }
    })
    expect(q).toEqual({ used: 54, limit: 1000, unit: 'кредитов', plan: 'Researcher' })
  })

  it('без данных аккаунта квоты нет', () => {
    expect(parseTavily({ key: { usage: 10 } })).toBeNull()
  })
})
