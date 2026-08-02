import { describe, it, expect } from 'vitest'
import { parseDeviceCost } from './finance-validation'

// Регрессия на реальный дефект: подписки и кошельки проверялись дважды — на границе IPC и в
// хранилище, — а устройства не проверялись ни разу. `devices:create` передавал объект от
// renderer насквозь.
describe('parseDeviceCost', () => {
  it('нормальная стоимость проходит', () => {
    expect(parseDeviceCost({ amount: 10.5, currency: 'EUR' })).toEqual({ amount: 10.5, currency: 'EUR' })
  })

  it('стоимости нет — это ноль в долларах, а не ошибка', () => {
    expect(parseDeviceCost(null)).toEqual({ amount: 0, currency: 'USD' })
    expect(parseDeviceCost(undefined)).toEqual({ amount: 0, currency: 'USD' })
    expect(parseDeviceCost({})).toEqual({ amount: 0, currency: 'USD' })
  })

  it('ОТРИЦАТЕЛЬНАЯ сумма отвергается', () => {
    // Она уменьшала общий месячный расход, а строка при этом пряталась фильтром `usd > 0` —
    // то есть деньги «испарялись» из итога незаметно.
    expect(() => parseDeviceCost({ amount: -100, currency: 'USD' })).toThrow(/отрицательной/)
  })

  it('НЕИЗВЕСТНАЯ валюта отвергается, а не считается по курсу 1', () => {
    // `FX[currency] ?? 1` означал, что «100 BTC» попадали в итог как «$100».
    expect(() => parseDeviceCost({ amount: 100, currency: 'BTC' })).toThrow(/не поддерживается/)
    expect(() => parseDeviceCost({ amount: 1, currency: 'XYZ' })).toThrow(/не поддерживается/)
  })

  it('не-числа и не-конечные значения отвергаются', () => {
    for (const bad of ['100', NaN, Infinity, -Infinity, {}, []]) {
      expect(() => parseDeviceCost({ amount: bad, currency: 'USD' })).toThrow()
    }
  })

  it('стоимость не объект — понятная ошибка, а не падение', () => {
    expect(() => parseDeviceCost('дорого')).toThrow(/ожидался объект/)
    expect(() => parseDeviceCost([1, 2])).toThrow(/ожидался объект/)
  })

  it('пересчёт в доллары от renderer не принимается', () => {
    // Курс знает хранилище; чужой арифметике в деньгах доверять незачем.
    const r = parseDeviceCost({ amount: 5, currency: 'USD', usd: 999_999 })
    expect(r).toEqual({ amount: 5, currency: 'USD' })
    expect('usd' in r).toBe(false)
  })
})
