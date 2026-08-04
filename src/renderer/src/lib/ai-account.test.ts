import { describe, expect, it } from 'vitest'
import {
  aiSummary,
  byModel,
  calculate,
  dailySeries,
  daysAgoDate,
  daysUntilExpiry,
  groupByKind,
  monthlyCost,
  needsAttention,
  priceLabel,
  providerChangeError,
  subscriptionRoi,
  totalsFor
} from './ai-account'
import type { AiAccess, AiCheck, AiPrice, AiUsageDay, Subscription } from '@/types'

const access = (id: string, over: Partial<AiAccess> = {}): AiAccess => ({
  id,
  kind: 'api',
  provider: 'openrouter',
  label: id,
  account: '',
  accounts: [],
  plan: '',
  status: 'active',
  subscriptionId: null,
  hasKey: true,
  keyRef: null,
  keyExpiresAt: null,
  baseUrl: null,
  payment: 'card',
  thirdParty: false,
  usedBy: [],
  fallbackId: null,
  limits: {},
  notes: null,
  createdAt: Date.parse('2026-01-01'),
  ...over
})

const day = (over: Partial<AiUsageDay> = {}): AiUsageDay => ({
  date: '2026-08-01',
  source: 'claude-code',
  model: 'claude-opus-4-7',
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  requests: 1,
  costUsd: 0,
  ...over
})

describe('честная сводка AI-доступов', () => {
  it('не превращает ещё не проверенные ключи и кредит в нули', () => {
    expect(aiSummary([access('a')], {})).toEqual({ workingKeys: null, totalCredit: null })
  })

  it('считает квоту подтверждённым ключом, но не выдумывает остаток', () => {
    const checks: Record<string, AiCheck> = { a: { status: 'quota' } }
    expect(aiSummary([access('a', { provider: 'openai' })], checks)).toEqual({ workingKeys: '1/1', totalCredit: null })
  })

  it('показывает OpenRouter-итог только когда известен остаток каждого сохранённого ключа', () => {
    const list = [access('a'), access('b')]
    expect(
      aiSummary(list, {
        a: { status: 'valid', remaining: 12 },
        b: { status: 'error', detail: 'Сеть: тайм-аут проверки' }
      })
    ).toMatchObject({ totalCredit: null })
    expect(
      aiSummary(list, {
        a: { status: 'valid', remaining: 12 },
        b: { status: 'valid', remaining: 3 }
      })
    ).toMatchObject({ totalCredit: 15 })
  })
})

describe('смена провайдера AI-доступа', () => {
  it('не позволяет молча отправить сохранённый ключ новому провайдеру', () => {
    expect(providerChangeError('openai', 'anthropic', '')).toBe(
      'При смене провайдера введи ключ для нового сервиса'
    )
  })

  it('не требует повторного ввода при правке того же провайдера', () => {
    expect(providerChangeError('openai', 'openai', '')).toBeNull()
    expect(providerChangeError('openai', 'anthropic', 'new-key')).toBeNull()
  })
})

describe('группировка реестра', () => {
  it('держит фиксированный порядок типов и не показывает пустые группы', () => {
    const groups = groupByKind([
      access('a', { kind: 'local' }),
      access('b', { kind: 'subscription' }),
      access('c', { kind: 'subscription' })
    ])
    expect(groups.map((g) => g.kind)).toEqual(['subscription', 'local'])
    expect(groups[0].items).toHaveLength(2)
  })
})

describe('итоги расхода', () => {
  it('складывает только выбранный источник и период', () => {
    const days = [
      day({ date: '2026-08-01', costUsd: 1, input: 100 }),
      day({ date: '2026-07-01', costUsd: 5, input: 500 }),
      day({ date: '2026-08-01', source: 'codex', costUsd: 9, input: 900 })
    ]
    const t = totalsFor(days, { since: '2026-07-15', source: 'claude-code' })
    expect(t.costUsd).toBe(1)
    expect(t.usage.input).toBe(100)
    expect(t.activeDays).toBe(1)
  })

  it('считает дни с расходом, а не число записей', () => {
    const days = [
      day({ date: '2026-08-01', model: 'a', costUsd: 1 }),
      day({ date: '2026-08-01', model: 'b', costUsd: 2 }),
      day({ date: '2026-08-02', model: 'a', costUsd: 3 })
    ]
    expect(totalsFor(days).activeDays).toBe(2)
    expect(totalsFor(days).costUsd).toBe(6)
  })

  it('ряд по дням не сжимает пропуски — иначе линия врёт про плотность', () => {
    const now = Date.parse('2026-08-03T12:00:00')
    const series = dailySeries([day({ date: '2026-08-01', costUsd: 4 })], 3, now)
    expect(series).toEqual([4, 0, 0])
  })

  it('разбивка по моделям идёт от дорогих к дешёвым', () => {
    const rows = byModel([day({ model: 'дешёвая', costUsd: 1 }), day({ model: 'дорогая', costUsd: 7 })])
    expect(rows.map((r) => r.model)).toEqual(['дорогая', 'дешёвая'])
  })
})

