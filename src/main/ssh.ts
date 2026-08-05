import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { getDeviceConn, getOsEndpoints, checkHostKey, forgetHostKey, type DeviceConn } from './vault'
import { UNIVERSAL_PROBE, parseAnyProbe } from './metrics'
import { tcpAlive } from './liveness'
import { singleFlight } from './single-flight'
import { trackedReach } from './reach-memory'
import type { LiveMetrics } from './types'
import { beginAccess, isAccessCurrent } from './access-epoch'
import { parseProbeHostOutput } from './ssh-probe'

/** ssh2's hostVerifier union resolves to the Buffer overload in TS; with hostHash:'sha256' the arg is a hex string.
 *  Factory returns a correctly-typed fingerprint verifier and pins the key TOFU-style. */
export function makeHostVerifier(
  host: string,
  port: number,
  onChanged?: (changed: boolean) => void
): NonNullable<ConnectConfig['hostVerifier']> & { commit: () => void } {
  // Закрепление откладывается до УСПЕШНОЙ аутентификации.
  //
  // Проверка ключа хоста происходит в рукопожатии, то есть раньше, чем мы предъявили пароль
  // или ключ. Раньше `checkHostKey` тут же вставлял запись в known_hosts — и один коннект по
  // ошибочному адресу (опечатка в IP, чужой хост на том же порту, перехваченный DNS) навсегда
  // закреплял ЧУЖОЙ ключ. Настоящий сервер после этого читался как «ключ изменился», то есть
  // предупреждение о подмене выдавалось ровно наоборот.
  //
  // Теперь при первом контакте ключ запоминается только в памяти; в хранилище он попадает
  // из `commit()`, который вызывается после `ready` — а до `ready` ssh2 доходит лишь пройдя
  // аутентификацию, то есть доказав, что это та машина, к которой у нас есть доступ.
  let pending: string | null = null
  const verifier = ((hash: string, cb: (ok: boolean) => void): void => {
    const verdict = checkHostKey(host, port, hash, { commit: false })
    if (verdict === 'new') pending = hash
    const changed = verdict === 'changed'
    if (onChanged) onChanged(changed)
    cb(!changed)
  }) as NonNullable<ConnectConfig['hostVerifier']> & { commit: () => void }

  verifier.commit = (): void => {
    if (pending === null) return
    checkHostKey(host, port, pending, { commit: true })
    pending = null
  }
  return verifier
}

/**
 * Закрепить ключ хоста, когда соединение действительно установилось.
 *
 * `ready` у ssh2 наступает уже ПОСЛЕ аутентификации, поэтому это единственный момент, когда
 * можно честно сказать «мы дошли до нужной машины». Проверка ключа происходит раньше, в
 * рукопожатии, и записывать его там было ошибкой.
 */
export function commitHostKeyOnReady(
  client: Client,
  verifier: NonNullable<ConnectConfig['hostVerifier']>
): void {
  const commit = (verifier as { commit?: () => void }).commit
  if (commit) client.once('ready', () => commit())
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
  const r = await execOnConn(conn, 'echo argus-ok', 8000, 8000)
  return r.ok && r.output.includes('argus-ok')
}

/** Разрешить рабочее соединение для устройства. Обычный сервер (одна ОС) → getDeviceConn как есть
 *  (сохраняет jump-host). Multi-boot ПК (несколько ОС) → терминал/файлы/порты должны идти на
 *  ЖИВУЮ ОС, а не на первичный (Linux) эндпоинт, который оффлайн когда запущена другая ОС:
 *  пробуем каждый эндпоинт `echo`, берём первый ответивший; фолбэк — primary. */
