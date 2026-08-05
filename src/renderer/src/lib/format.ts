import { FX_IS_APPROXIMATE } from '../../../shared/fx'

const SYMBOL: Record<string, string> = {
  USD: '$', EUR: '€', RUB: '₽', GBP: '£', CNY: '¥', JPY: '¥', CHF: 'Fr', CAD: 'C$',
  AUD: 'A$', INR: '₹', BRL: 'R$', KRW: '₩', TRY: '₺', PLN: 'zł', UAH: '₴', KZT: '₸',
  AED: 'د.إ', SEK: 'kr', NOK: 'kr', SGD: 'S$'
}
// Валюты с символом ПОСЛЕ суммы (5 000 ₽).
const TRAILING = new Set(['RUB', 'PLN', 'UAH', 'KZT', 'SEK', 'NOK', 'CHF'])

/**
 * Деньги: символ спереди ($1 234) или сзади (5 000 ₽).
 *
 * Знаков после запятой либо два, либо ноль — и решает это ВЕЛИЧИНА, а не то, целое ли число.
 * Прежнее правило («целое — ноль знаков, иначе два») давало на одном экране «$481.52» рядом с
 * «$5,778.2»: у второго один знак, потому что до сотых там ноль, и он молча отбрасывался.
 * Колонки денег переставали выравниваться по разряду, ради чего в них и стоит `tabular-nums`.
 *
 * От тысячи копейки не нужны — они добавляют шум и ломают ширину колонки, а ниже тысячи, наоборот,
 * важны: подписка за 4,50 € и за 4 € — разные подписки.
 *
 * Разделитель разрядов — узкий неразрывный пробел, как принято в русской типографике; запятая
 * между тысячами («125,000 ₽») в рублях читается как дробная часть.
 */
// Форматтеров ровно два, и строятся они один раз: `Intl.NumberFormat` с явными опциями движок
// не кэширует, а `money` зовётся десятками раз за рендер (таблица моделей, списки, карточки).
const WHOLE = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const CENTS = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function money(amount: number, currency = 'USD'): string {
  const sym = SYMBOL[currency] ?? ''
  const n = (Math.abs(amount) >= 1000 ? WHOLE : CENTS).format(amount)
  return TRAILING.has(currency) ? `${n} ${sym}` : `${sym}${n}`
}

/**
 * Сумма, сведённая к доллару по вшитому курсу.
 *
 * Правило одно на все экраны денег: если хоть одна слагаемая была не в долларах, итог получен
 * умножением на справочный курс — он не обновляется, и цифра приблизительная. Без «≈» она
 * читается как посчитанные деньги.
 *
 * Живёт здесь, а не на экранах, потому что уже дважды разъехалось: сначала пометку поставили
 * только на «Подписках», потом на «Финансах» — и оба раза условием было «валют больше одной»,
 * то есть на самом частом наборе (всё в рублях) пометка молчала, хотя пересчёт был.
 */
export function approxMoney(amountUsd: number, currencies: Iterable<string>): string {
  const converted = FX_IS_APPROXIMATE && [...currencies].some((c) => c !== 'USD')
  return converted ? `≈ ${money(amountUsd)}` : money(amountUsd)
}

/** Была ли конвертация — для подписи «сведено по приблизительному курсу» рядом с суммой. */
export const isApprox = (currencies: Iterable<string>): boolean =>
  FX_IS_APPROXIMATE && [...currencies].some((c) => c !== 'USD')

/**
 * Токены короткой строкой: «4.9 млн», «20 тыс.».
 *
 * Живёт здесь, а не рядом с экраном: копий было две, слово в слово вместе с комментарием, и
 * сегодняшняя правка (латинские M/k → русские сокращения) потребовала одинаково изменить оба
 * файла. Следующая разъехалась бы молча.
 */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`
  if (n >= 1000) return `${Math.round(n / 1000)} тыс.`
  return String(n)
}

export function pct(n: number): string {
  return `${Math.round(n)}%`
}


/**
 * Русское склонение существительного при числе: 1 устройство, 2 устройства, 5 устройств.
 *
 * Нужно везде, где число подставляется в текст: «1 устройств» в шапке главного экрана читается
 * как недоделанность, даже если всё остальное безупречно.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return many
  if (last > 1 && last < 5) return few
  if (last === 1) return one
  return many
}
