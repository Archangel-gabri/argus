const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', RUB: '₽' }

/** Format money with a leading symbol ($1,234) or trailing for RUB (5 000 ₽). */
export function money(amount: number, currency = 'USD'): string {
  const sym = SYMBOL[currency] ?? ''
  const n = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
  }).format(amount)
  return currency === 'RUB' ? `${n} ${sym}` : `${sym}${n}`
}

export function pct(n: number): string {
  return `${Math.round(n)}%`
}

export function gb(n: number): string {
  return `${n % 1 === 0 ? n : n.toFixed(1)} GB`
}