export async function resolveConn(deviceId: string): Promise<DeviceConn | null> {
  const eps = getOsEndpoints(deviceId)
  if (eps.length <= 1) return getDeviceConn(deviceId)

  // Было Promise.all — то есть ожидание САМОГО МЕДЛЕННОГО эндпоинта: выключенная половина
  // двухзагрузочного ПК съедала весь 8-секундный SSH-таймаут. А через resolveConn ходят
  // терминал, файлы, порты и экран — этот же штраф платили все они.
  // Стало: отсев по SSH-баннеру (~2.5с максимум) + гонка за первым ответившим.
  const reach = await Promise.all(
    eps.map(async (ep) => ({
      ep,
      up: (await tcpAlive(ep.conn.host, ep.conn.port, 2500)).status === 'online'
    }))
  )
  const open = reach.filter((r) => r.up).map((r) => r.ep)
  // Ровно один живой sshd — дальше проверять нечего, две ОС разом не работают.
  if (open.length === 1) return open[0].conn

  const list = open.length ? open : eps
  return new Promise<DeviceConn | null>((resolve) => {
    let pending = list.length
    const giveUp = (): void => resolve(getDeviceConn(deviceId))
    for (const ep of list) {
      void isConnAlive(ep.conn)
        .then((ok) => {
          if (ok) resolve(ep.conn)
          else if (--pending === 0) giveUp()
        })
        .catch(() => {
          if (--pending === 0) giveUp()
        })
    }
  })
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
  // Ключ хоста закрепляем только после `ready`: до него ssh2 не дойдёт, не пройдя
  // аутентификацию, — то есть машина доказала, что она та самая. Коннект по ошибочному
  // адресу теперь не оставляет за собой чужой закреплённый ключ.
  commitHostKeyOnReady(client, verifier)
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
  const jumpVerifier = makeHostVerifier(jump.host, jump.port)
  commitHostKeyOnReady(jumpClient, jumpVerifier)
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
      hostVerifier: jumpVerifier
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
  /** Снимаемый слушатель уничтожения окна — иначе он копится на каждом терминале. */
  onDestroyed?: () => void
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
  const accessTicket = beginAccess()
  const conn = await resolveConn(deviceId)
  if (!isAccessCurrent(accessTicket)) return { ok: false, error: 'Argus заблокирован' }
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
      if (!isAccessCurrent(accessTicket)) {
        client.end()
        done({ ok: false, error: 'Argus заблокирован' })
        return
      }
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          done({ ok: false, error: err.message })
          client.end()
          return
        }
        if (!isAccessCurrent(accessTicket)) {
          stream.end()
          client.end()
          done({ ok: false, error: 'Argus заблокирован' })
          return
        }
        // Слушатель сохраняем, чтобы снять его в cleanup. `once` срабатывает один раз, но
        // НЕ снимается, если событие так и не наступило: каждый открытый и закрытый терминал
        // навсегда оставлял на окне ещё одну ссылку. За долгую сессию их набираются десятки, и
        // Electron начинает ругаться на утечку слушателей — на симптом, а не на причину.
        const onDestroyed = (): void => closeShell(id)
        sessions.set(id, { id, client, stream, deviceId, wc, attached: false, buffer: [], onDestroyed })
        wc.once('destroyed', onDestroyed)
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

/**
 * «Доверять и переподключиться» — снять закрепление с ТОГО эндпоинта, к которому реально
 * пойдёт следующее подключение.
 *
 * Раньше интерфейс снимал закрепление с основного адреса устройства. У двухзагрузочного ПК
 * терминал идёт к той половине, что сейчас живая, — и это может быть альтернативная ОС со своим
 * адресом и своим ключом. Забывали не тот ключ, переподключение падало с той же ошибкой,
 * и кнопка не делала ничего, сколько по ней ни жми. Спрашиваем адрес там же, где его берёт
 * само подключение, — у resolveConn.
 *
 * Ключ бастиона (jump) намеренно не трогаем: он закреплён для многих устройств сразу,
 * и снимать его из-за одного хоста было бы слишком широким жестом.
 */
