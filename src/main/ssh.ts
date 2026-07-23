import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { getDeviceConn, getOsEndpoints, checkHostKey, type DeviceConn } from './vault'

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
export function authFields(c: {
  password: string | null
  privateKey?: string | null
  passphrase?: string | null
}): AuthFields {
  if (c.privateKey) return { privateKey: c.privateKey, passphrase: c.passphrase || undefined }
  return { password: c.password ?? undefined }
}
export const hasCredential = (c: { password: string | null; privateKey?: string | null }): boolean =>
  Boolean(c.password || c.privateKey)

/** Жив ли эндпоинт: `echo` работает и в bash, и в Windows PowerShell. */
async function isConnAlive(conn: DeviceConn): Promise<boolean> {
  const r = await execOnConn(conn, 'echo argus-ok', 8000)
  return r.ok && r.output.includes('argus-ok')
}

/** Разрешить рабочее соединение для устройства. Обычный сервер (одна ОС) → getDeviceConn как есть
 *  (сохраняет jump-host). Multi-boot ПК (несколько ОС) → терминал/файлы/порты должны идти на
 *  ЖИВУЮ ОС, а не на первичный (Linux) эндпоинт, который оффлайн когда запущена другая ОС:
 *  пробуем каждый эндпоинт `echo`, берём первый ответивший; фолбэк — primary. */
export async function resolveConn(deviceId: string): Promise<DeviceConn | null> {
  const eps = getOsEndpoints(deviceId)
  if (eps.length <= 1) return getDeviceConn(deviceId)
  const checked = await Promise.all(eps.map(async (ep) => ((await isConnAlive(ep.conn)) ? ep.conn : null)))
  return checked.find((c): c is DeviceConn => c !== null) ?? getDeviceConn(deviceId)
}

/** Подключить уже созданный ssh2-Client к conn — напрямую или ТУННЕЛЕМ через conn.jump.
 *  Пинит host-key (TOFU) на ОБОИХ прыжках (баг: раньше jump-хост не проверялся). Вызывающий
 *  сам вешает client 'ready'/'error'/'close'; onError зовётся при сбое jump-плеча или синхронном
 *  throw connect. Единый путь для терминала/файлов/портов/exec/probe — раньше jump был только у терминала. */
export function establish(
  client: Client,
  conn: DeviceConn,
  verifier: NonNullable<ConnectConfig['hostVerifier']>,
  onError: (e: Error) => void,
  readyTimeout = 15000
): void {
  const base = {
    username: conn.user,
    ...authFields(conn),
    readyTimeout,
    keepaliveInterval: 20000,
    hostHash: 'sha256' as const,
    hostVerifier: verifier
  }
  if (!conn.jump) {
    try {
      client.connect({ ...base, host: conn.host, port: conn.port })
    } catch (e) {
      onError(e as Error)
    }
    return
  }
  const jump = conn.jump
  const jumpClient = new Client()
  jumpClient.on('error', (e) => onError(new Error('jump-host: ' + e.message)))
  jumpClient.on('ready', () => {
    jumpClient.forwardOut('127.0.0.1', 0, conn.host, conn.port, (err, stream) => {
      if (err) {
        onError(new Error('jump forward: ' + err.message))
        jumpClient.end()
        return
      }
      try {
        client.connect({ ...base, sock: stream })
      } catch (e) {
        onError(e as Error)
      }
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
      readyTimeout,
      hostHash: 'sha256',
      hostVerifier: makeHostVerifier(jump.host, jump.port)
    })
  } catch (e) {
    onError(e as Error)
  }
}

interface Session {
  id: string
  client: Client
  stream: ClientChannel | null
  deviceId: string
  wc: WebContents
  // Байты, пришедшие ДО того как рендерер подписался (ssh:attach), буферизуем — иначе
  // приглашение/баннер, отправленные между resolve(open) и подпиской onData, терялись.
  attached: boolean
  buffer: string[]
}

const sessions = new Map<string, Session>()

export interface OpenResult {
  ok: boolean
  sessionId?: string
  error?: string
}

const isPlaceholderHost = (host: string): boolean => !host || host.includes('x.x')

/** Open an interactive shell. Streams output to the renderer as base64 'ssh:data' events. */
export async function openShell(wc: WebContents, deviceId: string, cols = 80, rows = 24): Promise<OpenResult> {
  const conn = await resolveConn(deviceId)
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
        sessions.set(id, { id, client, stream, deviceId, wc, attached: false, buffer: [] })
        const forward = (d: Buffer): void => {
          const s = sessions.get(id)
          if (!s) return
          const b64 = d.toString('base64')
          if (!s.attached) {
            s.buffer.push(b64)
            if (s.buffer.length > 2000) s.buffer.shift() // страховка от разрастания, если рендерер не подписался
            return
          }
          if (!wc.isDestroyed()) wc.send('ssh:data', { sessionId: id, data: b64 })
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
    // Единый путь подключения: напрямую или через jump-бастион (с TOFU на обоих хопах).
    establish(client, conn, verifier, (e) => done({ ok: false, error: e.message }))
  })
}

