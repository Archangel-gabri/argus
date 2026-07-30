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

/** Коннект + ожидание SSH-баннера. Резолв DNS входит в бюджет. */
export function tcpAlive(host: string, port: number, timeoutMs = 4000): Promise<Reach> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    if (!host || host.includes('x.x')) return resolve({ status: 'unknown', ms: 0 })
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
    sock.connect({ host, port: port || 22 })
  })
}

/** Достижимо ли устройство хоть по одному из своих ОС-эндпоинтов (multi-boot ПК — по любому). */
export async function deviceReach(deviceId: string, timeoutMs = 4000): Promise<Reach> {
  const eps = getOsEndpoints(deviceId)
  const conns = eps.length ? eps.map((e) => e.conn) : [getDeviceConn(deviceId)].filter((c) => c !== null)
  if (!conns.length) return { status: 'unknown', ms: 0 }
  // Хост за бастионом напрямую недостижим по определению: прямая TCP-проба всегда промахнётся
  // и пометила бы устройство мёртвым. Такие проверяем только полным опросом, который умеет
  // ходить туннелем, — а здесь честно говорим «не знаю», не роняя статус.
  if (conns.some((c) => c.jump)) return { status: 'unknown', ms: 0 }
  const results = await Promise.all(conns.map((c) => tcpAlive(c.host, c.port, timeoutMs)))
  const alive = results.filter((r) => r.status === 'online')
  return alive.length
    ? { status: 'online', ms: Math.min(...alive.map((r) => r.ms)) }
    : results.every((r) => r.status === 'unknown')
      ? { status: 'unknown', ms: 0 }
      : { status: 'offline', ms: Math.max(...results.map((r) => r.ms)) }
}

/** Разом по всему парку — параллельно. Именно это зовём сразу после входа в приложение. */
export async function fleetReach(timeoutMs = 4000): Promise<Record<string, Reach>> {
  const devices = listDevices()
  const pairs = await Promise.all(
    devices.map(async (d) => [d.id, await deviceReach(d.id, timeoutMs)] as const)
  )
  return Object.fromEntries(pairs)
}
