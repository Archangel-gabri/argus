// Быстрая проверка «жив ли хост» — ОТДЕЛЬНО от метрик.
//
// Зачем: полный SSH-опрос стоит 1.6–4с на сервер (рукопожатие + аутентификация + скрипт), а для
// точки «онлайн/офлайн» хватает одного round-trip. Замер до этого: 70 секунд от входа в приложение
// до появления статусов.
//
// ВАЖНО, проверено на живом стенде: голого TCP-коннекта НЕДОСТАТОЧНО. Когда на машине поднят VPN
// в режиме fake-ip TUN, коннект успешно «устанавливается» к ЛЮБОМУ адресу — выключенный сервер
// показывался онлайн, причём у всех хостов был подозрительно одинаковый отклик 125мс.
// Поэтому ждём SSH-баннер («SSH-2.0-…»), который шлёт настоящий sshd сразу после коннекта:
// стоит те же один round-trip, но подделать его туннель не может.
import net from 'node:net'
import { getOsEndpoints, getDeviceConn, listDevices } from './vault'
import { consumeSshBanner, type Reachability } from '../shared/reachability'

export interface Reach {
  status: Reachability
  ms: number
}

/**
 * Бюджет одной проверки живости.
 *
 * Замерено на парке владельца 2026-08-06: баннер от нью-йоркской ноды идёт 2.60–2.74 с, от
 * немецкой 2.43–2.67 с (через VPN-туннель в режиме fake-ip TUN, иначе было бы вдвое быстрее).
 * При прежних 4 секундах запас был 1.3 с, и его съедал любой всплеск задержки: та же нода,
 * которая при бюджете 15 с отвечала 4 раза из 4, при 4 с отвечала 4 из 5. То есть каждый пятый
 * «сервер не отвечает» приложение придумывало само.
 *
 * 8 секунд — троекратный запас к самому медленному настоящему ответу. Цена — упавшая машина
 * признаётся упавшей позже; это дешевле, чем мигающий статус, которому перестают верить.
 */
const REACH_BUDGET_MS = 8000

/** Коннект + ожидание SSH-баннера. Резолв DNS входит в бюджет. */
export function tcpAlive(host: string, port: number, timeoutMs = REACH_BUDGET_MS): Promise<Reach> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    if (!host || host.includes('x.x')) return resolve({ status: 'unknown', ms: 0 })
    // Порт вне диапазона — «не знаю»: мы ничего не проверили. Ноль сюда тоже попадает.
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return resolve({ status: 'unknown', ms: 0 })
    const sock = new net.Socket()
    let done = false
    let banner = ''
    const finish = (status: Reachability): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ status, ms: Date.now() - t0 })
    }
    sock.setTimeout(timeoutMs)
    // Коннект сам по себе НИЧЕГО не доказывает — ждём баннер. `data` не обязан содержать
    // целые четыре байта: в живом TCP поймано `SS` + `H-2.0...`.
    sock.on('data', (buf: Buffer) => {
      const next = consumeSshBanner(banner, buf.toString('latin1'))
      banner = next.text
      if (next.verdict !== null) finish(next.verdict ? 'online' : 'offline')
    })
    sock.once('timeout', () => finish('offline'))
    sock.once('error', () => finish('offline'))
    sock.once('close', () => finish('offline'))
    // Порт приходит из записи устройства, а её заполняет человек. Node на порту вне 1..65535
    // бросает СИНХРОННО (`ERR_SOCKET_BAD_PORT`), и этот бросок улетал наружу через Promise.all
    // в `deviceReach`/`fleetReach` — то есть одна кривая запись выключала обновление статусов у
    // ВСЕГО парка, навсегда до перезапуска, оставляя на карточках протухшее «Онлайн» как факт.
    // «Не знаю» здесь честнее «offline»: мы ничего не проверили.
    try {
      // Порт берём как есть: `port || 22` молча подменял ноль двадцать вторым, и запись с
      // явно неверным портом объявлялась живой по ЧУЖОМУ порту. Значение по умолчанию ставит
      // хранилище при создании записи — здесь догадываться не о чем.
      sock.connect({ host, port })
    } catch {
      finish('unknown')
    }
  })
}

/** Достижимо ли устройство хоть по одному из своих ОС-эндпоинтов (multi-boot ПК — по любому). */
export async function deviceReach(deviceId: string, timeoutMs = REACH_BUDGET_MS): Promise<Reach> {
  const eps = getOsEndpoints(deviceId)
  const conns = eps.length ? eps.map((e) => e.conn) : [getDeviceConn(deviceId)].filter((c) => c !== null)
  if (!conns.length) return { status: 'unknown', ms: 0 }
  // Хост за бастионом напрямую недостижим по определению: прямая TCP-проба всегда промахнётся
  // и пометила бы устройство мёртвым. Такие проверяем только полным опросом, который умеет
  // ходить туннелем, — а здесь честно говорим «не знаю», не роняя статус.
  if (conns.some((c) => c.jump)) return { status: 'unknown', ms: 0 }
  const results = await Promise.all(
    // Отказ пробы одного эндпоинта не должен ронять вердикт по устройству целиком.
    conns.map((c) =>
      tcpAlive(c.host, c.port, timeoutMs).catch((): Reach => ({ status: 'unknown', ms: 0 }))
    )
  )
  const alive = results.filter((r) => r.status === 'online')
  return alive.length
    ? { status: 'online', ms: Math.min(...alive.map((r) => r.ms)) }
    : results.every((r) => r.status === 'unknown')
      ? { status: 'unknown', ms: 0 }
      : { status: 'offline', ms: Math.max(...results.map((r) => r.ms)) }
}

/** Разом по всему парку — параллельно. Именно это зовём сразу после входа в приложение. */
export async function fleetReach(timeoutMs = REACH_BUDGET_MS): Promise<Record<string, Reach>> {
  const devices = listDevices()
  const pairs = await Promise.all(
    // И то же на уровне парка: сломанная запись портит вердикт только о себе. Раньше её
    // исключение всплывало в обработчик IPC, где ловить было уже некому.
    devices.map(async (d) => {
      try {
        return [d.id, await deviceReach(d.id, timeoutMs)] as const
      } catch {
        return [d.id, { status: 'unknown', ms: 0 }] as const
      }
    })
  )
  return Object.fromEntries(pairs)
}
