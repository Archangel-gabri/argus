// Правила сторожа ошибаются ТИХО. Ложная тревога приучает не смотреть на уведомления,
// пропущенная — обесценивает всю затею; ни то, ни другое не заметишь вручную.
import { describe, it, expect } from 'vitest'
import {
  evaluateAlerts,
  daysUntil,
  AlertMemory,
  DISK_WARNING,
  DISK_CRITICAL,
  RENEWAL_WARNING_DAYS,
  type Alert
} from './alerts'

const NOW = Date.parse('2026-07-30T12:00:00')
const dev = (over: Partial<AlertInputDevice> = {}): AlertInputDevice => ({
  id: 'd1',
  name: 'FX сервер',
  status: 'online',
  disk: 10,
  ...over
})
type AlertInputDevice = Parameters<typeof evaluateAlerts>[0]['devices'][number]

const run = (devices: AlertInputDevice[], subs: Parameters<typeof evaluateAlerts>[0]['subscriptions'] = []): Alert[] =>
  evaluateAlerts({ devices, subscriptions: subs, now: NOW })

describe('машина не отвечает', () => {
  it('выключенная машина — тревога', () => {
    const a = run([dev({ status: 'offline' })])
    expect(a.map((x) => x.kind)).toContain('device-offline')
    expect(a[0].severity).toBe('critical')
  })

  it('«не знаю» — НЕ тревога', () => {
    // Канал до удалённых машин флапает, и одна неудачная попытка опроса ничего не доказывает.
    // Статус offline проставляется только со второго промаха подряд — на него и опираемся.
    expect(run([dev({ status: 'unknown' })])).toHaveLength(0)
  })

  it('машина в обслуживании не тревожит', () => {
    expect(run([dev({ status: 'maintenance' })])).toHaveLength(0)
  })
})

describe('место на диске', () => {
  it('ниже порога — тихо', () => {
    expect(run([dev({ disk: DISK_WARNING - 1 })])).toHaveLength(0)
  })

  it('на пороге — предупреждение', () => {
    const a = run([dev({ disk: DISK_WARNING })])
    expect(a).toHaveLength(1)
    expect(a[0].severity).toBe('warning')
  })

  it('выше критического — тревога', () => {
    expect(run([dev({ disk: DISK_CRITICAL })])[0].severity).toBe('critical')
  })

  it('у выключенной машины про диск молчим', () => {
    // Показания устаревшие: сообщать по ним — то же самое, что рассказывать о вчерашней погоде.
    const a = run([dev({ status: 'offline', disk: 99 })])
    expect(a.map((x) => x.kind)).toEqual(['device-offline'])
  })

  it('нет данных о диске — нет тревоги', () => {
    expect(run([dev({ disk: null })])).toHaveLength(0)
    expect(run([dev({ disk: undefined })])).toHaveLength(0)
  })
})

describe('ручное продление', () => {
  const sub = (over = {}): Parameters<typeof evaluateAlerts>[0]['subscriptions'][number] => ({
    id: 's1',
    name: 'OVH',
    provider: 'OVH',
    nextRenewal: '2026-08-02',
    manual: true,
    ...over
  })

  it('за несколько дней — напоминаем', () => {
    const a = run([], [sub()])
    expect(a[0].kind).toBe('renewal-soon')
    expect(a[0].title).toContain('через 3 дн')
  })

  it('сегодня — говорим «сегодня», и это срочно', () => {
    const a = run([], [sub({ nextRenewal: '2026-07-30' })])
    expect(a[0].title).toContain('сегодня')
    expect(a[0].severity).toBe('critical')
  })

  it('срок прошёл — говорим прямо', () => {
    expect(run([], [sub({ nextRenewal: '2026-07-25' })])[0].title).toContain('срок продления прошёл')
  })

  it('далеко — молчим', () => {
    expect(run([], [sub({ nextRenewal: '2026-09-01' })])).toHaveLength(0)
  })

  it('автосписание не напоминаем — оно само себя не забудет', () => {
    expect(run([], [sub({ manual: false })])).toHaveLength(0)
  })

  it('нет даты — нет напоминания', () => {
    expect(run([], [sub({ nextRenewal: null })])).toHaveLength(0)
  })

  it('дата-мусор не роняет разбор', () => {
    expect(run([], [sub({ nextRenewal: 'когда-нибудь' })])).toHaveLength(0)
  })
})

describe('daysUntil', () => {
  it('считает календарные сутки, а не 24 часа', () => {
    // «Через 1 день» должно означать завтра независимо от времени суток: иначе поздним вечером
    // напоминание о завтрашнем платеже превращается в «через 0 дней».
    expect(daysUntil('2026-07-31T01:00:00', Date.parse('2026-07-30T23:00:00'))).toBe(1)
    expect(daysUntil('2026-07-30T23:00:00', Date.parse('2026-07-30T01:00:00'))).toBe(0)
  })

  it('прошедшая дата — отрицательное число', () => {
    expect(daysUntil('2026-07-28', NOW)).toBe(-2)
  })

  it('мусор — null, а не ноль', () => {
    expect(daysUntil('вчера', NOW)).toBeNull()
  })
})

describe('память сторожа', () => {
  const offline: Alert = {
    key: 'offline:d1',
    kind: 'device-offline',
    title: 'нода упала',
    body: '',
    severity: 'critical'
  }
  const diskWarn: Alert = { key: 'disk:d1', kind: 'disk-full', title: 'диск', body: '', severity: 'warning' }
  const diskCrit: Alert = { ...diskWarn, severity: 'critical' }

  it('первая тревога — новая, повтор — уже нет', () => {
    const m = new AlertMemory()
    expect(m.update([offline]).fresh).toHaveLength(1)
    // Проверка идёт раз в полминуты: повторяя одно и то же, сторож приучил бы не смотреть
    // на уведомления уже к вечеру.
    expect(m.update([offline]).fresh).toHaveLength(0)
  })

  it('усилившаяся тревога сообщается снова — это другая новость', () => {
    const m = new AlertMemory()
    m.update([diskWarn])
    expect(m.update([diskCrit]).fresh).toHaveLength(1)
    // А обратно (стало легче) — не повод будить.
    expect(m.update([diskWarn]).fresh).toHaveLength(0)
  })

  it('пропавшая тревога отмечается как прошедшая', () => {
    const m = new AlertMemory()
    m.update([offline, diskWarn])
    const r = m.update([diskWarn])
    expect(r.resolved).toEqual(['offline:d1'])
    expect(r.fresh).toHaveLength(0)
  })

  it('пропавшая и вернувшаяся тревога сообщается заново', () => {
    const m = new AlertMemory()
    m.update([offline])
    m.update([])
    expect(m.update([offline]).fresh).toHaveLength(1)
  })

  it('новое и прошедшее возвращаются за один вызов', () => {
    // Двумя методами это было бы ловушкой порядка: второй читал бы уже обновлённую память.
    const m = new AlertMemory()
    m.update([offline])
    const r = m.update([diskWarn])
    expect(r.fresh.map((a) => a.key)).toEqual(['disk:d1'])
    expect(r.resolved).toEqual(['offline:d1'])
  })
})

describe('пороги согласованы между собой', () => {
  it('критический порог диска выше предупреждающего', () => {
    expect(DISK_CRITICAL).toBeGreaterThan(DISK_WARNING)
  })
  it('о продлении напоминаем заранее, а не в день платежа', () => {
    expect(RENEWAL_WARNING_DAYS).toBeGreaterThan(0)
  })
})
