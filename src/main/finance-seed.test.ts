// Засев счетов обязан быть безопасным для ДЕНЕГ. Ошибка здесь либо заведёт дубль банка, либо —
// и это хуже — откатит свежий остаток к цифре, записанной в файле полгода назад, причём выглядеть
// это будет как нормальная работа.
import { describe, expect, it } from 'vitest'
import { planFinanceSeed, type FinanceSeedFile } from './finance-seed'
import type { FinanceAccount } from './types'

const acc = (over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: 'a1',
  kind: 'bank',
  name: 'Сбербанк',
  institution: 'Сбербанк',
  currency: 'RUB',
  source: 'manual',
  balance: 42_000,
  balanceAt: Date.parse('2026-08-04'),
  keyRef: null,
  notes: null,
  createdAt: 0,
  ...over
})

describe('план засева счетов', () => {
  it('новый счёт заводится', () => {
    const file: FinanceSeedFile = { accounts: [{ name: 'Т-Банк', kind: 'bank', currency: 'RUB' }] }
    const plan = planFinanceSeed(file, [])
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0].name).toBe('Т-Банк')
  })

  it('остаток существующего счёта засев НЕ трогает', () => {
    // Файл знает, какие счета есть, но не может знать, сколько на них сейчас денег: он писался
    // один раз. Позволить ему переписывать остаток — значит откатывать свежую цифру при каждом
    // запуске, и владелец увидит позавчерашние деньги как сегодняшние.
    const file: FinanceSeedFile = { accounts: [{ name: 'Сбербанк', balance: 999, notes: 'новая заметка' }] }
    const plan = planFinanceSeed(file, [acc()])
    expect(plan.update).toHaveLength(1)
    expect(plan.update[0].input).not.toHaveProperty('balance')
    expect(plan.update[0].input.notes).toBe('новая заметка')
  })

  it('стартовый остаток разрешён только при заведении', () => {
    const plan = planFinanceSeed({ accounts: [{ name: 'Наличные', kind: 'cash', balance: 5000 }] }, [])
    expect(plan.create[0].balance).toBe(5000)
  })

  it('совпадение по названию без учёта регистра — дубля банка не будет', () => {
    expect(planFinanceSeed({ accounts: [{ name: 'СБЕРБАНК' }] }, [acc()]).create).toEqual([])
  })

  it('счёт, ничем не отличающийся от файла, в план не попадает', () => {
    const file: FinanceSeedFile = {
      accounts: [{ name: 'Сбербанк', kind: 'bank', institution: 'Сбербанк', currency: 'RUB', source: 'manual' }]
    }
    expect(planFinanceSeed(file, [acc()])).toEqual({ create: [], update: [], retire: [], seeded: [] })
  })

  it('закрытый счёт убирается и заново не заводится', () => {
    const file: FinanceSeedFile = { accounts: [{ name: 'Сбербанк' }], retire: ['Сбербанк'] }
    const plan = planFinanceSeed(file, [acc()])
    expect(plan.retire).toEqual(['a1'])
    expect(plan.create).toEqual([])
  })

  it('счёт без названия пропускается', () => {
    expect(planFinanceSeed({ accounts: [{ name: '  ' }] }, []).create).toEqual([])
  })

  it('пустой файл ничего не ломает', () => {
    expect(planFinanceSeed({}, [acc()])).toEqual({ create: [], update: [], retire: [], seeded: [] })
  })

  it('удалённый владельцем счёт НЕ воскресает при следующем входе', () => {
    // Тот же дефект, что был у подписок: засев идёт на каждом открытии хранилища и не отличает
    // «счёта ещё нет» от «его удалили». Корзина в интерфейсе не работала — счёт возвращался.
    const file: FinanceSeedFile = { accounts: [{ name: 'Т-Банк', kind: 'bank', currency: 'RUB' }] }
    const first = planFinanceSeed(file, [])
    expect(first.create).toHaveLength(1)
    expect(first.seeded).toEqual(['т-банк'])

    const second = planFinanceSeed(file, [], new Set(first.seeded))
    expect(second.create).toEqual([])
  })
})
