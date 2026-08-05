// Засев подписок трогает деньги: ошибка здесь либо заводит дубль (и месячный итог врёт вдвое),
// либо затирает правку, сделанную руками, либо молча оставляет устаревшую сумму.
import { describe, expect, it } from 'vitest'
import { planSubsSeed, type SubsSeedFile,
  laterRenewal
} from './subs-seed'
import type { Subscription } from './types'

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 'id',
  name: 'Boosty — erafox',
  provider: 'Boosty',
  category: 'Media',
  amount: 499,
  currency: 'RUB',
  period: 'mo',
  nextRenewal: '2026-08-10',
  notes: null,
  manualRenewal: false,
  ...over
})

describe('план засева подписок', () => {
  it('новая подписка заводится', () => {
    const file: SubsSeedFile = { subscriptions: [{ name: 'Boosty — erafox', amount: 499, currency: 'RUB' }] }
    const plan = planSubsSeed(file, [])
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0].amount).toBe(499)
  })

  it('совпадение ищется по названию без учёта регистра — дубля не будет', () => {
    // Идентификаторов в файле нет и быть не может: его пишет человек. Единственный ключ —
    // название, и «Boosty — Erafox» с «boosty — erafox» обязаны быть одной подпиской.
    const plan = planSubsSeed({ subscriptions: [{ name: 'BOOSTY — ERAFOX', amount: 499 }] }, [sub()])
    expect(plan.create).toHaveLength(0)
  })

  it('изменившаяся сумма обновляется', () => {
    // Устаревшая сумма хуже отсутствующей: она выглядит достоверной и молча врёт в месячном итоге.
    const plan = planSubsSeed({ subscriptions: [{ name: 'Boosty — erafox', amount: 599 }] }, [sub()])
    expect(plan.update).toHaveLength(1)
    expect(plan.update[0].input.amount).toBe(599)
  })

  it('совпадающая запись в план не попадает вовсе', () => {
    // Иначе каждый запуск писал бы в базу и рассылал «данные изменились» без единого изменения.
    const file: SubsSeedFile = {
      subscriptions: [
        {
          name: 'Boosty — erafox',
          provider: 'Boosty',
          category: 'Media',
          amount: 499,
          currency: 'RUB',
          period: 'mo',
          nextRenewal: '2026-08-10',
          notes: null,
          manualRenewal: false
        }
      ]
    }
    const plan = planSubsSeed(file, [sub()])
    expect(plan).toEqual({ create: [], update: [], retire: [], seeded: [] })
  })

  it('поле, которого в файле нет, остаётся прежним', () => {
    // Файл знает про деньги, но не знает про заметку, которую владелец дописал в приложении.
    const plan = planSubsSeed({ subscriptions: [{ name: 'Boosty — erafox', amount: 599 }] }, [
      sub({ notes: 'моя заметка', category: 'Other' })
    ])
    expect(plan.update[0].input.notes).toBe('моя заметка')
    expect(plan.update[0].input.category).toBe('Other')
  })

  it('явный null в файле стирает поле, а отсутствие — нет', () => {
    const plan = planSubsSeed({ subscriptions: [{ name: 'Boosty — erafox', nextRenewal: null }] }, [sub()])
    expect(plan.update[0].input.nextRenewal).toBeNull()
  })

  it('выбывшая подписка убирается и заново не заводится', () => {
    const file: SubsSeedFile = {
      subscriptions: [{ name: 'Boosty — erafox', amount: 499 }],
      retire: ['Boosty — erafox']
    }
    const plan = planSubsSeed(file, [sub()])
    expect(plan.retire).toEqual(['id'])
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([])
  })

  it('запись без названия пропускается, а не заводит безымянную подписку', () => {
    expect(planSubsSeed({ subscriptions: [{ name: '   ', amount: 10 }] }, []).create).toEqual([])
  })

  it('пустой файл ничего не ломает', () => {
    expect(planSubsSeed({}, [sub()])).toEqual({ create: [], update: [], retire: [], seeded: [] })
  })
})

describe('дата продления против файла', () => {
  it('продление, отмеченное владельцем, не откатывается назад', () => {
    // Кнопка «Продлено» двигает дату на оплаченный период. Если файл вернёт свою, сторож снова
    // скажет «срок прошёл», и нажатие окажется бесполезным — каждый запуск подряд.
    const plan = planSubsSeed({ subscriptions: [{ name: 'Boosty — erafox', nextRenewal: '2026-08-10' }] }, [
      sub({ nextRenewal: '2026-09-10' })
    ])
    expect(plan.update).toEqual([])
  })

  it('дата из файла применяется, если она позже', () => {
    const plan = planSubsSeed({ subscriptions: [{ name: 'Boosty — erafox', nextRenewal: '2026-10-10' }] }, [
      sub({ nextRenewal: '2026-08-10' })
    ])
    expect(plan.update[0].input.nextRenewal).toBe('2026-10-10')
  })

  it('удалённая владельцем подписка НЕ воскресает при следующем входе', () => {
    // Засев идёт на каждом открытии хранилища и не отличает «записи ещё нет» от «её удалили».
    // Пока памяти о принесённом не было, корзина в интерфейсе не работала вовсе: подписка
    // возвращалась при следующем входе — с новым id и снова в месячном расходе.
    const file: SubsSeedFile = { subscriptions: [{ name: 'Boosty — erafox', amount: 499 }] }
    const first = planSubsSeed(file, [])
    expect(first.create).toHaveLength(1)
    expect(first.seeded).toEqual(['boosty — erafox'])

    // Второй вход: запись уже приносили, в хранилище её нет — значит владелец её убрал.
    const second = planSubsSeed(file, [], new Set(first.seeded))
    expect(second.create).toEqual([])
  })

  it('переименованная подписка не двоится', () => {
    // Совпадение ищется по имени, поэтому после переименования старое имя в базе не находится.
    // Раньше это читалось как «новая запись» и заводило вторую — обе попадали в расход.
    const file: SubsSeedFile = { subscriptions: [{ name: 'Boosty — erafox', amount: 499 }] }
    const renamed = sub({ name: 'Boosty (Erafox)' })
    const plan = planSubsSeed(file, [renamed], new Set(['boosty — erafox']))
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([])
  })

  it('память засева не мешает заводить НОВЫЕ записи из файла', () => {
    const file: SubsSeedFile = {
      subscriptions: [
        { name: 'Boosty — erafox', amount: 499 },
        { name: 'Новая подписка', amount: 100 }
      ]
    }
    const plan = planSubsSeed(file, [], new Set(['boosty — erafox']))
    expect(plan.create.map((c) => c.name)).toEqual(['Новая подписка'])
    expect(plan.seeded).toEqual(['новая подписка'])
  })

  it('какая дата побеждает', () => {
    expect(laterRenewal(undefined, '2026-09-10')).toBe('2026-09-10')
    expect(laterRenewal(null, '2026-09-10')).toBeNull()
    expect(laterRenewal('2026-08-10', null)).toBe('2026-08-10')
    expect(laterRenewal('2026-08-10', '2026-09-10')).toBe('2026-09-10')
  })
})
