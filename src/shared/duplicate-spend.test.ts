// Поиск трат, посчитанных дважды. Ошибка в обе стороны дорогая: пропустили — расход врёт вдвое
// и человек не понимает почему; склеили лишнее — предложение связать две РАЗНЫЕ траты, и после
// согласия одна из них исчезнет из расхода.
import { describe, expect, it } from 'vitest'
import { findDuplicateSpend, type SpendingDevice } from './duplicate-spend'
import type { Subscription } from '../main/types'

const device = (over: Partial<SpendingDevice> = {}): SpendingDevice => ({
  id: 'dev-1',
  name: 'HubVPN · Germany',
  provider: 'Hetzner',
  cost: { amount: 10, currency: 'EUR', usd: 10.8 },
  ...over
})

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 'sub-1',
  name: 'VPS Германия — мастер-панель HubVPN',
  provider: 'Hetzner',
  category: 'Hosting',
  amount: 10,
  currency: 'EUR',
  period: 'mo',
  nextRenewal: null,
  renewalDay: null,
  deviceId: null,
  notes: null,
  manualRenewal: false,
  ...over
})

describe('findDuplicateSpend', () => {
  it('находит сервер, за который уже платит подписка', () => {
    // Реальный случай владельца: названия совсем разные, но цена одна и слово «hubvpn» общее.
    const found = findDuplicateSpend([device()], [sub()])
    expect(found).toHaveLength(1)
    expect(found[0].deviceName).toBe('HubVPN · Germany')
    expect(found[0].subscriptionName).toBe('VPS Германия — мастер-панель HubVPN')
  })

  it('годовая подписка за тот же сервер — это те же деньги', () => {
    const found = findDuplicateSpend([device()], [sub({ amount: 120, period: 'yr' })])
    expect(found).toHaveLength(1)
  })

  it('одна сумма без общего слова — это две РАЗНЫЕ траты', () => {
    // Две ноды по 10 € у разных хостеров склеивать нельзя.
    expect(findDuplicateSpend([device()], [sub({ name: 'Spotify', provider: 'Spotify' })])).toEqual([])
  })

  it('разная валюта или сумма не считается совпадением', () => {
    expect(findDuplicateSpend([device()], [sub({ currency: 'USD' })])).toEqual([])
    expect(findDuplicateSpend([device()], [sub({ amount: 12 })])).toEqual([])
  })

  it('имя устройства целиком внутри названия платежа — этого достаточно', () => {
    // Реальный случай владельца: сервер «FX-Analytics» за $12 и платёж «VPS Нью-Йорк —
    // FX-Analytics» за €9.79. Валюты разные, суммы разные — совпадение сумм тут не поможет, а
    // полное вхождение имени случайным не бывает.
    const found = findDuplicateSpend(
      [device({ id: 'fx', name: 'FX-Analytics', provider: 'FirstByte', cost: { amount: 12, currency: 'USD', usd: 12 } })],
      [sub({ name: 'VPS Нью-Йорк — FX-Analytics', provider: 'FirstByte', amount: 9.79, currency: 'EUR' })]
    )
    expect(found).toHaveLength(1)
    expect(found[0].reason).toContain('FX-Analytics')
  })

  it('уже связанное не предлагается повторно', () => {
    expect(findDuplicateSpend([device()], [sub({ deviceId: 'dev-1' })])).toEqual([])
  })

  it('одна подписка не предлагается двум устройствам сразу', () => {
    // Иначе «Облако Москва» и «HubVPN · Germany» по 10 € оба указали бы на один платёж.
    const found = findDuplicateSpend(
      [device(), device({ id: 'dev-2', name: 'HubVPN · Moscow' })],
      [sub()]
    )
    expect(found).toHaveLength(1)
  })
})
