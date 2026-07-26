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

export interface Reach {
  up: boolean
  ms: number
}

/** Коннект + ожидание SSH-баннера. Резолв DNS входит в бюджет. */
export function tcpAlive(host: string, port: number, timeoutMs = 4000): Promise<Reach> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    if (!host || host.includes('x.x')) return resolve({ up: false, ms: 0 })
    const sock = new net.Socket()
    let done = false
    const finish = (up: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ up, ms: Date.now() - t0 })
    }
    sock.setTimeout(timeoutMs)
    // Коннект сам по себе НИЧЕГО не доказывает — ждём данные.
    sock.once('data', (buf: Buffer) => finish(buf.toString('latin1', 0, 4) === 'SSH-'))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.once('close', () => finish(false))
    sock.connect({ host, port: port || 22 })
  })
}

/** Достижимо ли устройство хоть по одному из своих ОС-эндпоинтов (multi-boot ПК — по любому). */
export async function deviceReach(deviceId: string, timeoutMs = 4000): Promise<Reach> {
  const eps = getOsEndpoints(deviceId)
  const conns = eps.length ? eps.map((e) => e.conn) : [getDeviceConn(deviceId)].filter((c) => c !== null)
  if (!conns.length) return { up: false, ms: 0 }
  const results = await Promise.all(conns.map((c) => tcpAlive(c.host, c.port, timeoutMs)))
  const alive = results.filter((r) => r.up)
  return alive.length
    ? { up: true, ms: Math.min(...alive.map((r) => r.ms)) }
    : { up: false, ms: Math.max(...results.map((r) => r.ms)) }
}

/** Разом по всему парку — параллельно. Именно это зовём сразу после входа в приложение. */
export async function fleetReach(timeoutMs = 4000): Promise<Record<string, Reach>> {
  const devices = listDevices()
  const pairs = await Promise.all(
    devices.map(async (d) => [d.id, await deviceReach(d.id, timeoutMs)] as const)
  )
  return Object.fromEntries(pairs)
}
