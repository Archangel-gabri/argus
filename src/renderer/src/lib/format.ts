const SYMBOL: Record<string, string> = {
  USD: '$', EUR: '€', RUB: '₽', GBP: '£', CNY: '¥', JPY: '¥', CHF: 'Fr', CAD: 'C$',
  AUD: 'A$', INR: '₹', BRL: 'R$', KRW: '₩', TRY: '₺', PLN: 'zł', UAH: '₴', KZT: '₸',
  AED: 'د.إ', SEK: 'kr', NOK: 'kr', SGD: 'S$'
}
// Валюты с символом ПОСЛЕ суммы (5 000 ₽).
const TRAILING = new Set(['RUB', 'PLN', 'UAH', 'KZT', 'SEK', 'NOK', 'CHF'])

/** Format money with a leading symbol ($1,234) or trailing (5 000 ₽). */
export function money(amount: number, currency = 'USD'): string {
  const sym = SYMBOL[currency] ?? ''
  const n = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
  }).format(amount)
  return TRAILING.has(currency) ? `${n} ${sym}` : `${sym}${n}`
}

export function pct(n: number): string {
  return `${Math.round(n)}%`
}

export function gb(n: number): string {
  return `${n % 1 === 0 ? n : n.toFixed(1)} GB`
}
