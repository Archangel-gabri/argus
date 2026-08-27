// Деньги в контракте Т-Инвестиций лежат в формате, который ломается тихо: целая часть приходит
// СТРОКОЙ, дробная — в миллиардных долях, и у отрицательной суммы отрицательны оба поля.
import { describe, expect, it } from 'vitest'
import { moneyValue, parseAccounts, parsePortfolioTotal } from './tinvest'

describe('денежное значение', () => {
  it('целая часть строкой не склеивается с дробной', () => {
    // `'100' + 0.5` в JavaScript даёт «1000.5». Именно так выглядит эта ошибка: не падением,
    // а суммой, увеличенной в десять раз.
    expect(moneyValue({ units: '100', nano: 500000000, currency: 'rub' })?.amount).toBe(100.5)
  })

  it('отрицательная сумма складывается как есть', () => {
    // У долга отрицательны ОБА поля. Взять модуль дробной части — значит прибавить её к долгу.
    expect(moneyValue({ units: '-100', nano: -500000000, currency: 'RUB' })?.amount).toBe(-100.5)
  })

  it('целое число без дробной части', () => {
    expect(moneyValue({ units: '42', nano: 0, currency: 'RUB' })?.amount).toBe(42)
  })

  it('валюта приводится к верхнему регистру, по умолчанию рубли', () => {
    expect(moneyValue({ units: '1', nano: 0, currency: 'usd' })?.currency).toBe('USD')
    expect(moneyValue({ units: '1', nano: 0 })?.currency).toBe('RUB')
  })

  it('мусор не превращается в ноль', () => {
    // Ноль означал бы «на счету пусто» — а мы просто не поняли ответ.
    expect(moneyValue(null)).toBeNull()
    expect(moneyValue({ nano: 5 })).toBeNull()
    expect(moneyValue({ units: 'abc', nano: 0 })).toBeNull()
  })
})

describe('счета', () => {
  const answer = {
    accounts: [
      { id: '2000000001', name: 'Брокерский счёт', status: 'ACCOUNT_STATUS_OPEN' },
      { id: '2000000002', name: 'Закрытый', status: 'ACCOUNT_STATUS_CLOSED' },
      { id: '2000000003', name: 'Новый', status: 'ACCOUNT_STATUS_NEW' }
    ]
  }

  it('открытые отделяются от закрытых', () => {
    // Закрытый счёт продолжает возвращаться списком, и портфель у него пустой. Сложить его с
    // открытым — занизить итог, причём без единого признака ошибки.
    const accounts = parseAccounts(answer)
    expect(accounts).toHaveLength(3)
    expect(accounts.filter((a) => a.open).map((a) => a.id)).toEqual(['2000000001'])
  })

  it('запись без идентификатора пропускается', () => {
    expect(parseAccounts({ accounts: [{ name: 'без id', status: 'ACCOUNT_STATUS_OPEN' }] })).toEqual([])
  })

  it('чужой ответ не превращается в счета', () => {
    expect(parseAccounts(null)).toEqual([])
    expect(parseAccounts({ hello: 1 })).toEqual([])
  })
})

describe('портфель', () => {
  it('общая стоимость читается из totalAmountPortfolio', () => {
    const total = parsePortfolioTotal({
      totalAmountShares: { units: '1000', nano: 0, currency: 'rub' },
      totalAmountPortfolio: { units: '85320', nano: 450000000, currency: 'rub' }
    })
    expect(total).toEqual({ amount: 85320.45, currency: 'RUB' })
  })

  it('ответ без общей стоимости не даёт нуля', () => {
    expect(parsePortfolioTotal({ totalAmountShares: { units: '10', nano: 0 } })).toBeNull()
    expect(parsePortfolioTotal({})).toBeNull()
  })
})
