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
  it('без куки сессии запрос не делается вовсе', async () => {
    // Иначе на экране будет «кабинет отверг», хотя честный ответ — «в браузере не залогинены».
    const r = await fetchTbankBalance(() => ({}), NOW)
    expect(r.status).toBe('no-session')
    expect(r.error).toMatch(/не залогинены|войдите/i)
    expect(r.fetchedAt).toBe(NOW)
  })
})
