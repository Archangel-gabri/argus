// Квоты приходят от разных сервисов в разных форматах, и каждый формат по-своему подставляет
// подножку: остаток вместо израсходованного, счётчик ключа вместо счётчика аккаунта, ноль,
// который на самом деле означает «включённого расхода нет вовсе».
import { describe, expect, it } from 'vitest'
import {
  parseAnthropicUsage,
  parseCursorUsage,
  parseFirecrawl,
  parseOpenRouterCredits,
  parseTavily,
  quotaKindOf,
  needsBrowser,
  fetchQuota
} from './ai-quota'
import type { AiAccess } from './types'

describe('квота Firecrawl', () => {
  it('остаток превращается в израсходованное', () => {
    // Сервис отдаёт ОСТАТОК, а показываем мы «сколько ушло из скольких» — иначе полная полоса
    // означала бы исчерпанную квоту.
    const [credits] = parseFirecrawl(
      { data: { remainingCredits: 940, planCredits: 1000, billingPeriodEnd: '2026-08-30T00:17:32.860Z' } },
      null
    )
    expect(credits.used).toBe(60)
    expect(credits.limit).toBe(1000)
    expect(credits.unit).toBe('кредитов')
    expect(new Date(credits.resetsAt as number).getUTCMonth()).toBe(7)
  })

  it('кредиты и токены — два разных счётчика, и оба свои', () => {
    const slices = parseFirecrawl(
      { data: { remainingCredits: 997, planCredits: 1000 } },
      { data: { remainingTokens: 14955, planTokens: 15000 } }
    )
    expect(slices.map((s) => s.scope)).toEqual(['period', 'tokens'])
    expect(slices[1].used).toBe(45)
    expect(slices[1].unit).toBe('токенов')
  })

  it('нетронутая квота — это ноль израсходованного, а не пустой ответ', () => {
    expect(parseFirecrawl({ data: { remainingCredits: 1000, planCredits: 1000 } }, null)[0].used).toBe(0)
  })

  it('мусор вместо ответа не превращается в нули', () => {
    expect(parseFirecrawl(null, null)).toEqual([])
    expect(parseFirecrawl({ data: {} }, null)).toEqual([])
  })
})

describe('квота Tavily', () => {
  it('берёт израсходованное и предел плана, а не счётчик ключа', () => {
    // У ключа свой счётчик без лимита; предел живёт на уровне аккаунта.
    const [q] = parseTavily({
      key: { usage: 54, limit: null },
      account: { current_plan: 'Researcher', plan_usage: 54, plan_limit: 1000 }
    })
    expect(q).toMatchObject({ used: 54, limit: 1000, unit: 'кредитов', plan: 'Researcher' })
    expect(q.ratio).toBeCloseTo(0.054)
  })

  it('без данных аккаунта квоты нет', () => {
    expect(parseTavily({ key: { usage: 10 } })).toEqual([])
  })
})

describe('квота Anthropic', () => {
  const answer = {
    five_hour: { utilization: 24, resets_at: '2026-08-04T18:49:59Z' },
    seven_day: { utilization: 27, resets_at: '2026-08-08T12:59:59Z' },
    limits: [
      { kind: 'session', percent: 24, resets_at: '2026-08-04T18:49:59Z', scope: null },
      { kind: 'weekly_all', percent: 27, resets_at: '2026-08-08T12:59:59Z', scope: null },
      { kind: 'weekly_scoped', percent: 3, resets_at: '2026-08-08T12:59:59Z', scope: { model: { display_name: 'Fable' } } }
    ]
  }

  it('доля приходит готовой и не пересчитывается', () => {
    const slices = parseAnthropicUsage(answer)
    expect(slices.map((s) => s.scope)).toEqual(['session', 'week', 'week-model'])
    expect(slices[0].ratio).toBeCloseTo(0.24)
    expect(slices[0].label).toBe('Текущая сессия')
  })

  it('знаменателя нет — и он не выдумывается', () => {
    // Anthropic публикует проценты и не публикует потолок. Подставить сюда токены из локальных
    // логов значило бы построить дробь, у которой числитель с одной машины, а знаменатель со всех.
    for (const s of parseAnthropicUsage(answer)) {
      expect(s.used).toBeNull()
      expect(s.limit).toBeNull()
    }
  })

  it('лимит на отдельную модель подписывается ею', () => {
    const scoped = parseAnthropicUsage(answer).find((s) => s.scope === 'week-model')
    expect(scoped?.label).toBe('Неделя · Fable')
    expect(scoped?.model).toBe('Fable')
  })

  it('чужой ответ не превращается в квоту', () => {
    expect(parseAnthropicUsage(null)).toEqual([])
    expect(parseAnthropicUsage({ hello: 1 })).toEqual([])
  })
})

