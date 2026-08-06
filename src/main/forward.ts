import { Client } from 'ssh2'
import * as net from 'node:net'
import { randomUUID } from 'node:crypto'
import { resolveConn, makeHostVerifier, establish, hasCredential } from './ssh'
import { beginAccess, isAccessCurrent } from './access-epoch'
import { isForwardPort } from '../shared/net-port'
export { isForwardPort }

interface Forward {
  id: string
  deviceId: string
  localPort: number
  remoteHost: string
  remotePort: number
  client: Client
  server: net.Server
  dispose: () => void
}
const forwards = new Map<string, Forward>()

/** TCP-порт в SSH direct-tcpip и node:net — целое 1..65535. */
export interface ForwardInfo {
  id: string
  deviceId: string
  localPort: number
  remoteHost: string
  remotePort: number
}

/** Local (-L) forward: listen on 127.0.0.1:localPort, tunnel each connection to remoteHost:remotePort via the device. */
export async function openLocalForward(
  deviceId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!isForwardPort(localPort) || !isForwardPort(remotePort)) {
    return { ok: false, error: 'Порты должны быть целыми числами от 1 до 65535' }
  }
  const accessTicket = beginAccess()
  const conn = await resolveConn(deviceId)
  if (!isAccessCurrent(accessTicket)) return { ok: false, error: 'Argus заблокирован' }
  if (!conn) return Promise.resolve({ ok: false, error: 'device not found' })
  if (!conn.host || conn.host.includes('x.x') || !hasCredential(conn)) {
    return Promise.resolve({ ok: false, error: 'нет реального host или SSH-доступа (пароль/ключ)' })
  }
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    let server: net.Server | null = null
    let forwardId: string | null = null
    let closing = false
    const done = (r: { ok: boolean; id?: string; error?: string }): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    const dispose = (endClient = true): void => {
      if (closing) return
      closing = true
      if (forwardId) forwards.delete(forwardId)
      try {
        server?.close()
      } catch {
        /* listener ещё не успел запуститься или уже закрыт */
      }
      if (endClient) {
        try {
          client.end()
        } catch {
          /* SSH уже закрыт */
        }
      }
    }
    const fail = (error: string): void => {
      dispose()
      done({ ok: false, error })
    }
    client.on('ready', () => {
      if (!isAccessCurrent(accessTicket)) {
        fail('Argus заблокирован')
        return
      }
      server = net.createServer((sock) => {
        try {
          client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, stream) => {
            if (err) {
              sock.destroy()
              return
            }
            stream.on('error', () => sock.destroy())
            sock.on('error', () => stream.destroy())
            sock.pipe(stream).pipe(sock)
          })
        } catch {
          // ssh2 бросает синхронно, если SSH уже закрылся. Не оставляем мёртвый listener.
          sock.destroy()
          dispose()
        }
      })
      server.on('error', (e) => {
        fail('listen: ' + e.message)
      })
      try {
        server.listen(localPort, '127.0.0.1', () => {
          if (closing) return
          if (!isAccessCurrent(accessTicket)) {
            fail('Argus заблокирован')
            return
          }
          forwardId = randomUUID()
          forwards.set(forwardId, {
            id: forwardId,
            deviceId,
            localPort,
            remoteHost,
            remotePort,
            client,
            server: server!,
            dispose
          })
          done({ ok: true, id: forwardId })
        })
      } catch (e) {
        fail('listen: ' + (e as Error).message)
      }
    })
    client.on('error', (e) => fail(e.message))
    client.on('close', () => {
      const wasOpen = Boolean(forwardId)
      dispose(false)
      if (!wasOpen) done({ ok: false, error: 'Соединение SSH закрылось до запуска туннеля' })
    })
    // Через jump-бастион если задан — иначе проброс портов не работал у jump-хостов.
    establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) => fail(e.message))
  })
}

export function closeForward(id: string): void {
  const f = forwards.get(id)
  f?.dispose()
}

export function listForwards(deviceId?: string): ForwardInfo[] {
  return [...forwards.values()]
    .filter((f) => !deviceId || f.deviceId === deviceId)
    .map((f) => ({ id: f.id, deviceId: f.deviceId, localPort: f.localPort, remoteHost: f.remoteHost, remotePort: f.remotePort }))
}

export function closeAllForwards(): void {
  for (const id of [...forwards.keys()]) closeForward(id)
}
