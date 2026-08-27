// Связывание сервера с платежом за него. Ошибка здесь дорогая в обе стороны: не связали —
// месячный расход завышен и владелец не понимает почему; связали лишнего — трата молча пропала
// из итога, а это хуже, потому что незаметно.
import { describe, expect, it } from 'vitest'
import { planSpendLinks } from './spend-link'
import type { Subscription } from '../types'

const device = (
  id: string,
  name: string,
  amount: number,
  currency = 'EUR'
): { id: string; name: string; provider: string; cost: { amount: number; currency: string; usd: number } } => ({
  id,
  name,
  provider: 'Hetzner',
  cost: { amount, currency, usd: amount }
})

const sub = (id: string, name: string, amount: number, extra: Partial<Subscription> = {}): Subscription => ({
  id,
  name,
  provider: '',
  category: 'Infra',
  amount,
  currency: 'EUR',
  period: 'mo',
  nextRenewal: null,
  renewalDay: null,
  deviceId: null,
  notes: null,
  manualRenewal: false,
  ...extra
})

describe('planSpendLinks', () => {
  it('связывает сервер с платежом, названным иначе', () => {
    // Настоящая пара владельца: в парке «HubVPN · Germany», в подписках — полное название.
    const plan = planSpendLinks(
      [device('d1', 'HubVPN · Germany', 10)],
      [sub('s1', 'VPS Германия — мастер-панель HubVPN', 10)],
      new Set()
    )
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ deviceId: 'd1', subscriptionId: 's1' })
  })

  it('не связывает второй раз то, что владелец отвязал', () => {
    // Память ставится на устройство и переживает разрыв связи. Без этого приложение
    // восстанавливало бы связь при каждом открытии хранилища, и спорить с ним было бы нечем.
    const plan = planSpendLinks(
      [device('d1', 'HubVPN · Germany', 10)],
      [sub('s1', 'VPS Германия — мастер-панель HubVPN', 10)],
      new Set(['d1'])
    )
    expect(plan).toEqual([])
  })

  it('две одинаковые по цене ноды не склеиваются в одну', () => {
    // Равная сумма сама по себе ничего не значит: узлы одного хостера стоят одинаково.
    // Совпасть должно ещё и слово в названии.
    const plan = planSpendLinks(
      [device('d1', 'HubVPN · Germany', 10), device('d2', 'HubVPN · Helsinki', 10)],
      [sub('s1', 'VPS Германия — мастер-панель HubVPN', 10)],
      new Set()
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].deviceId).toBe('d1')
  })

  it('уже связанную подписку второму серверу не отдаёт', () => {
    const plan = planSpendLinks(
      [device('d2', 'HubVPN · Germany', 10)],
      [sub('s1', 'VPS Германия — мастер-панель HubVPN', 10, { deviceId: 'd1' })],
      new Set()
    )
    expect(plan).toEqual([])
  })

  it('сервер без цены связывать не с чем', () => {
    // У бесплатной или чужой машины своей траты нет, и двойного счёта тоже.
    const plan = planSpendLinks(
      [device('d1', 'HubVPN · Germany', 0)],
      [sub('s1', 'VPS Германия — мастер-панель HubVPN', 10)],
      new Set()
    )
    expect(plan).toEqual([])
  })
})
