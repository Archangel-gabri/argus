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

import { daysUntilCalendar } from '../shared/billing'

/** Что сторож умеет замечать. */
export type AlertKind =
  | 'device-offline' // машина не отвечает
  | 'disk-full' // на диске мало места
  | 'renewal-soon' // подписку/сервер скоро продлевать, а платёж ручной
  | 'ai-key-expiring' // ключ или токен доступа скоро истекает
  | 'ai-key-dead' // ключ перестал приниматься провайдером
  | 'ai-credit-low' // на балансе доступа почти ничего не осталось
  | 'ai-access-idle' // бесплатный доступ отмечен «возьму», но так и не взят

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
    manualRenewal?: boolean
  }>
  /** AI-доступы. Пусто — раздел ещё не заведён, и тревожить не о чем. */
  aiAccess?: Array<{
    id: string
    label: string
    status: string
    hasKey: boolean
    /** ISO-дата истечения ключа/токена. */
    keyExpiresAt: string | null
    createdAt: number
    /** Последний СОХРАНЁННЫЙ вердикт проверки — сторож сам в сеть не ходит. */
    checkStatus?: string | null
    /** Остаток на счету, если провайдер его отдаёт (сейчас только OpenRouter). */
    remaining?: number | null
  }>
  now: number
}

// Пороги. Вынесены в константы не ради красоты, а чтобы их было видно и можно было обсуждать.
export const DISK_WARNING = 85 // % — «скоро кончится»
export const DISK_CRITICAL = 93 // % — «уже мешает»
export const RENEWAL_WARNING_DAYS = 5 // за сколько дней напоминать о ручном продлении
export const KEY_EXPIRY_WARNING_DAYS = 14 // за сколько дней предупреждать об истечении ключа
export const KEY_EXPIRY_CRITICAL_DAYS = 3 // когда это уже «бросай и перевыпускай»
export const CREDIT_WARNING_USD = 5 // остаток, ниже которого пора пополняться
export const CREDIT_CRITICAL_USD = 1 // остаток, при котором работа встанет со дня на день
export const IDLE_ACCESS_DAYS = 30 // сколько «возьму потом» считается решением, а не забывчивостью

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
    if ((d.status === 'online' || d.status === 'degraded') && typeof d.disk === 'number') {
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
    if (!s.nextRenewal) continue
    const days = daysUntilCalendar(s.nextRenewal, input.now)
    if (days === null || days > RENEWAL_WARNING_DAYS) continue

    // О ПРЕДСТОЯЩЕМ продлении напоминаем только там, где платят руками: автосписание само себя
    // не забудет, а «продлить OVH до 13-го» забывается ровно один раз и стоит сервера.
    //
    // А вот ПРОШЕДШАЯ дата — повод сказать в любом случае. Автосписание не забывает, пока
    // работает карта; когда она отбивается, подписка молча уходит в просрочку, и хостер удаляет
    // услугу вместе с данными. Дата в прошлом означает, что платёж не прошёл: прошедший платёж
    // подвинул бы её вперёд.
    const overdue = days < 0
    if (!overdue && !s.manualRenewal) continue

    // Приложение не видит банковских списаний и знать, прошёл ли автоплатёж, не может.
    // Прошедшая дата у автосписания значит ровно одно: её никто не подвинул — а это случается
    // и после успешного платежа. Утверждать «карта отбилась» здесь было бы выдумкой, и такая
    // тревога горела бы у исправной подписки каждый цикл, пока на неё не перестанут смотреть.
    const guessed = overdue && !s.manualRenewal
    out.push({
      key: `renewal:${s.id}`,
      kind: 'renewal-soon',
      title: overdue
        ? `${s.name}: срок продления прошёл`
        : days === 0
          ? `${s.name}: продлить сегодня`
          : `${s.name}: продлить через ${days} дн.`,
      body: guessed
        ? `${s.provider}: сверьте, списалось ли, и отметьте «Продлено».`
        : `${s.provider}: продление ручное, само не спишется.`,
      // Догадка не может быть срочной: срочное — только то, что владелец должен сделать сам.
      severity: guessed ? 'warning' : days <= 1 ? 'critical' : 'warning'
    })
  }

  for (const a of input.aiAccess ?? []) {
    // Ключ с концом срока. Про истёкший говорим тоже: он выглядит рабочим в реестре, а
    // ломается ровно в тот момент, когда понадобился.
    const days = a.keyExpiresAt ? daysUntilCalendar(a.keyExpiresAt, input.now) : null
    if (days !== null && days <= KEY_EXPIRY_WARNING_DAYS) {
      out.push({
        key: `ai-expiry:${a.id}`,
        kind: 'ai-key-expiring',
        title:
          days < 0
            ? `${a.label}: ключ истёк`
            : days === 0
              ? `${a.label}: ключ истекает сегодня`
              : `${a.label}: ключу осталось ${days} дн.`,
        body: 'Выпусти новый ключ и замени его в Argus и в конфигурациях инструментов.',
        severity: days <= KEY_EXPIRY_CRITICAL_DAYS ? 'critical' : 'warning'
      })
    }

    // Мёртвый ключ. Только `invalid` — то есть провайдер ЯВНО его не принял. Сетевая ошибка и
    // «провайдер не поддерживает проверку» сюда не попадают: по ним ключ выбрасывать нельзя.
    if (a.hasKey && a.checkStatus === 'invalid') {
      out.push({
        key: `ai-dead:${a.id}`,
        kind: 'ai-key-dead',
        title: `${a.label}: ключ не принимается`,
        body: 'Провайдер отверг ключ — он отозван, истёк или заменён.',
        severity: 'critical'
      })
    }

    // Остаток на счету. Ноль — это тоже число: «$0» значит «работа встала», а не «неизвестно».
    if (typeof a.remaining === 'number' && a.remaining <= CREDIT_WARNING_USD) {
      out.push({
        key: `ai-credit:${a.id}`,
        kind: 'ai-credit-low',
        title: `${a.label}: остаток $${a.remaining.toFixed(2)}`,
        body: 'Баланс почти исчерпан — пополни, пока запросы ещё проходят.',
        severity: a.remaining <= CREDIT_CRITICAL_USD ? 'critical' : 'warning'
      })
    }

    // Отмеченный «возьму потом» бесплатный доступ, про который забыли. Напоминаем один раз:
    // подавление повторов не даст этому превратиться в ежеминутный укор.
    if (a.status === 'planned' && a.createdAt > 0) {
      const ageDays = Math.floor((input.now - a.createdAt) / (24 * 60 * 60 * 1000))
      if (ageDays >= IDLE_ACCESS_DAYS)
        out.push({
          key: `ai-idle:${a.id}`,
          kind: 'ai-access-idle',
          title: `${a.label}: так и не оформлен`,
          body: `Доступ помечен как «возьму» ${ageDays} дн. назад. Оформи или убери из реестра.`,
          severity: 'warning'
        })
    }
  }

  return out
}

/** Сколько полных дней до даты. null — дату не разобрать. */
export const daysUntil = daysUntilCalendar

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
