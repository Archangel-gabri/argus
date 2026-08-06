// Лимиты правятся формой, которая знает про них не всё. Цена ошибки — молча потерянный потолок:
// экран после этого показывает оценку вместо факта, и заметить подмену можно только по бледности
// полосы.
import { describe, expect, it } from 'vitest'
import { mergeLimits } from './ai-limits'

describe('mergeLimits', () => {
  it('сохраняет лимиты, которых в форме нет', () => {
    const stored = { rpm: 10, tpd: 1_000_000, weekTokens: 5_000_000, rpmo: 300 }
    const fromForm = { rpm: 20, rpd: null, windowHours: 5, windowTokens: null }
    expect(mergeLimits(stored, fromForm)).toEqual({
      rpm: 20,
      rpd: null,
      windowHours: 5,
      windowTokens: null,
      tpd: 1_000_000,
      weekTokens: 5_000_000,
      rpmo: 300
    })
  })

  it('null от формы снимает лимит — иначе введённый потолок не убрать', () => {
    expect(mergeLimits({ rpm: 10 }, { rpm: null })).toEqual({ rpm: null })
  })

  it('без прежних лимитов возвращает то, что задала форма', () => {
    expect(mergeLimits(undefined, { rpm: 5 })).toEqual({ rpm: 5 })
  })
})

describe('неразобранный ввод не стирает потолок', () => {
  it('буквы в поле оставляют прежнее значение', () => {
    // Форма отдаёт `undefined`, когда ввод не разобрался. Раньше он приходил как `null`, а
    // `null` означает «снять потолок» — и одна опечатка молча стирала заданное число.
    expect(mergeLimits({ tpd: 1_000_000 }, { tpd: undefined })).toEqual({ tpd: 1_000_000 })
  })

  it('пустое поле по-прежнему снимает потолок', () => {
    expect(mergeLimits({ tpd: 1_000_000 }, { tpd: null })).toEqual({ tpd: null })
  })
})
