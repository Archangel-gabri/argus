import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { getDeviceConn, checkHostKey, type DeviceConn } from './vault'

/** ssh2's hostVerifier union resolves to the Buffer overload in TS; with hostHash:'sha256' the arg is a hex string.
 *  Factory returns a correctly-typed fingerprint verifier and pins the key TOFU-style. */
export function makeHostVerifier(
  host: string,
  port: number,
  onChanged?: (changed: boolean) => void
): NonNullable<ConnectConfig['hostVerifier']> {
  return ((hash: string, cb: (ok: boolean) => void): void => {
    const changed = checkHostKey(host, port, hash) === 'changed'
    if (onChanged) onChanged(changed)
    cb(!changed)
  }) as NonNullable<ConnectConfig['hostVerifier']>
}

/** Build the ssh2 auth fields from a credential bundle: private key wins, else password. */
type AuthFields = Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'>
function authFields(c: {
  password: string | null
  privateKey?: string | null
  passphrase?: string | null
}): AuthFields {
  if (c.privateKey) return { privateKey: c.privateKey, passphrase: c.passphrase || undefined }
  return { password: c.password ?? undefined }
}
const hasCredential = (c: { password: string | null; privateKey?: string | null }): boolean =>
  Boolean(c.password || c.privateKey)

interface Session {
  id: string
  client: Client
  stream: ClientChannel | null
  deviceId: string
}

const sessions = new Map<string, Session>()

export interface OpenResult {
  ok: boolean
  sessionId?: string
  error?: string
}

const isPlaceholderHost = (host: string): boolean => !host || host.includes('x.x')

/** Open an interactive shell. Streams output to the renderer as base64 'ssh:data' events. */
export function openShell(wc: WebContents, deviceId: string, cols = 80, rows = 24): Promise<OpenResult> {
  const conn = getDeviceConn(deviceId)
  if (!conn) return Promise.resolve({ ok: false, error: 'Device not found' })
  if (isPlaceholderHost(conn.host)) {
    return Promise.resolve({ ok: false, error: 'Placeholder IP — edit the device and set a real host first.' })
  }
  if (!hasCredential(conn)) {
    return Promise.resolve({ ok: false, error: 'No SSH credential stored. Edit the device and add a password or private key.' })
  }

  return new Promise<OpenResult>((resolve) => {
    const client = new Client()
    const id = randomUUID()
    let settled = false
    let hostKeyChanged = false
    const done = (r: OpenResult): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          done({ ok: false, error: err.message })
          client.end()
          return
        }
        sessions.set(id, { id, client, stream, deviceId })
        const forward = (d: Buffer): void => {
          if (!wc.isDestroyed()) wc.send('ssh:data', { sessionId: id, data: d.toString('base64') })
        }
        stream.on('data', forward)
        stream.stderr.on('data', forward)
        stream.on('close', () => {
          if (!wc.isDestroyed()) wc.send('ssh:exit', { sessionId: id })
          cleanup(id)
        })
        done({ ok: true, sessionId: id })
      })
    })
    client.on('error', (e) =>
      done({
        ok: false,
        error: hostKeyChanged
          ? `⚠ Host key CHANGED for ${conn.host} — possible MITM. If this is expected, forget the saved key first.`
          : e.message
      })
    )
    client.on('close', () => {
      if (!settled) done({ ok: false, error: 'Connection closed' })
    })

    const verifier = makeHostVerifier(conn.host, conn.port, (changed) => {
      hostKeyChanged = changed
    })
    const connectTarget = (sock?: ClientChannel): void => {
      try {
        const base = {
          username: conn.user,
          ...authFields(conn),
          readyTimeout: 15000,
          keepaliveInterval: 20000,
          hostHash: 'sha256' as const,
          hostVerifier: verifier
        }
        if (sock) client.connect({ ...base, sock })
        else client.connect({ ...base, host: conn.host, port: conn.port })
      } catch (e) {
        done({ ok: false, error: (e as Error).message })
      }
    }

    if (conn.jump) {
      // Single-hop bastion: connect the jump, forward a channel to the target, tunnel the target over it.
      const jump = conn.jump
      const jumpClient = new Client()
      jumpClient.on('error', (e) => done({ ok: false, error: 'jump-host: ' + e.message }))
      jumpClient.on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, conn.host, conn.port, (err, stream) => {
          if (err) {
            done({ ok: false, error: 'jump forward: ' + err.message })
            jumpClient.end()
            return
          }
          connectTarget(stream)
        })
      })
      client.on('close', () => {
        try {
          jumpClient.end()
        } catch {
          /* ignore */
        }
      })
      try {
        jumpClient.connect({
          host: jump.host,
          port: jump.port,
          username: jump.user,
          ...authFields(jump),
          readyTimeout: 15000
        })
      } catch (e) {
        done({ ok: false, error: (e as Error).message })
      }
    } else {
      connectTarget()
    }
  })
}

