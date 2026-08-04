// Опознание счёта решает две разные вещи: показать ли кнопку входа и опрашивать ли счёт в фоне.
// Пока это были четыре отдельных регулярных выражения, они могли разойтись — и тогда счёт получал
// кнопку, но не опрашивался, либо наоборот. Отличить одно от другого на экране невозможно.
import { describe, expect, it } from 'vitest'
import { bankOf, isTinvest } from './banks'

const acc = (over: Partial<Parameters<typeof bankOf>[0]> = {}): Parameters<typeof bankOf>[0] => ({
  kind: 'bank',
  institution: '',
  name: '',
  ...over
})

describe('какой это банк', () => {
  it('Т-Банк опознаётся во всех написаниях', () => {
    for (const name of ['Т-Банк', 'Т Банк', 'Тинькофф', 'T-Bank', 'tbank', 'Tinkoff Black']) {
      expect(bankOf(acc({ name })), name).toBe('tbank')
    }
  })

  it('Сбербанк опознаётся', () => {
    expect(bankOf(acc({ name: 'Сбербанк' }))).toBe('sber')
    expect(bankOf(acc({ institution: 'Sberbank', name: 'основная карта' }))).toBe('sber')
  })

  it('незнакомый банк остаётся ручным счётом, а не угадывается', () => {
    expect(bankOf(acc({ name: 'Альфа-Банк' }))).toBeNull()
  })

  it('не банк — не банк, даже если назван как банк', () => {
    // Кабинет карточного счёта не при чём у брокера и биржи: у них свой путь через ключ.
    expect(bankOf(acc({ kind: 'broker', name: 'Т-Инвестиции' }))).toBeNull()
    expect(bankOf(acc({ kind: 'exchange', name: 'Тинькофф' }))).toBeNull()
  })
})

describe('брокерский счёт Т-Инвестиций', () => {
  it('опознаётся по названию и по организации', () => {
    expect(isTinvest(acc({ kind: 'broker', name: 'Т-Инвестиции' }))).toBe(true)
    expect(isTinvest(acc({ kind: 'broker', institution: 'Т-Банк', name: 'брокерский' }))).toBe(true)
  })

  it('карточный счёт того же банка брокерским не считается', () => {
    // Иначе к карте пошли бы с токеном брокера, а к брокеру — с сессией кабинета.
    expect(isTinvest(acc({ kind: 'bank', name: 'Т-Банк' }))).toBe(false)
  })

  it('чужой брокер не опознаётся', () => {
    expect(isTinvest(acc({ kind: 'broker', name: 'БКС' }))).toBe(false)
  })
})