describe('квота Cursor', () => {
  it('бесплатный тариф с нулевым лимитом — это не «нет данных»', () => {
    // limit === 0 означает «включённого расхода нет вовсе». Доля при этом не считается: делить
    // не на что, а тариф и дату сказать можно.
    const [q] = parseCursorUsage({
      membershipType: 'free',
      billingCycleEnd: '2026-08-09T16:58:57.427Z',
      individualUsage: { plan: { used: 0, limit: 0 } }
    })
    expect(q.plan).toBe('free')
    expect(q.limit).toBe(0)
    expect(q.ratio).toBeNull()
  })

  it('платный тариф даёт долю', () => {
    const [q] = parseCursorUsage({ membershipType: 'pro', individualUsage: { plan: { used: 5, limit: 20 } } })
    expect(q.ratio).toBeCloseTo(0.25)
  })
})

describe('квота OpenRouter', () => {
  it('внесено и истрачено', () => {
    const [q] = parseOpenRouterCredits({ data: { total_credits: 20, total_usage: 19.79 } })
    expect(q.used).toBeCloseTo(19.79)
    expect(q.limit).toBe(20)
    expect(q.unit).toBe('$')
  })
})

describe('кого чем спрашивать', () => {
  const base = { provider: 'other', label: 'Cursor' }

  it('Cursor опознаётся по названию — своей семьёй провайдеров он не является', () => {
    expect(quotaKindOf(base)).toBe('cursor')
    expect(quotaKindOf({ provider: 'anthropic', label: 'Claude Max 5x' })).toBe('anthropic')
  })

  it('сервис без публичной квоты не опознаётся вовсе', () => {
    expect(quotaKindOf({ provider: 'gemini', label: 'Google AI Studio' })).toBeNull()
    expect(quotaKindOf({ provider: 'openai', label: 'ChatGPT' })).toBeNull()
  })

  it('подписки спрашиваются браузером: ключа у них не бывает', () => {
    expect(needsBrowser('anthropic')).toBe(true)
    expect(needsBrowser('cursor')).toBe(true)
    expect(needsBrowser('openrouter')).toBe(false)
  })
})

describe('поход за квотой', () => {
  const access = { id: 'a1', provider: 'anthropic', label: 'Claude Max 5x' } as AiAccess

  it('без сессии в браузере запрос не делается вовсе', async () => {
    // Ходить в сеть без куки бессмысленно: ответ будет 401, а на экране появится ложное
    // «сервис отказал» вместо честного «в браузере не залогинены».
    const r = await fetchQuota(access, null, () => ({}))
    expect(r).toEqual({ slices: [], via: 'browser', problem: 'no-session' })
  })

  it('сервис без квоты не считается сломанным', async () => {
    const r = await fetchQuota({ id: 'b', provider: 'gemini', label: 'Gemini' } as AiAccess, 'k', () => ({}))
    expect(r.slices).toEqual([])
    expect(r.problem).toBeUndefined()
  })

  it('ключевой сервис без ключа сообщает именно об этом', async () => {
    const r = await fetchQuota({ id: 'c', provider: 'tavily', label: 'Tavily' } as AiAccess, null, () => ({}))
    expect(r).toEqual({ slices: [], via: 'key', problem: 'no-key' })
  })
})