describe('деньги подписки', () => {
  const sub = (over: Partial<Subscription> = {}): Subscription => ({
    id: 's',
    name: 'Claude',
    provider: 'anthropic',
    category: 'AI',
    amount: 200,
    currency: 'USD',
    period: 'mo',
    nextRenewal: null,
    notes: null,
    manualRenewal: false,
    ...over
  })

  it('годовую подписку приводит к месяцу — иначе суммы несравнимы', () => {
    expect(monthlyCost(sub({ amount: 2400, period: 'yr' }))).toBe(200)
    expect(monthlyCost(sub())).toBe(200)
    expect(monthlyCost(undefined)).toBeNull()
  })

  it('окупаемость отличает «нечего считать» от нуля', () => {
    expect(subscriptionRoi(600, 200)).toBe(3)
    // Ни расхода, ни цены — это «не знаю», и показывать ×0 нельзя: чаще всего логи просто
    // ещё не прочитаны.
    expect(subscriptionRoi(0, 200)).toBeNull()
    expect(subscriptionRoi(600, null)).toBeNull()
    expect(subscriptionRoi(600, 0)).toBeNull()
  })
})

describe('срок жизни ключа', () => {
  const now = Date.parse('2026-08-03T15:00:00')

  it('считает по календарным суткам, а не по 24 часам', () => {
    // Ключ истекает завтра утром: по часам это меньше суток, но человеку важно «завтра».
    expect(daysUntilExpiry('2026-08-04', now)).toBe(1)
    expect(daysUntilExpiry('2026-08-03', now)).toBe(0)
    expect(daysUntilExpiry('2026-08-01', now)).toBe(-2)
  })

  it('нет даты или мусор вместо неё — не повод тревожить', () => {
    expect(daysUntilExpiry(null, now)).toBeNull()
    expect(daysUntilExpiry('когда-нибудь', now)).toBeNull()
  })

  it('во «внимание» попадают истёкшие, скоро истекающие и не принятые ключи', () => {
    const list = [
      access('ok'),
      access('expired', { status: 'expired' }),
      access('soon', { keyExpiresAt: '2026-08-10' }),
      access('later', { keyExpiresAt: '2026-12-01' }),
      access('dead')
    ]
    const ids = needsAttention(list, { dead: { status: 'invalid' } }, now).map((a) => a.id)
    expect(ids.sort()).toEqual(['dead', 'expired', 'soon'])
  })
})

describe('цены', () => {
  const price = (over: Partial<AiPrice> = {}): AiPrice => ({
    provider: 'anthropic',
    model: 'claude',
    input: 0.000003,
    output: 0.000015,
    cacheWrite: null,
    cacheWrite1h: null,
    cacheRead: null,
    contextTokens: 200000,
    maxOutputTokens: null,
    mode: 'chat',
    supportsVision: false,
    supportsTools: false,
    supportsCaching: false,
    deprecatedAt: null,
    source: 'catalog',
    fetchedAt: 0,
    ...over
  })

  it('неизвестная ставка показывается прочерком, а не нулём', () => {
    expect(priceLabel(null)).toBe('—')
    expect(priceLabel(0)).toBe('$0')
    expect(priceLabel(0.000003)).toBe('$3.00')
  })

  it('калькулятор сортирует по цене и отбрасывает модели без ставок', () => {
    const rows = calculate(
      [
        price({ model: 'дорогая', input: 0.00001, output: 0.00003 }),
        price({ model: 'дешёвая', input: 0.0000001, output: 0.0000002 }),
        price({ model: 'без цены', input: null, output: null })
      ],
      { input: 1_000_000, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    )
    expect(rows.map((r) => r.model)).toEqual(['дешёвая', 'дорогая'])
    expect(rows[1].costUsd).toBeCloseTo(10, 6)
  })
})

describe('даты периода', () => {
  it('отсчитывает календарные сутки назад', () => {
    const now = Date.parse('2026-03-02T10:00:00')
    expect(daysAgoDate(1, now)).toBe('2026-03-01')
    // Через границу месяца — самый частый способ ошибиться на день.
    expect(daysAgoDate(2, now)).toBe('2026-02-28')
  })
})

import { familyAccounts } from './ai-account'

// У владельца доступ к OpenAI идёт тремя путями сразу — подписка, роутер и ключ, — но почты у
// них одни и те же. Открыв любую запись, он должен видеть весь список.
describe('аккаунты семьи провайдера', () => {
  const withAccounts = (id: string, provider: string, emails: string[]): AiAccess =>
    access(id, { provider, accounts: emails.map((email) => ({ email })) })

  it('собирает аккаунты всех записей одной семьи', () => {
    const chatgpt = withAccounts('sub', 'openai', ['a@example.com', 'b@example.com'])
    const codex = withAccounts('cli', 'codex', ['c@example.com'])
    const claude = withAccounts('cl', 'anthropic', ['x@example.com'])

    const rows = familyAccounts(codex, [chatgpt, codex, claude])
    expect(rows.map((r) => r.account.email)).toEqual(['c@example.com', 'a@example.com', 'b@example.com'])
    // Действия адресуются той записи, где лежат учётные данные.
    expect(rows.find((r) => r.account.email === 'a@example.com')?.accessId).toBe('sub')
  })

  it('чужая семья не подмешивается', () => {
    const codex = withAccounts('cli', 'codex', ['c@example.com'])
    const claude = withAccounts('cl', 'anthropic', ['x@example.com'])
    expect(familyAccounts(claude, [codex, claude]).map((r) => r.account.email)).toEqual(['x@example.com'])
  })

  it('одна почта в двух записях показывается один раз', () => {
    const a = withAccounts('a', 'openai', ['dup@example.com'])
    const b = withAccounts('b', 'chatgpt', ['dup@example.com'])
    expect(familyAccounts(a, [a, b])).toHaveLength(1)
  })
})
