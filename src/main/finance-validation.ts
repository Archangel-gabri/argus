import { CURRENCY_CODES, type Currency, type SubscriptionInput, type WalletInput } from './types'
import { isCalendarDate } from '../shared/billing'

const CHAINS = ['ETH', 'BTC', 'TON'] as const
const CATEGORIES = ['AI', 'Media', 'Dev', 'Hosting', 'Other'] as const

/** Только для однократной миграции старых notes; новая логика на текст не гадает. */
export const legacyManualRenewal = (notes: string | null | undefined): boolean => /ручн/i.test(notes ?? '')

/** Безопасное описание чужого значения для сообщения об ошибке: объект не должен
 *  превратиться в бесполезное «[object Object]» именно там, где нужна ясность. */
export function describeValue(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 40)
  if (v === null) return 'null'
  if (typeof v === 'object') return Array.isArray(v) ? 'список' : 'объект'
  return String(v).slice(0, 40)
}

export function objectOf(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}: ожидался объект`)
  return input as Record<string, unknown>
}

export function text(value: unknown, label: string, max: number, required = false): string {
  if (value == null && !required) return ''
  if (typeof value !== 'string') throw new Error(`${label}: ожидалась строка`)
  const result = value.trim()
  if (required && !result) throw new Error(`${label}: значение не указано`)
  if (result.length > max) throw new Error(`${label}: слишком длинное значение`)
  return result
}

export function parseSubscriptionInput(input: unknown): SubscriptionInput {
  const value = objectOf(input, 'Подписка')
  const name = text(value.name, 'Название', 160, true)
  const provider = text(value.provider, 'Провайдер', 160)
  const notes = text(value.notes, 'Заметки', 2_000)
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0)
    throw new Error('Сумма должна быть конечным неотрицательным числом')

  const currency = value.currency ?? 'USD'
  if (typeof currency !== 'string' || !(CURRENCY_CODES as readonly string[]).includes(currency))
    throw new Error('Валюта не поддерживается')
  const period = value.period ?? 'mo'
  if (period !== 'mo' && period !== 'yr') throw new Error('Период должен быть mo или yr')
  const category = value.category ?? 'Other'
  if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category))
    throw new Error('Категория подписки не поддерживается')

  let nextRenewal: string | null = null
  if (value.nextRenewal != null && value.nextRenewal !== '') {
    if (typeof value.nextRenewal !== 'string' || !isCalendarDate(value.nextRenewal))
      throw new Error('Дата продления должна быть в формате YYYY-MM-DD')
    nextRenewal = value.nextRenewal.slice(0, 10)
  }
  if (value.manualRenewal !== undefined && typeof value.manualRenewal !== 'boolean')
    throw new Error('Способ продления должен быть указан явно')

  return {
    name,
    provider,
    category,
    amount: value.amount,
    currency: currency as SubscriptionInput['currency'],
    period,
    nextRenewal,
    notes: notes || null,
    manualRenewal: value.manualRenewal ?? false
  }
}

function validAddress(chain: string, address: string): boolean {
  if (chain === 'ETH') return /^0x[0-9a-fA-F]{40}$/.test(address)
  if (chain === 'BTC')
    return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) || /^bc1[ac-hj-np-z02-9]{11,71}$/i.test(address)
  if (chain === 'TON') return /^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address) || /^-?\d+:[0-9a-fA-F]{64}$/.test(address)
  return false
}

export function parseWalletInput(input: unknown): WalletInput {
  const value = objectOf(input, 'Кошелёк')
  const chain = text(value.chain, 'Сеть', 12, true).toUpperCase()
  if (!(CHAINS as readonly string[]).includes(chain)) throw new Error(`Сеть ${chain} не поддерживается`)
  const address = text(value.address, 'Адрес кошелька', 160, true)
  if (!validAddress(chain, address)) throw new Error(`Адрес ${chain} не похож на допустимый`)
  const label = text(value.label, 'Метка', 120)
  return { chain, address, ...(label ? { label } : {}) }
}

/**
 * Стоимость устройства.
 *
 * Подписки и кошельки проверялись дважды — и на границе IPC, и в хранилище, — а устройства не
 * проверялись ни разу: `devices:create` передавал объект от renderer насквозь. Отрицательная
 * сумма проходила и уменьшала общий месячный расход, а строка при этом пряталась фильтром
 * `usd > 0`; неизвестная валюта молча получала курс 1, то есть «100 BTC» считались как «$100».
 *
 * Пересчёт в доллары здесь НЕ делается и значение `usd` от renderer не принимается: курс знает
 * хранилище, и доверять чужой арифметике в деньгах незачем.
 */
export function parseDeviceCost(input: unknown): { amount: number; currency: Currency } {
  if (input == null) return { amount: 0, currency: 'USD' }
  const value = objectOf(input, 'Стоимость')

  const amount = value.amount ?? 0
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new Error('Стоимость должна быть числом')
  if (amount < 0) throw new Error('Стоимость не может быть отрицательной')

  const currency = value.currency ?? 'USD'
  if (typeof currency !== 'string' || !(CURRENCY_CODES as readonly string[]).includes(currency))
    throw new Error(`Валюта не поддерживается: ${describeValue(currency)}`)

  return { amount, currency: currency as Currency }
}
