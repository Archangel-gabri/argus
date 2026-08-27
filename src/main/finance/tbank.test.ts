// Кабинет банка отвечает HTTP 200 даже когда отказывает. Если смотреть только на код ответа,
// протухшая сессия выглядит как счёт без денег — то есть на экране появляется ноль вместо
// «войдите заново». Это главная ошибка, которую здесь можно совершить.
import { describe, expect, it } from 'vitest'
import { fetchTbankBalance, parseAccounts } from './tbank'

const NOW = Date.parse('2026-08-04T21:00:00Z')

const answer = {
  resultCode: 'OK',
  payload: [
    { name: 'Black', accountType: 'Current', moneyAmount: { value: 42350.75, currency: { name: 'RUB' } } },
    { name: 'Black USD', accountType: 'Current', moneyAmount: { value: 120.5, currency: { name: 'USD' } } },
    { name: 'Накопительный счет', accountType: 'Saving', moneyAmount: { value: 100000, currency: { name: 'RUB' } } }
  ]
}

describe('разбор ответа кабинета', () => {
  it('счета читаются, суммы складываются по валютам раздельно', () => {
    // Рубли и доллары не сводятся: курс придумывать не наше дело.
    const r = parseAccounts(answer, NOW)
    expect(r.status).toBe('ok')
    expect(r.accounts).toHaveLength(3)
    expect(r.totals).toEqual({ RUB: 142350.75, USD: 120.5 })
  })

  it('истёкшая сессия — это «войдите заново», а не ноль на счету', () => {
    const r = parseAccounts({ resultCode: 'INSUFFICIENT_PRIVILEGES', payload: [] }, NOW)
    expect(r.status).toBe('no-session')
    expect(r.totals).toEqual({})
    expect(r.error).toMatch(/войдите/i)
  })

  it('другой отказ не выдаётся за истёкшую сессию', () => {
    const r = parseAccounts({ resultCode: 'INTERNAL_ERROR' }, NOW)
    expect(r.status).toBe('error')
    expect(r.error).toContain('INTERNAL_ERROR')
  })

  it('счёт без суммы пропускается, а не считается нулевым', () => {
    // Ноль означал бы «пусто», а мы просто не увидели цифру.
    const r = parseAccounts(
      { resultCode: 'OK', payload: [{ name: 'Кредитка', accountType: 'Credit', moneyAmount: { currency: { name: 'RUB' } } }] },
      NOW
    )
    expect(r.status).toBe('error')
    expect(r.accounts).toEqual([])
  })

  it('валюта без указания считается рублями, регистр приводится', () => {
    const r = parseAccounts(
      { resultCode: 'OK', payload: [{ name: 'счёт', moneyAmount: { value: 10, currency: { name: 'rub' } } }] },
      NOW
    )
    expect(r.totals).toEqual({ RUB: 10 })
  })

  it('мусор вместо ответа не превращается в счета', () => {
    expect(parseAccounts(null, NOW).status).toBe('error')
    expect(parseAccounts({ resultCode: 'OK', payload: 'нет' }, NOW).status).toBe('error')
  })
})

describe('поход в кабинет', () => {
  const answerOf = (body: unknown) => async () => ({ ok: true, status: 200, body: JSON.stringify(body) })
  const alive = { hasSession: async () => true, sessionId: async () => 'session-id' }

  it('без входа запрос не делается вовсе', async () => {
    // Иначе на экране будет «кабинет отверг», хотя честный ответ — «войдите».
    const r = await fetchTbankBalance({ hasSession: async () => false, sessionId: async () => null, request: answerOf({}) }, NOW)
    expect(r.status).toBe('no-session')
    expect(r.error).toMatch(/войдите/i)
    expect(r.fetchedAt).toBe(NOW)
  })

  it('вход был, но куки сессии нет — тоже «войдите», а не ошибка', async () => {
    const r = await fetchTbankBalance({ hasSession: async () => true, sessionId: async () => null, request: answerOf({}) }, NOW)
    expect(r.status).toBe('no-session')
  })

  it('обрыв связи — отдельное состояние, не мёртвая сессия', async () => {
    // Иначе владельца позовут входить заново там, где входить некуда: сети нет.
    const r = await fetchTbankBalance(
      { ...alive, request: async () => ({ ok: false, status: 0, body: '', offline: true }) },
      NOW
    )
    expect(r.status).toBe('offline')
  })

  it('живая сессия даёт остатки', async () => {
    const r = await fetchTbankBalance(
      { ...alive, request: answerOf(answer) },
      NOW
    )
    expect(r.status).toBe('ok')
    expect(r.totals).toEqual({ RUB: 142350.75, USD: 120.5 })
  })

  it('истёкшая сессия видна по телу ответа, а не по коду HTTP', async () => {
    const r = await fetchTbankBalance(
      { ...alive, request: answerOf({ resultCode: 'INSUFFICIENT_PRIVILEGES' }) },
      NOW
    )
    expect(r.status).toBe('no-session')
  })

  it('нечитаемый ответ не превращается в нулевой баланс', async () => {
    const r = await fetchTbankBalance(
      { ...alive, request: async () => ({ ok: true, status: 200, body: 'не json' }) },
      NOW
    )
    expect(r.status).toBe('error')
    expect(r.totals).toEqual({})
  })
})
