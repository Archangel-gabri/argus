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

/**
 * Подпись срока продления.
 *
 * `manual` — списание надо оплатить руками. Только у такого прошедшая дата означает
 * «просрочено»: никто не заплатил, и это правда тревога.
 *
 * У автосписания прошедшая дата не доказывает НИЧЕГО про платёж. Деньги списывает провайдер, а
 * дата в Argus — заметка владельца, которую он двигает кнопкой «Продлено». Красное «просрочено
 * 1 дн.» на следующий день после успешного автоплатежа — ложная тревога, и именно из таких
 * складывался красный шум, на который жаловался владелец. Двигать дату самим тоже нельзя: у
 * подписки владельца первый платёж каждый месяц отбивается, и «продлено» было бы выдумкой.
 */
export function renewalLabel(days: number, manual = true): string {
  if (days < 0) return manual ? `просрочено ${Math.abs(days)} дн.` : 'дата устарела'
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

/**
 * Сдвинуть оплаченное продление к первой следующей дате после сегодня.
 *
 * `anchorDay` — день месяца, на который подписка списывается ИЗНАЧАЛЬНО. Он нужен, потому что
 * короткий месяц зажимает день: 31 января → 28 февраля. Пока результат сохранялся как новый
 * якорь, число 31 терялось навсегда, и дальше подписка навечно уезжала на 28-е — списание
 * приходило на три дня позже напоминания, каждый месяц. Передан день — считаем от него.
 */
export function advanceRenewal(
  iso: string,
  period: BillingPeriod,
  now = Date.now(),
  anchorDay?: number | null
): string | null {
  const parsed = parseCalendarDate(iso)
  if (!parsed) return null
  const anchor =
    anchorDay && anchorDay >= 1 && anchorDay <= 31 ? { ...parsed, day: anchorDay } : parsed
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

/**
 * День месяца, на который подписка списывается изначально.
 *
 * Считается один раз — от первой известной даты продления — и дальше живёт в записи. Вычислять
 * его каждый раз из `nextRenewal` нельзя: после первого же короткого месяца там будет 28-е.
 */
export function renewalAnchorDay(iso: string | null): number | null {
  return parseCalendarDate(iso ?? '')?.day ?? null
}
