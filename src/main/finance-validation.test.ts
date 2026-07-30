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
})
