import { describe, expect, it } from 'vitest'
import { legacyManualRenewal, parseSubscriptionInput, parseWalletInput } from './finance-validation'

describe('runtime-граница финансового IPC', () => {
  it('однократно переносит старую пометку из notes в явное поле', () => {
    expect(legacyManualRenewal('Продлевать вручную 13-го')).toBe(true)
    expect(legacyManualRenewal('автосписание')).toBe(false)
    expect(legacyManualRenewal(null)).toBe(false)
  })

  it('нормализует полную подписку и сохраняет явное ручное продление', () => {
    expect(
      parseSubscriptionInput({
        name: '  VPS  ',
        provider: '  OVH ',
        category: 'Hosting',
        amount: 12.5,
        currency: 'EUR',
        period: 'mo',
        nextRenewal: '2026-08-13',
        notes: ' панель ',
        manualRenewal: true
      })
    ).toEqual({
      name: 'VPS',
      provider: 'OVH',
      category: 'Hosting',
      amount: 12.5,
      currency: 'EUR',
      period: 'mo',
      nextRenewal: '2026-08-13',
      notes: 'панель',
      manualRenewal: true
    })
  })

  it.each([
    [{ name: '', amount: 1 }, /назван/i],
    [{ name: 'X', amount: -1 }, /сумм/i],
    [{ name: 'X', amount: Number.POSITIVE_INFINITY }, /сумм/i],
    [{ name: 'X', amount: 1, currency: 'BTC' }, /валют/i],
    [{ name: 'X', amount: 1, period: 'week' }, /период/i],
    [{ name: 'X', amount: 1, nextRenewal: '2026-02-30' }, /дат/i],
    [{ name: 'X', amount: 1, manualRenewal: 'yes' }, /продлен/i]
  ])('отклоняет повреждённую подписку %#', (input, message) => {
    expect(() => parseSubscriptionInput(input)).toThrow(message)
  })

  it.each([
    ['ETH', '0x0000000000000000000000000000000000000000'],
    ['BTC', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
    ['BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'],
    ['TON', 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
  ])('принимает адрес %s реального формата', (chain, address) => {
    expect(parseWalletInput({ chain, address, label: ' Main ' })).toEqual({ chain, address, label: 'Main' })
  })

  it.each([
    [{ chain: 'DOGE', address: 'x' }, /сет/i],
    [{ chain: 'ETH', address: '0x1234' }, /адрес/i],
    [{ chain: 'BTC', address: 'not-a-wallet' }, /адрес/i],
    [{ chain: 'TON', address: '' }, /адрес/i]
  ])('отклоняет кошелёк с недоказанным форматом %#', (input, message) => {
    expect(() => parseWalletInput(input)).toThrow(message)
  })

  it('день-якорь списания проходит границу и проверяется', () => {
    // Поле возвращалось не всеми путями, и ветка «взять из входа» в хранилище была мертва:
    // якорь нельзя было ни задать, ни исправить, а однажды зажатое коротким месяцем 28-е
    // закреплялось навсегда.
    const base = { name: 'Подписка', amount: 10, currency: 'USD', period: 'mo' }
    expect(parseSubscriptionInput({ ...base, renewalDay: 31 }).renewalDay).toBe(31)
    expect(parseSubscriptionInput({ ...base, renewalDay: null }).renewalDay).toBeNull()
    // Не указан — не трогаем: хранилище само решит, оставить прежний или вывести из даты.
    expect(parseSubscriptionInput(base).renewalDay).toBeUndefined()

    expect(() => parseSubscriptionInput({ ...base, renewalDay: 0 })).toThrow(/от 1 до 31/)
    expect(() => parseSubscriptionInput({ ...base, renewalDay: 32 })).toThrow(/от 1 до 31/)
    expect(() => parseSubscriptionInput({ ...base, renewalDay: 3.5 })).toThrow(/от 1 до 31/)
    expect(() => parseSubscriptionInput({ ...base, renewalDay: '15' })).toThrow(/от 1 до 31/)
  })
})