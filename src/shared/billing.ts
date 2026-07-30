export type BillingPeriod = 'mo' | 'yr'

interface CalendarDate {
  year: number
  month: number
  day: number
}

function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return { year, month, day }
}

export function isCalendarDate(value: string): boolean {
  return parseCalendarDate(value) !== null
}

const calendarKey = (date: CalendarDate): number => Date.UTC(date.year, date.month - 1, date.day)

/** Разница между датами по календарю машины, а не по 24-часовым интервалам. */
export function daysUntilCalendar(iso: string, now = Date.now()): number | null {
  const target = parseCalendarDate(iso)
  if (!target) return null
  const current = new Date(now)
  const today = { year: current.getFullYear(), month: current.getMonth() + 1, day: current.getDate() }
  return Math.round((calendarKey(target) - calendarKey(today)) / 86_400_000)
}

export function renewalLabel(days: number): string {
  if (days < 0) return `просрочено ${Math.abs(days)} дн.`
  if (days === 0) return 'сегодня'
  return `через ${days} дн.`
}

const pad = (value: number): string => String(value).padStart(2, '0')

function occurrence(anchor: CalendarDate, months: number): CalendarDate {
  const monthIndex = anchor.year * 12 + (anchor.month - 1) + months
  const year = Math.floor(monthIndex / 12)
  const monthZero = ((monthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, monthZero + 1, 0)).getUTCDate()
  return { year, month: monthZero + 1, day: Math.min(anchor.day, lastDay) }
}

/** Сдвинуть оплаченное продление к первой следующей дате после сегодня. */
export function advanceRenewal(iso: string, period: BillingPeriod, now = Date.now()): string | null {
  const anchor = parseCalendarDate(iso)
  if (!anchor) return null
  const current = new Date(now)
  const today = { year: current.getFullYear(), month: current.getMonth() + 1, day: current.getDate() }
  const step = period === 'yr' ? 12 : 1
  const elapsedMonths = (today.year - anchor.year) * 12 + (today.month - anchor.month)
  let count = Math.max(1, Math.floor(elapsedMonths / step))
  let next = occurrence(anchor, count * step)
  while (calendarKey(next) <= calendarKey(today)) {
    count += 1
    next = occurrence(anchor, count * step)
  }
  return `${next.year}-${pad(next.month)}-${pad(next.day)}`
}