export function writeShell(sessionId: string, data: string): void {
  sessions.get(sessionId)?.stream?.write(data)
}

/** Рендерер подписался на ssh:data — сливаем накопленный до подписки буфер и включаем прямой поток. */
export function attachShell(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s || s.attached) return
  s.attached = true
  if (!s.wc.isDestroyed()) for (const data of s.buffer) s.wc.send('ssh:data', { sessionId, data })
  s.buffer = []
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
  disk?: number
  uptime?: number
  error?: string
}

// Agentless, один exec, без агента. CPU% — РЕАЛЬНАЯ утилизация по дельте /proc/stat (два сэмпла с
// паузой 0.3с), а не load average (прежний load1/cores врал: >100% при I/O-очереди, 0% при коротком
// всплеске). Далее: loadavg (задел на Stage 2), free -m RAM, df / диск%, /proc/uptime.
const PROBE_CMD =
  `awk '/^cpu /{idle=$5+$6;non=$2+$3+$4+$7+$8+$9;print non+idle, idle}' /proc/stat; ` +
  `sleep 0.3; ` +
  `awk '/^cpu /{idle=$5+$6;non=$2+$3+$4+$7+$8+$9;print non+idle, idle}' /proc/stat; ` +
  `cut -d' ' -f1 /proc/loadavg; ` +
  `free -m | awk '/^Mem:/{print $2, $3}'; ` +
  `df -P / | awk 'NR==2{gsub(/%/,"",$5);print $5}'; ` +
  `awk '{print int($1)}' /proc/uptime`

/** Разбор вывода PROBE_CMD в метрики (переиспользуется pc.ts для Linux-эндпоинта).
 *  Строки: 0=«total idle» сэмпл1, 1=«total idle» сэмпл2, 2=load1, 3=«memTotal memUsed», 4=disk%, 5=uptime. */
export function parseLinuxProbe(out: string): ProbeResult {
  const lines = out.trim().split('\n')
  const [t1, i1] = (lines[0] || '').trim().split(/\s+/).map((n) => parseFloat(n) || 0)
  const [t2, i2] = (lines[1] || '').trim().split(/\s+/).map((n) => parseFloat(n) || 0)
  const dt = t2 - t1
  const di = i2 - i1
  const cpu = dt > 0 ? Math.min(100, Math.max(0, Math.round((100 * (dt - di)) / dt))) : 0
  const [totalMb, usedMb] = (lines[3] || '').trim().split(/\s+/).map((n) => parseFloat(n) || 0)
  const disk = parseFloat(lines[4])
  const uptime = parseInt(lines[5], 10)
  return {
    ok: true,
    status: 'online',
    cpu,
    ramTotal: Math.round((totalMb / 1024) * 10) / 10,
    ramUsed: Math.round((usedMb / 1024) * 10) / 10,
    disk: Number.isFinite(disk) ? disk : undefined,
    uptime: Number.isFinite(uptime) ? uptime : undefined
  }
}

export const LINUX_PROBE_CMD = PROBE_CMD

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
        stream.on('close', () => done(parseLinuxProbe(out)))
      })
    })
    client.on('error', (e) => done({ ok: false, status: 'offline', error: e.message }))
    // Через jump-бастион если задан — иначе метрики jump-хостов вечно «offline».
    establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) => done({ ok: false, status: 'offline', error: e.message }), 10000)
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
        // Читаем РЕАЛЬНЫЙ код возврата: раньше всегда ok:true, из-за чего упавший
        // `sudo -n systemctl reboot` (нет passwordless sudo, exit 1) рапортовал успех.
        // code===0 → ok. Ненулевой/сигнал → провал с пометкой exit N (без слов
        // «closed/disconnect», чтобы pc.power не принял это за успешный ребут-дисконнект).
        stream.on('close', (code: number | null, signal?: string) => {
          const okCode = code === 0
          done({
            ok: okCode,
            output: out.trimEnd(),
            error: okCode ? undefined : signal ? `signal ${signal}` : `exit ${code ?? '?'}`
          })
        })
      })
    })
    client.on('error', (e) => done({ ok: false, output: '', error: e.message }))
    // Через jump-бастион если задан (раньше exec/snippets/power игнорировали jump).
    establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) => done({ ok: false, output: '', error: e.message }), readyTimeout)
  })
}

/** One-shot exec on a device (for snippets + broadcast). Connects, runs, returns combined output.
 *  resolveConn → для multi-boot ПК команда идёт на ЖИВУЮ ОС, а не на оффлайн-первичный эндпоинт. */
export async function execOnce(deviceId: string, command: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const conn = await resolveConn(deviceId)
  if (!conn) return { ok: false, output: '', error: 'device not found' }
  return execOnConn(conn, command)
}