export async function forgetDeviceHostKey(
  deviceId: string
): Promise<{ ok: boolean; host?: string; port?: number; error?: string }> {
  const conn = await resolveConn(deviceId)
  if (!conn) return { ok: false, error: 'устройство не отвечает — непонятно, какому адресу доверять' }
  forgetHostKey(conn.host, conn.port)
  return { ok: true, host: conn.host, port: conn.port }
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

/** Закрыть терминалы ОДНОГО устройства. Возвращает, сколько закрыл. */
export function closeDevice(deviceId: string): number {
  const ids = [...sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => s.id)
  for (const id of ids) closeShell(id)
  return ids.length
}

function cleanup(id: string): void {
  const session = sessions.get(id)
  if (session?.onDestroyed) {
    try {
      session.wc.removeListener('destroyed', session.onDestroyed)
    } catch {
      /* окно уже уничтожено — снимать нечего */
    }
  }
  // Раньше сессия просто выбрасывалась из карты, а само SSH-соединение оставалось жить с
  // keep-alive до конца работы приложения. Каждый `exit` в терминале утекал одним соединением,
  // и закрыть его было уже нечем: по id сессии в карте больше нет.
  try {
    session?.client.end()
  } catch {
    /* уже закрыт */
  }
  sessions.delete(id)
}

export interface ProbeResult {
  ok: boolean
  status: 'online' | 'offline' | 'unknown'
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  disk?: number
  uptime?: number
  // v2-сводка для карточек/обзора (rate-поля — байт/с)
  load1?: number
  netRx?: number
  netTx?: number
  swapUsed?: number
  swapTotal?: number
  tempCpu?: number
  // полный live-снимок для вкладки «Метрики»
  metrics?: LiveMetrics
  error?: string
}

/** LiveMetrics → ProbeResult (сводка + полный снимок). */
export function liveToProbe(m: LiveMetrics): ProbeResult {
  return {
    ok: true,
    status: 'online',
    cpu: m.cpu,
    ramUsed: m.ramUsed,
    ramTotal: m.ramTotal,
    disk: m.disk,
    uptime: m.uptime,
    load1: m.load[0],
    netRx: m.netRx,
    netTx: m.netTx,
    swapUsed: m.swapUsed,
    swapTotal: m.swapTotal,
    tempCpu: m.tempCpu,
    metrics: m
  }
}

/**
 * Опросить машину. Одновременные опросы одного устройства склеиваются в один — см. single-flight.ts.
 *
 * Серия промахов считается ЗДЕСЬ, внутри склейки, а не у вызывающего. Пока `trackedReach`
 * стоял в обработчике IPC, склеенный опрос учитывался по разу у КАЖДОГО спрашивающего: при
 * открытой карточке по устройству независимо работают обновление карточки (раз в 12с) и общий
 * проход (раз в 30с), их окна регулярно пересекаются — и один-единственный промах давал сразу
 * два, то есть машина объявлялась выключенной с первой же неудачи. Ровно то, от чего правило
 * «одна неудача = не знаю» и защищает; ломалось оно молча и охотнее всего на медленном хосте,
 * потому что долгий опрос пересекается чаще быстрого.
 */
export function probe(deviceId: string): Promise<ProbeResult> {
  return singleFlight(`probe:${deviceId}`, async () => {
    const r = await probeNow(deviceId)
    return { ...r, status: trackedReach('probe', deviceId, r.ok ? 'online' : 'offline') }
  })
}

/**
 * Потолок на весь опрос одной машины.
 *
 * Заметно меньше, чем у произвольной команды: зонд — это фиксированный набор быстрых чтений
 * (/proc, df, sensors), и если он не уложился, дело не в объёме работы. Полный проход по парку
 * идёт раз в 30 секунд, поэтому один медленный хост не должен съедать весь интервал.
 *
 * Статус при истечении — `unknown`, а НЕ `offline`: мы не узнали ничего о машине, а не узнали,
 * что она выключена. Разница ровно та, из-за которой в проекте вообще появилось «не знаю».
 */
const PROBE_DEADLINE_MS = 20_000

function probeNow(deviceId: string): Promise<ProbeResult> {
  const conn = getDeviceConn(deviceId)
  if (!conn || isPlaceholderHost(conn.host) || !hasCredential(conn)) {
    return Promise.resolve({ ok: false, status: 'offline', error: 'no host/credentials' })
  }
  return new Promise<ProbeResult>((resolve) => {
    const client = new Client()
    let settled = false
    // Дедлайн на ВЫПОЛНЕНИЕ, а не только на рукопожатие.
    //
    // Тот же дефект, что чинили в `execOnConn`, — и здесь он опаснее. `readyTimeout` кончается
    // на аутентификации; дальше сервер может принять зонд и не закрыть поток (зависший диск,
    // отвалившийся NFS, полу-закрытое соединение). Тогда промис не разрешается никогда, а на
    // нём висят СРАЗУ ДВА замка: склейка одинаковых опросов в main и общий флаг «опрос идёт» в
    // renderer. Оба снимаются только по завершении — то есть весь дальнейший опрос парка молча
    // прекращается, и приложение до перезапуска показывает старые числа как свежие.
    const deadline = setTimeout(
      () => done({ ok: false, status: 'unknown', error: `зонд не ответил за ${PROBE_DEADLINE_MS / 1000}с` }),
      PROBE_DEADLINE_MS
    )
    deadline.unref?.()
    const done = (r: ProbeResult): void => {
      if (!settled) {
        settled = true
        clearTimeout(deadline)
        try {
          client.end()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
    }
    client.on('ready', () => {
      // Универсальный зонд: сам выбирает ветку по ОС (Linux / macOS / FreeBSD) одной командой.
      client.exec(UNIVERSAL_PROBE, (err, stream) => {
        if (err) {
          done({ ok: false, status: 'offline', error: err.message })
          return
        }
        let out = ''
        let code: number | null = null
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('exit', (c: number) => (code = c))
        stream.on('close', () => {
          // Раньше код возврата игнорировался, и ответ ЛЮБОГО шелла считался успехом. На
          // Windows-машине без второй ОС этот Linux-зонд возвращал мусор, который разбирался
          // в нули — и карточка бодро показывала «online · CPU 0% · 0/0 ГБ». Это хуже ошибки:
          // выглядит как настоящие данные и засоряет историю ровными нулями.
          const m = parseAnyProbe(out)
          const parsed = m.ramTotal > 0 || m.cpu > 0 || (m.uptime ?? 0) > 0
          if ((code !== null && code !== 0) || !parsed) {
            done({
              ok: false,
              status: 'offline',
              error: 'зонд не дал данных — вероятно, на хосте Windows (у него отдельная ветка) или урезанный busybox'
            })
            return
          }
          done(liveToProbe(m))
        })
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
  `OS=$([ ! -r /etc/os-release ] || . /etc/os-release; printf %s "$PRETTY_NAME"); [ -n "$OS" ] || OS=$(uname -srm 2>/dev/null); ` +
  `printf 'ARGUS_OS=%s\\n' "$OS"; ` +
  `printf 'ARGUS_HOST=%s\\n' "$(hostname 2>/dev/null)"; ` +
  `printf 'ARGUS_CORES=%s\\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"; ` +
  `printf 'ARGUS_LOAD=%s\\n' "$(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1)"; ` +
  `free -m 2>/dev/null | awk '/^Mem:/{printf "ARGUS_MEMTOTAL=%s\\nARGUS_MEMUSED=%s\\n",$2,$3}'`

const PROBE_HOST_WINDOWS_PS =
  `$ErrorActionPreference='Stop'; ` +
  `$os=Get-CimInstance Win32_OperatingSystem; ` +
  `$o=[ordered]@{os=[string]$os.Caption;hostname=[string]$env:COMPUTERNAME;` +
  `cores=[Environment]::ProcessorCount;ramTotalMb=[math]::Round([double]$os.TotalVisibleMemorySize/1024);` +
  `ramFreeMb=[math]::Round([double]$os.FreePhysicalMemory/1024)}; ` +
  `Write-Output ('ARGUS_WINDOWS='+($o|ConvertTo-Json -Compress))`
const PROBE_HOST_WINDOWS_CMD =
  `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(PROBE_HOST_WINDOWS_PS, 'utf16le').toString('base64')}`

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
    // Объявлено до `done`, потому что тот его гасит; создаётся ниже, где известен таймаут.
    let deadline: ReturnType<typeof setTimeout>
    const done = (r: ProbeHostResult): void => {
      if (!settled) {
        settled = true
        clearTimeout(deadline)
        try {
          client.end()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
    }
    deadline = setTimeout(() => done({ ok: false, error: 'SSH-проверка не завершилась за 25 секунд' }), 25000)
    deadline.unref?.()
    client.on('ready', () => {
      const runProbe = (command: string, fallback?: () => void): void => {
        client.exec(command, (err, stream) => {
          if (err) {
            if (fallback) fallback()
            else done({ ok: false, error: err.message })
            return
          }
          let out = ''
          stream.on('data', (d: Buffer) => (out += d.toString()))
          stream.on('close', () => {
            const parsed = parseProbeHostOutput(out)
            if (parsed) {
              done({ ok: true, ...parsed })
              return
            }
            if (fallback) fallback()
            else done({ ok: false, error: 'SSH-зонд не вернул подтверждённые сведения о системе' })
          })
        })
      }

      // OpenSSH на Unix принимает POSIX-команду, Windows OpenSSH — EncodedCommand PowerShell.
      // Только маркерный ответ решает, какая ветка сработала: exit code и сам факт shell
      // недостаточны и раньше превращали Windows-ошибку в успешные нулевые метрики.
      runProbe(PROBE_HOST_CMD, () => runProbe(PROBE_HOST_WINDOWS_CMD))
    })
    client.on('error', (e) => done({ ok: false, error: e.message }))
    // Собственный клиент, без establish, — поэтому закрепление вешаем здесь же.
    const probeVerifier = makeHostVerifier(opts.host, port)
    commitHostKeyOnReady(client, probeVerifier)
    client.connect({
      host: opts.host,
      port,
      username: opts.user || 'root',
      ...authFields({ password: opts.password, privateKey: opts.privateKey, passphrase: opts.passphrase }),
      readyTimeout: 12000,
      hostHash: 'sha256',
      hostVerifier: probeVerifier
    })
  })
}

/**
 * Потолок на выполнение одной команды, считая от рукопожатия.
 *
 * Щедрый намеренно: сюда попадают и пользовательские сниппеты, и сбор железа, который на
 * медленной машине идёт десятки секунд. Задача не «уложиться в норматив», а не дать зависшему
 * потоку остановить опрос парка навсегда.
 *
 * ВНИМАНИЕ: третий аргумент `execOnConn` — это таймаут РУКОПОЖАТИЯ, а не бюджет вызова. Все
 * вызывающие передают именно его, поэтому потолок выполнения у них остаётся этим. Чтобы
 * ограничить саму команду, передавать нужно и четвёртый аргумент.
 */
const EXEC_DEADLINE_MS = 90_000

/**
 * Потолок на объём вывода одной команды.
 *
 * Команду задаёт человек — сниппеты и «выполнить на многих» ходят сюда же, — и без потолка
 * один `cat` большого журнала или бинарника съедал память main-процесса, а затем то, что
 * уцелело, ещё и сериализовалось через IPC в интерфейс. У терминала потолок давно есть;
 * у разовой команды его не было. 8 МБ — заведомо больше любого осмысленного вывода
 * (самый крупный сборщик инвентаря укладывается в десятки килобайт).
 */
const EXEC_OUTPUT_CAP = 8 * 1024 * 1024

/** One-shot exec against an explicit connection bundle (reused by execOnce + pc dual-boot). */
export function execOnConn(
  conn: DeviceConn,
  command: string,
  readyTimeout = 15000,
  execTimeout = EXEC_DEADLINE_MS
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!conn.host || conn.host.includes('x.x')) return Promise.resolve({ ok: false, output: '', error: 'placeholder IP' })
  if (!hasCredential(conn)) return Promise.resolve({ ok: false, output: '', error: 'no credential' })
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    let out = ''
    // `readyTimeout` ограничивает ТОЛЬКО рукопожатие. Дальше стоял вечный ожидатель: сервер,
    // принявший команду и не закрывший поток (зависший `ss`, замерший диск, полу-закрытое
    // соединение), подвешивал промис навсегда. Наверху `refreshMetrics` держит один общий
    // флаг «опрос идёт» и снимает его в finally — который в этом случае не наступал никогда,
    // так что ВЕСЬ последующий опрос парка молча пропускался, а интерфейс до перезапуска
    // показывал старые числа как свежие. Отказ должен быть заметным, а не бесшумным.
    const deadline = setTimeout(
      () =>
        done({
          ok: false,
          output: out.trimEnd(),
          error: `команда не ответила за ${Math.round(execTimeout / 1000)}с`
        }),
      execTimeout
    )
    deadline.unref?.()
    const done = (r: { ok: boolean; output: string; error?: string }): void => {
      if (!settled) {
        settled = true
        clearTimeout(deadline)
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
        // Обрезаем на потолке и говорим об этом прямо: молча укороченный вывод хуже честно
        // обрезанного — по нему делают выводы.
        let truncated = false
        const collect = (d: Buffer): void => {
          if (out.length >= EXEC_OUTPUT_CAP) {
            if (!truncated) {
              truncated = true
              out += `\n… вывод обрезан на ${EXEC_OUTPUT_CAP / (1024 * 1024)} МБ`
            }
            return
          }
          out += d.toString()
        }
        stream.on('data', collect)
        stream.stderr.on('data', collect)
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
    // При reboot соединение может оборваться ПОСЛЕ того, как удалённая команда успела
    // напечатать маркер принятого действия. Не теряем уже полученный stdout: вызывающий код
    // отличит доказанный reboot-disconnect от ECONNRESET на рукопожатии.
    client.on('error', (e) => done({ ok: false, output: out.trimEnd(), error: e.message }))
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
