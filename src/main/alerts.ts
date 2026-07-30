// Сторож: правила, по которым Argus сам говорит, что что-то не так.
//
// Зачем. Приложение показывает состояние только когда в него смотрят, а узнать о падении ноды
// или о кончающемся диске нужно раньше, чем откроешь. Данные для этого уже собираются —
// не хватало слоя, который их читает и делает вывод.
//
// Правила живут отдельным модулем без единого обращения к сети, к базе и к Electron. Причина
// та же, что и у подстройки качества: правило ошибается ТИХО. Ложная тревога раздражает и
// приучает не смотреть на уведомления, а пропущенная — обесценивает всю затею. И то, и другое
// невозможно поймать вручную, зато легко закрыть проверками.

/** Что сторож умеет замечать. */
export type AlertKind =
  | 'device-offline' // машина не отвечает
  | 'disk-full' // на диске мало места
  | 'renewal-soon' // подписку/сервер скоро продлевать, а платёж ручной

export interface Alert {
  /** Устойчивый ключ: по нему тревога узнаётся между проверками и не повторяется. */
  key: string
  kind: AlertKind
  /** Короткий заголовок — он уходит в уведомление ОС. */
  title: string
  /** Одно предложение: что именно произошло и что с этим делать. */
  body: string
  /** Насколько срочно. Влияет на то, показывать ли уведомление немедленно. */
  severity: 'warning' | 'critical'
  deviceId?: string
}

/** Срез состояния, по которому принимаются решения. Только то, что уже собирается. */
export interface AlertInput {
  devices: Array<{
    id: string
    name: string
    status: string
    /** Занято на корневом диске, %. */
    disk?: number | null
    /** Когда последний раз удалось снять состояние (мс). */
    lastSeen?: number | null
  }>
  subscriptions: Array<{
    id: string
    name: string
    provider: string
    nextRenewal: string | null
    /** Продление ручное: о таком надо напоминать, автосписание само себя не забудет. */
    manual?: boolean
  }>
  now: number
}

// Пороги. Вынесены в константы не ради красоты, а чтобы их было видно и можно было обсуждать.
export const DISK_WARNING = 85 // % — «скоро кончится»
export const DISK_CRITICAL = 93 // % — «уже мешает»
export const RENEWAL_WARNING_DAYS = 5 // за сколько дней напоминать о ручном продлении

/**
 * Оценить состояние и вернуть тревоги.
 *
 * Функция чистая: одни и те же данные всегда дают один и тот же ответ. Ничего не хранит —
 * подавлением повторов занимается тот, кто её зовёт (см. AlertMemory).
 */
export function evaluateAlerts(input: AlertInput): Alert[] {
  const out: Alert[] = []

  for (const d of input.devices) {
    // «Не знаю» и «выключено» — разные состояния, и тревожить по первому нельзя: канал до
    // удалённых машин флапает, и одна неудачная попытка опроса ничего не доказывает.
    // Статус offline проставляется только со второго промаха подряд — на него и опираемся.
    if (d.status === 'offline') {
      out.push({
        key: `offline:${d.id}`,
        kind: 'device-offline',
        title: `${d.name} не отвечает`,
        body: 'Машина не отвечает на два опроса подряд.',
        severity: 'critical',
        deviceId: d.id
      })
    }

    // Место на диске. У выключенной машины показания устаревшие — тревожить по ним значит
    // сообщать о вчерашней погоде.
    if (d.status !== 'offline' && typeof d.disk === 'number') {
      if (d.disk >= DISK_CRITICAL) {
        out.push({
          key: `disk:${d.id}`,
          kind: 'disk-full',
          title: `${d.name}: диск занят на ${d.disk}%`,
          body: 'Свободного места почти нет — служба может перестать писать.',
          severity: 'critical',
          deviceId: d.id
        })
      } else if (d.disk >= DISK_WARNING) {
        out.push({
          key: `disk:${d.id}`,
          kind: 'disk-full',
          title: `${d.name}: диск занят на ${d.disk}%`,
          body: 'Место кончается — стоит освободить заранее.',
          severity: 'warning',
          deviceId: d.id
        })
      }
    }
  }

  for (const s of input.subscriptions) {
    // Напоминаем только о РУЧНЫХ продлениях: автосписание само себя не забудет, а вот
    // «продлить OVH руками до 13-го» забывается ровно один раз и стоит сервера.
    if (!s.manual || !s.nextRenewal) continue
    const days = daysUntil(s.nextRenewal, input.now)
    if (days === null || days > RENEWAL_WARNING_DAYS) continue
    out.push({
      key: `renewal:${s.id}`,
      kind: 'renewal-soon',
      title:
        days < 0
          ? `${s.name}: срок продления прошёл`
          : days === 0
            ? `${s.name}: продлить сегодня`
            : `${s.name}: продлить через ${days} дн.`,
      body: `${s.provider}: продление ручное, само не спишется.`,
      severity: days <= 1 ? 'critical' : 'warning'
    })
  }

  return out
}

/** Сколько полных дней до даты. null — дату не разобрать. */
export function daysUntil(iso: string, now: number): number | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  // Считаем по календарным суткам, а не по «24 часа от сейчас»: «продлить через 1 день»
  // должно означать завтра, независимо от времени суток.
  const startOfDay = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return Math.round((startOfDay(t) - startOfDay(now)) / 86_400_000)
}

/**
 * Память о том, о чём уже сообщили.
 *
 * Без неё сторож повторял бы одно и то же при каждой проверке — раз в полминуты, — и на
 * уведомления перестали бы смотреть уже к вечеру. Повтор допускается, только если тревога
 * успела пропасть и появиться снова, либо если она усилилась (была «скоро», стала «уже»).
 */
export class AlertMemory {
  private seen = new Map<string, Alert['severity']>()

  /**
   * Принять новый срез тревог и сказать, что в нём НОВОГО и что ПРОШЛО.
   *
   * Одним методом, а не двумя, намеренно: два метода означали бы, что порядок их вызова
   * важен (второй читал бы уже обновлённую память и всегда возвращал пустоту). Такую ошибку
   * невозможно увидеть в месте вызова — проще не дать её совершить.
   */
  update(alerts: Alert[]): { fresh: Alert[]; resolved: string[] } {
    const fresh = alerts.filter((a) => {
      const before = this.seen.get(a.key)
      // Новая — показываем. Усилилась — показываем ещё раз, это другая новость.
      return before === undefined || (before === 'warning' && a.severity === 'critical')
    })
    const now = new Set(alerts.map((a) => a.key))
    const resolved = [...this.seen.keys()].filter((k) => !now.has(k))

    this.seen = new Map(alerts.map((a) => [a.key, a.severity]))
    return { fresh, resolved }
  }
}
