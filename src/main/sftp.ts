import { Client, type SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import { resolveConn, makeHostVerifier, establish, hasCredential } from './ssh'

interface SftpSession {
  id: string
  client: Client
  sftp: SFTPWrapper
}
const sessions = new Map<string, SftpSession>()

export interface SftpEntry {
  name: string
  type: 'd' | 'f' | 'l'
  size: number
  mtime: number
}

export async function sftpOpen(deviceId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const conn = await resolveConn(deviceId)
  if (!conn) return Promise.resolve({ ok: false, error: 'Device not found' })
  if (!conn.host || conn.host.includes('x.x')) return Promise.resolve({ ok: false, error: 'Placeholder IP — set a real host first.' })
  if (!hasCredential(conn)) return Promise.resolve({ ok: false, error: 'No SSH credential stored (password or key).' })
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    const done = (r: { ok: boolean; sessionId?: string; error?: string }): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) {
          done({ ok: false, error: err.message })
          client.end()
          return
        }
        const id = randomUUID()
        sessions.set(id, { id, client, sftp })
        done({ ok: true, sessionId: id })
      })
    })
    client.on('error', (e) => done({ ok: false, error: e.message }))
    // Через jump-бастион если задан — иначе Файлы не открывались у jump-хостов.
    establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) => done({ ok: false, error: e.message }))
  })
}

export function sftpList(
  sessionId: string,
  path: string
): Promise<{ ok: boolean; path: string; entries?: SftpEntry[]; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, path, error: 'session closed' })
  const p = path || '.'
  return new Promise((resolve) => {
    s.sftp.realpath(p, (rerr, abs) => {
      const dir = rerr ? p : abs
      s.sftp.readdir(dir, (err, list) => {
        if (err) {
          resolve({ ok: false, path: dir, error: err.message })
          return
        }
        const entries: SftpEntry[] = list
          .map((e) => ({
            name: e.filename,
            type: (e.longname.startsWith('d') ? 'd' : e.longname.startsWith('l') ? 'l' : 'f') as SftpEntry['type'],
            size: e.attrs.size,
            mtime: e.attrs.mtime
          }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1))
        resolve({ ok: true, path: dir, entries })
      })
    })
  })
}

export async function sftpDownload(sessionId: string, remotePath: string): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return { ok: false, error: 'session closed' }
  const base = remotePath.split('/').pop() || 'download'
  const res = await dialog.showSaveDialog({ defaultPath: base })
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
  const target = res.filePath
  return new Promise((resolve) => {
    s.sftp.fastGet(remotePath, target, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
  })
}

export async function sftpUpload(
  sessionId: string,
  remoteDir: string
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return { ok: false, error: 'session closed' }
  const res = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'canceled' }
  const local = res.filePaths[0]
  const name = local.split('/').pop() || 'file'
  const remote = remoteDir.replace(/\/$/, '') + '/' + name
  return new Promise((resolve) => {
    s.sftp.fastPut(local, remote, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, name }))
  })
}

export function sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, error: 'session closed' })
  return new Promise((resolve) => {
    const cb = (err: Error | null | undefined): void => resolve(err ? { ok: false, error: err.message } : { ok: true })
    if (isDir) s.sftp.rmdir(path, cb)
    else s.sftp.unlink(path, cb)
  })
}

export function sftpClose(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) {
    try {
      s.client.end()
    } catch {
      /* ignore */
    }
    sessions.delete(sessionId)
  }
}

export function sftpCloseAll(): void {
  for (const id of [...sessions.keys()]) sftpClose(id)
}