export function writeShell(sessionId: string, data: string): void {
  sessions.get(sessionId)?.stream?.write(data)
}

export function resizeShell(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
}

export function closeShell(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) {
    try {
      s.stream?.end()
      s.client.end()
    } catch {
      /* ignore */
    }
    cleanup(sessionId)
  }
}

export function closeAll(): void {
  for (const id of [...sessions.keys()]) closeShell(id)
}

function cleanup(id: string): void {
  sessions.delete(id)
}

export interface ProbeResult {
  ok: boolean
  status: 'online' | 'offline'
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  error?: string
}

// Agentless: loadavg-based CPU%, free -m for RAM. Runs over a one-shot exec, no agent installed.
const PROBE_CMD = `cat /proc/loadavg | cut -d' ' -f1; nproc; free -m | awk '/^Mem:/{print $2, $3}'`

export function probe(deviceId: string): Promise<ProbeResult> {
  const conn = getDeviceConn(deviceId)
  if (!conn || isPlaceholderHost(conn.host) || !hasCredential(conn)) {
    return Promise.resolve({ ok: false, status: 'offline', error: 'no host/credentials' })
  }
  return new Promise<ProbeResult>((resolve) => {
    const client = new Client()
    let settled = false
    const done = (r: ProbeResult): void => {
      if (!settled) {
        settled = true
        try {
          client.end()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
    }
    client.on('ready', () => {
      client.exec(PROBE_CMD, (err, stream) => {
        if (err) {
          done({ ok: false, status: 'offline', error: err.message })
          return
        }
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => {
          const lines = out.trim().split('\n')
          const load1 = parseFloat(lines[0]) || 0
          const cores = parseInt(lines[1], 10) || 1
          const [totalMb, usedMb] = (lines[2] || '').trim().split(/\s+/).map((n) => parseFloat(n) || 0)
          done({
            ok: true,
            status: 'online',
            cpu: Math.min(100, Math.round((load1 / cores) * 100)),
            ramTotal: Math.round((totalMb / 1024) * 10) / 10,
            ramUsed: Math.round((usedMb / 1024) * 10) / 10
          })
        })
      })
    })
    client.on('error', (e) => done({ ok: false, status: 'offline', error: e.message }))
    client.connect({
      host: conn.host,
      port: conn.port,
      username: conn.user,
      ...authFields(conn),
      readyTimeout: 10000,
      hostHash: 'sha256',
      hostVerifier: makeHostVerifier(conn.host, conn.port)
    })
  })
}

export interface ProbeHostResult {
  ok: boolean
  os?: string
  hostname?: string
  cores?: number
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  error?: string
}

// Agentless one-shot: OS + hostname + cores + loadavg + RAM. All read-only, no install.
const PROBE_HOST_CMD =
  `printf 'OS=%s\\n' "$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME)"; ` +
  `printf 'HOST=%s\\n' "$(hostname 2>/dev/null)"; ` +
  `printf 'CORES=%s\\n' "$(nproc 2>/dev/null)"; ` +
  `printf 'LOAD=%s\\n' "$(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1)"; ` +
  `free -m 2>/dev/null | awk '/^Mem:/{printf "MEMTOTAL=%s\\nMEMUSED=%s\\n",$2,$3}'`

/** Probe a host with explicit creds (used before a device is saved — the "auto-fill" button). */
export function probeHost(opts: {
  host: string
  port: number
  user: string
  password: string
  privateKey?: string
  passphrase?: string
}): Promise<ProbeHostResult> {
  if (!opts.host || opts.host.includes('x.x')) return Promise.resolve({ ok: false, error: 'Укажите реальный host' })
  if (!opts.password && !opts.privateKey) return Promise.resolve({ ok: false, error: 'Нужен пароль или ключ для SSH-проверки' })
  const port = opts.port || 22
  return new Promise<ProbeHostResult>((resolve) => {
    const client = new Client()
    let settled = false
    const done = (r: ProbeHostResult): void => {
      if (!settled) {
        settled = true
        try {
          client.end()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
    }
    client.on('ready', () => {
      client.exec(PROBE_HOST_CMD, (err, stream) => {
        if (err) {
          done({ ok: false, error: err.message })
          return
        }
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => {
          const kv: Record<string, string> = {}
          for (const line of out.split('\n')) {
            const i = line.indexOf('=')
            if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
          }
          const cores = parseInt(kv.CORES, 10) || 1
          const load = parseFloat(kv.LOAD) || 0
          const totalMb = parseFloat(kv.MEMTOTAL) || 0
          const usedMb = parseFloat(kv.MEMUSED) || 0
          done({
            ok: true,
            os: kv.OS || undefined,
            hostname: kv.HOST || undefined,
            cores,
            cpu: Math.min(100, Math.round((load / cores) * 100)),
            ramTotal: Math.round((totalMb / 1024) * 10) / 10,
            ramUsed: Math.round((usedMb / 1024) * 10) / 10
          })
        })
      })
    })
    client.on('error', (e) => done({ ok: false, error: e.message }))
    client.connect({
      host: opts.host,
      port,
      username: opts.user || 'root',
      ...authFields({ password: opts.password, privateKey: opts.privateKey, passphrase: opts.passphrase }),
      readyTimeout: 12000,
      hostHash: 'sha256',
      hostVerifier: makeHostVerifier(opts.host, port)
    })
  })
}

/** One-shot exec against an explicit connection bundle (reused by execOnce + pc dual-boot). */
export function execOnConn(
  conn: DeviceConn,
  command: string,
  readyTimeout = 15000
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!conn.host || conn.host.includes('x.x')) return Promise.resolve({ ok: false, output: '', error: 'placeholder IP' })
  if (!hasCredential(conn)) return Promise.resolve({ ok: false, output: '', error: 'no credential' })
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    const done = (r: { ok: boolean; output: string; error?: string }): void => {
      if (!settled) {
        settled = true
        try {
          client.end()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
    }
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          done({ ok: false, output: '', error: err.message })
          return
        }
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.stderr.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => done({ ok: true, output: out.trimEnd() }))
      })
    })
    client.on('error', (e) => done({ ok: false, output: '', error: e.message }))
    client.connect({
      host: conn.host,
      port: conn.port,
      username: conn.user,
      ...authFields(conn),
      readyTimeout,
      hostHash: 'sha256',
      hostVerifier: makeHostVerifier(conn.host, conn.port)
    })
  })
}

/** One-shot exec on a device (for snippets + broadcast). Connects, runs, returns combined output. */
export function execOnce(deviceId: string, command: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const conn = getDeviceConn(deviceId)
  if (!conn) return Promise.resolve({ ok: false, output: '', error: 'device not found' })
  return execOnConn(conn, command)
}
