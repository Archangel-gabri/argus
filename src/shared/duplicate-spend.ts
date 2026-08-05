import type { Subscription } from '../main/types'

/** Устройство глазами поиска дублей: нам нужны только имя, хостер и цена. */
export interface SpendingDevice {
  id: string
  name: string
  provider: string
  cost: { amount: number; currency: string; usd: number }
}

export interface SuspectedDuplicate {
  deviceId: string
  deviceName: string
  subscriptionId: string
  subscriptionName: string
  /** Почему считаем это одной тратой — показывается человеку дословно. */
  reason: string
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length >= 3)

/**
 * Найти траты, которые, судя по всему, посчитаны дважды.
 *
 * Зачем это вообще нужно. Сервер живёт в приложении двумя записями по замыслу: железка в парке
 * (у неё есть цена) и регулярный платёж в подписках. Связать их вручную никто не догадается —
 * человек просто видит, что «в месяц» больше, чем он платит на самом деле, и не понимает почему.
 * Поэтому приложение ищет пары само и предлагает связать; решение остаётся за владельцем.
 *
 * Совпадением считаем РАВНУЮ сумму в одной валюте плюс общее слово в названиях или совпадение
 * хостера. Только суммы мало: две ноды по 10 € — это две разные траты, и склеивать их нельзя.
 * Только названия тоже мало: «HubVPN · Germany» и «VPS Германия — мастер-панель HubVPN» пишутся
 * по-разному, зато совпадают ценой.
 */
export function findDuplicateSpend(
  devices: SpendingDevice[],
  subs: Subscription[]
): SuspectedDuplicate[] {
  const linked = new Set(subs.map((s) => s.deviceId).filter(Boolean))
  const out: SuspectedDuplicate[] = []
  const takenSubs = new Set<string>()

  for (const device of devices) {
    if (device.cost.amount <= 0 || linked.has(device.id)) continue
    const deviceWords = new Set([...words(device.name), ...words(device.provider)])

    // Имя железки как набор слов: нужно, чтобы поймать случай «имя устройства целиком внутри
    // названия платежа» — там валюта и сумма могут не совпадать вовсе.
    const nameWords = words(device.name)

    for (const sub of subs) {
      if (sub.deviceId || takenSubs.has(sub.id)) continue
      const subWords = new Set([...words(sub.name), ...words(sub.provider)])
      const shared = [...deviceWords].filter((w) => subWords.has(w))

      // Месячная цена сравнивается с месячной: годовая подписка за тот же сервер — это те же
      // деньги, просто оплаченные разом.
      const subMonthly = sub.period === 'yr' ? sub.amount / 12 : sub.amount
      const sameMoney = sub.currency === device.cost.currency && Math.abs(subMonthly - device.cost.amount) < 0.01

      // Имя устройства целиком лежит внутри названия платежа («FX-Analytics» → «VPS Нью-Йорк —
      // FX-Analytics»). Это сильнее совпадения сумм: суммы у разных нод сплошь и рядом равны,
      // а полное вхождение имени случайным не бывает. Поэтому здесь валюту не требуем — цену
      // владелец мог вести в рублях у одной записи и в евро у другой.
      const nameContained = nameWords.length > 0 && nameWords.every((w) => subWords.has(w))

      const reason = nameContained
        ? `название платежа содержит «${device.name}»`
        : sameMoney && shared.length
          ? `одинаковая сумма и общее слово «${shared[0]}»`
          : null
      if (!reason) continue

      takenSubs.add(sub.id)
      out.push({
        deviceId: device.id,
        deviceName: device.name,
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        reason
      })
      break
    }
  }
  return out
}
