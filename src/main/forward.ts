import { Client } from 'ssh2'
import * as net from 'node:net'
import { randomUUID } from 'node:crypto'
import { resolveConn, makeHostVerifier, establish, hasCredential } from './ssh'

interface Forward {
  id: string
  deviceId: string
  localPort: number
  remoteHost: string
  remotePort: number
  client: Client
  server: net.Server
}
const forwards = new Map<string, Forward>()

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
  const conn = await resolveConn(deviceId)
  if (!conn) return Promise.resolve({ ok: false, error: 'device not found' })
  if (!conn.host || conn.host.includes('x.x') || !hasCredential(conn)) {
    return Promise.resolve({ ok: false, error: 'нет реального host или SSH-доступа (пароль/ключ)' })
  }
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    const done = (r: { ok: boolean; id?: string; error?: string }): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    client.on('ready', () => {
      const server = net.createServer((sock) => {
        client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, stream) => {
          if (err) {
            sock.destroy()
            return
          }
          sock.pipe(stream).pipe(sock)
        })
      })
      server.on('error', (e) => {
        done({ ok: false, error: 'listen: ' + e.message })
        try {
          client.end()
        } catch {
          /* ignore */
        }
      })
      server.listen(localPort, '127.0.0.1', () => {
        const id = randomUUID()
        forwards.set(id, { id, deviceId, localPort, remoteHost, remotePort, client, server })
        done({ ok: true, id })
      })
    })
    client.on('error', (e) => done({ ok: false, error: e.message }))
    // Через jump-бастион если задан — иначе проброс портов не работал у jump-хостов.
    establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) => done({ ok: false, error: e.message }))
  })
}

export function closeForward(id: string): void {
  const f = forwards.get(id)
  if (f) {
    try {
      f.server.close()
      f.client.end()
    } catch {
      /* ignore */
    }
    forwards.delete(id)
  }
}

export function listForwards(deviceId?: string): ForwardInfo[] {
  return [...forwards.values()]
    .filter((f) => !deviceId || f.deviceId === deviceId)
    .map((f) => ({ id: f.id, deviceId: f.deviceId, localPort: f.localPort, remoteHost: f.remoteHost, remotePort: f.remotePort }))
}

export function closeAllForwards(): void {
  for (const id of [...forwards.keys()]) closeForward(id)
}
