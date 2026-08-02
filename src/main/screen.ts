// Скринеринг (Этап 4) — фундамент. Пока: пред-полётная проба готовности ПК по SSH (ОС/сессия,
// аппаратный энкодер, тип захвата, установлен ли агент) → вкладка «Экран» показывает, заведётся ли
// стрим и на каком бэкенде. Сам стрим-агент (захват+энкод+WebRTC+ввод) — следующий инкремент.
// Архитектура (из docs/overhaul-2026-07-23/screen-research.md + синтеза Fable/Claude): свой единый
// тонкий агент (GStreamer webrtcsink / Pion), авто-provision по SSH, WebRTC в изолированном
// WebContentsView, ввод Win SendInput / Linux libei→uinput, энкод-каскад NVENC→VAAPI→софт.
import crypto from 'node:crypto'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { screen as electronScreen, BrowserWindow } from 'electron'
import GuacamoleLite from 'guacamole-lite'
import { execOnce, resolveConn } from './ssh'
import { whichOs } from './pc'
import { createScreenWindow } from './windows'
import { listDevices, getScreenPassword, setScreenPassword, isUnlocked } from './vault'
import { agentEndpoint, agentStatus } from './agent'
import { ensureScreenUnlocked, type ScreenAccess } from './session'
import type { ScreenPreflight } from './types'
import { beginAccess, isAccessCurrent } from './access-epoch'

// Linux: тип графической сессии (wayland/x11/headless), GPU, наличие NVENC/VAAPI, установлен ли агент.
export const LINUX_PREFLIGHT = [
  `U=$(id -u)`,
  `echo @@SESSION; { [ -e "/run/user/$U/wayland-0" ] && echo wayland; } || { [ -e /tmp/.X11-unix/X0 ] && echo x11; } || echo headless`,
  `echo @@GPU; nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1; lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^[0-9a-f:.]* //' | head -1`,
  `echo @@NVENC; command -v nvidia-smi >/dev/null 2>&1 && echo yes || echo no`,
  `echo @@VAAPI; { ls /dev/dri/renderD128 >/dev/null 2>&1 && echo yes; } || echo no`,
  `echo @@AGENT; { [ -x "$HOME/.argus/argus-agent" ] && echo yes; } || echo no`,
  `echo @@END`
].join('; ')

export const WIN_PREFLIGHT_PS =
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';` +
  `$gpu=(Get-CimInstance Win32_VideoController|Select-Object -First 1).Name;` +
  `$nv=[bool](Get-Command nvidia-smi.exe -EA 0);` +
  `$agent=Test-Path "$env:LOCALAPPDATA\\Argus\\argus-agent.exe";` +
  `[ordered]@{os='windows';sessionType='windows';gpu=$gpu;nvenc=$nv;agentInstalled=$agent}|ConvertTo-Json -Compress`
const winPreflightCmd = (): string =>
  `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WIN_PREFLIGHT_PS, 'utf16le').toString('base64')}`

function sec(out: string, name: string): string[] {
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l.trim() === `@@${name}`)
  if (start < 0) return []
  const rest: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) break
    if (lines[i].trim()) rest.push(lines[i].trim())
  }
  return rest
}

function parseLinux(out: string): ScreenPreflight {
  const session = sec(out, 'SESSION')[0] as ScreenPreflight['sessionType'] | undefined
  const gpuLines = sec(out, 'GPU')
  const nvenc = sec(out, 'NVENC')[0] === 'yes'
  const vaapi = sec(out, 'VAAPI')[0] === 'yes'
  const agentInstalled = sec(out, 'AGENT')[0] === 'yes'
  const backend = nvenc ? 'nvenc' : vaapi ? 'vaapi' : 'software'
  const warnings: string[] = []
  if (session === 'wayland' && nvenc)
    warnings.push('KDE Wayland + NVIDIA: у встроенного KRdp известны проблемы с HW-энкодером — целимся в свой агент (KWin-screencast/portal), не в KRdp.')
  // Сообщение должно говорить, ЧТО делать. У сервера без рабочего стола показывать нечего
  // в принципе — и об этом лучше сказать прямо, чем оставлять человека гадать.
  if (session === 'headless')
    warnings.push(
      'Графической сессии нет — показывать нечего. На сервере без рабочего стола это нормально: ' +
        'для работы с ним есть вкладки «Терминал» и «Файлы». Если рабочий стол есть — нужно войти в систему на самой машине.'
    )
  // Про кодировщик молчим, если показывать всё равно нечего: на headless-сервере это шум,
  // который отвлекает от единственной настоящей причины.
  if (backend === 'software' && session !== 'headless')
    warnings.push('Аппаратного энкодера нет — будет софт-x264 (выше нагрузка CPU, целимся 1080p@15-30).')
  return {
    ok: session !== 'headless',
    os: 'linux',
    sessionType: session ?? 'headless',
    gpu: gpuLines.find((g) => /nvidia|geforce|rtx|radeon|amd|intel|arc/i.test(g)) || gpuLines[0],
    nvenc,
    vaapi,
    agentInstalled,
    backend,
    warnings
  }
}

function parseWin(out: string): ScreenPreflight {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'))
  const warnings: string[] = []
  if (!line) return { ok: false, os: 'windows', warnings: ['не удалось прочитать данные'], error: 'parse' }
  try {
    const o = JSON.parse(line) as { gpu?: string; nvenc?: boolean; agentInstalled?: boolean }
    const nvenc = !!o.nvenc
    if (!nvenc) warnings.push('NVENC не обнаружен — будет софт-энкод (или QSV/AMF, определим агентом).')
    return {
      ok: true,
      os: 'windows',
      sessionType: 'windows',
      gpu: o.gpu,
      nvenc,
      agentInstalled: !!o.agentInstalled,
      backend: nvenc ? 'nvenc' : 'software',
      warnings
    }
  } catch {
    return { ok: false, os: 'windows', warnings: [], error: 'parse' }
  }
}

/** Пред-полётная проба готовности ПК к скринерингу (по живой ОС). */
export async function screenPreflight(deviceId: string): Promise<ScreenPreflight> {
  const os = await whichOs(deviceId)
  if (os.family === 'off') return { ok: false, os: 'off', warnings: [], error: 'ПК не в сети' }
  const r = await execOnce(deviceId, os.family === 'windows' ? winPreflightCmd() : LINUX_PREFLIGHT)
  if (!r.ok) return { ok: false, os: os.family === 'windows' ? 'windows' : 'linux', warnings: [], error: r.error }
  return os.family === 'windows' ? parseWin(r.output) : parseLinux(r.output)
}

// ── Встроенный просмотр+управление (Windows-путь: RDP → guacd → guacamole-lite → canvas в Argus) ──
// guacd крутится в Docker на ноуте (loopback:4822); guacamole-lite — WS-мост на loopback; renderer
// рисует canvas guacamole-common-js. RDP-креды летят в ШИФРОВАННОМ токене (AES-256-CBC), не в URL открыто.
const GUACD = { host: '127.0.0.1', port: 4822 }
const CRYPT_KEY = crypto.randomBytes(16).toString('hex') // 32 ASCII-символа = 32 байта для aes-256

function encryptToken(obj: unknown): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(CRYPT_KEY), iv)
  const value = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]).toString('base64')
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value })).toString('base64')
}

// Включение RDP на Windows (idempotent, tailnet-only firewall). Нужны права admin (Windows-фолбэк-путь).
const WIN_RDP_ENABLE_PS =
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';` +
  `Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0;` +
  `Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name UserAuthentication -Value 1;` +
  `if(-not(Get-NetFirewallRule -DisplayName 'Argus RDP tailnet' -EA 0)){New-NetFirewallRule -DisplayName 'Argus RDP tailnet' -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress 100.64.0.0/10 -Action Allow|Out-Null};'ok'`
const winRdpEnableCmd = (): string =>
  `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WIN_RDP_ENABLE_PS, 'utf16le').toString('base64')}`

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Устройства, на которых RDP уже включали в этом запуске приложения (операция идемпотентная). */
const rdpReady = new Set<string>()

/** Не кэшировать попытку: только exit=0 доказывает, что повторный enable можно пропустить. */
export function rememberRdpEnableResult(
  ready: Set<string>,
  deviceId: string,
  result: { ok: boolean }
): boolean {
  if (!result.ok) return false
  ready.add(deviceId)
  return true
}

/** TCP-жив ли порт (для проверки guacd). */
function tcpAlive(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean): void => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(ms)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

/** guacd крутится в Docker-контейнере `argus-guacd` на ноуте; поднимаем, если приспал. */
async function ensureGuacd(): Promise<boolean> {
  if (await tcpAlive(GUACD.host, GUACD.port)) return true
  await new Promise<void>((r) => execFile('docker', ['start', 'argus-guacd'], () => r())) // best-effort
  for (let i = 0; i < 6; i++) {
    if (await tcpAlive(GUACD.host, GUACD.port)) return true
    await delay(500)
  }
  return false
}

// Один guacamole-lite WS-сервер на loopback (ленивый старт), общий для всех подключений.
let guacServer: GuacamoleLite | null = null
let guacHttpServer: http.Server | null = null
let guacPort = 0
async function ensureGuacServer(): Promise<number> {
  if (guacServer && guacPort) return guacPort
  const httpServer = http.createServer()
  await new Promise<void>((res, rej) => {
    httpServer.once('error', rej)
    httpServer.listen(0, '127.0.0.1', () => res())
  })
  guacPort = (httpServer.address() as AddressInfo).port
  guacHttpServer = httpServer
  guacServer = new GuacamoleLite(
    { server: httpServer },
    GUACD,
    { crypt: { cipher: 'aes-256-cbc', key: CRYPT_KEY }, log: { level: 'ERRORS' } }
  )
  return guacPort
}

export interface ScreenStartResult {
  ok: boolean
  wsPort?: number
  token?: string
  error?: string
}

export type AgentScreenDecision =
  | { action: 'open' }
  | { action: 'fallback'; reason: string }
  | { action: 'reject'; error: string }

/**
 * Физический экран открываем только после доказанного состояния. macOS — отдельная ветка:
 * logind там нет, а захват/разрешение проверяет сам агент в Aqua-сеансе.
 */
export function decideAgentScreenAccess(agentOs: string | undefined, access: ScreenAccess): AgentScreenDecision {
  if (agentOs === 'darwin') return { action: 'open' }
  switch (access.state) {
    case 'already':
    case 'unlocked':
      return { action: 'open' }
    case 'locked-no-unlock':
      return { action: 'fallback', reason: access.reason }
    case 'no-session':
      return {
        action: 'reject',
        error: 'В систему никто не вошёл — показывать нечего. Экран приветствия удалённо не транслируется; включи автовход на машине.'
      }
    case 'refused':
      return {
        action: 'reject',
        error: `Экран остаётся заперт${access.detail ? `: ${access.detail}` : ''}. Агент не открываю, чтобы не показывать застывшую картинку.`
      }
    case 'unsupported':
      return { action: 'reject', error: `Не удалось подтвердить состояние физического экрана: ${access.reason}` }
  }
}

/** Запустить встроенный RDP-сеанс (Windows): включить RDP по SSH, поднять мост, вернуть WS-порт+токен. */
export async function screenStart(
  deviceId: string,
  opts: { password: string; width?: number; height?: number }
): Promise<ScreenStartResult> {
  const os = await whichOs(deviceId)
  if (os.family === 'off') return { ok: false, error: 'ПК не в сети' }
  if (os.family !== 'windows')
    return { ok: false, error: 'Пока встроен Windows-путь (RDP). Linux/единый агент — следующий инкремент.' }
  if (!opts.password) return { ok: false, error: 'Нужен пароль Windows-аккаунта' }

  // Три независимые операции — параллельно, а не цепочкой. Последовательно они давали ~22с на
  // открытие экрана: включение RDP это отдельное SSH-подключение с запуском PowerShell,
  // resolveConn — ещё одна проба живости, ensureGuacd — локальный докер.
  // Само включение RDP делаем ОДИН раз за запуск приложения: операция идемпотентная, и повторять
  // её при каждом открытии — это лишние ~8с на ровном месте.
  const [rdp, conn, guacd] = await Promise.all([
    rdpReady.has(deviceId)
      ? Promise.resolve<{ ok: boolean; output: string; error?: string }>({ ok: true, output: '' })
      : execOnce(deviceId, winRdpEnableCmd())
          .then((result) => {
            rememberRdpEnableResult(rdpReady, deviceId, result)
            return result
          })
          .catch((e: unknown) => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) })),
    resolveConn(deviceId), // живой Windows-эндпоинт (host = Tailscale 100.x)
    ensureGuacd()
  ])
  if (!rdp.ok) return { ok: false, error: `не удалось включить RDP: ${rdp.error || rdp.output || 'причина неизвестна'}` }
  if (!conn) return { ok: false, error: 'не удалось определить адрес ПК' }
  if (!guacd) return { ok: false, error: 'guacd не запущен (Docker). Запусти: docker start argus-guacd' }
  const wsPort = await ensureGuacServer()
  const token = encryptToken({
    connection: {
      type: 'rdp',
      settings: {
        hostname: conn.host,
        port: '3389',
        username: conn.user,
        password: opts.password,
        // Безопасность: форсим NLA (включён на Windows) — без даунгрейда на слабый RDP-security;
        // TOFU-пиннинг серверного сертификата (как SSH host-key), а НЕ слепой ignore-cert. Транспорт
        // и так в Tailscale (WireGuard) + firewall только tailnet, но прикладной слой тоже не ослабляем.
        security: 'nla',
        'cert-tofu': 'true',
        'resize-method': 'display-update',
        width: String(opts.width || 1280),
        height: String(opts.height || 720),
        dpi: '96',
        'enable-wallpaper': 'false',
        'enable-theming': 'true',
        'enable-font-smoothing': 'true'
      }
    }
  })
  return { ok: true, wsPort, token }
}

// ── Сеансы в отдельных окнах ───────────────────────────────────────────────────────────────────
// Окно экрана — самостоятельный renderer, у которого НЕТ доступа к vault и который НИКОГДА не
// видит пароль: main запускает сеанс сам и отдаёт окну только адрес моста и шифрованный токен.
// Токен переиспользуемый (guacamole-lite не хранит состояния) — на этом держится автореконнект.
interface LiveSession {
  deviceId: string
  /** agent — свой агент (пароль ОС не нужен); rdp — запасной путь через guacd. */
  mode: 'agent' | 'rdp'
  wsPort: number
  token: string
  /** Полный ws://-адрес агента (только для mode=agent). */
  url?: string
  winId: number
}
const sessions = new Map<string, LiveSession>()

const deviceName = (deviceId: string): string =>
  listDevices().find((d) => d.id === deviceId)?.name ?? 'ПК'

/** Запустить сеанс и открыть под него отдельное окно. Пароль дальше main не уходит. */
export async function screenOpen(
  deviceId: string,
  opts: { password: string; remember?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const accessTicket = beginAccess()
  if (!isUnlocked()) return { ok: false, error: 'Argus заблокирован' }
  // Второе окно на то же устройство открывать НЕЛЬЗЯ: Windows-клиент держит один сеанс, и
  // новое подключение выбивает предыдущее — оба окна начинают драться, картинка чернеет.
  // (Поймано на живом тесте: два открытых окна дали чёрный экран при статусе «подключено».)
  const existing = [...sessions.entries()].find(([, s]) => s.deviceId === deviceId)
  if (existing) {
    const w = BrowserWindow.fromId(existing[1].winId)
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore()
      w.focus()
      return { ok: true }
    }
    sessions.delete(existing[0])
  }

  const area = electronScreen.getPrimaryDisplay().workAreaSize
  const openWindow = (sess: Omit<LiveSession, 'winId'>): { ok: boolean; error?: string } => {
    if (!isAccessCurrent(accessTicket) || !isUnlocked()) return { ok: false, error: 'Argus заблокирован' }
    const h = crypto.randomUUID()
    const w = createScreenWindow(h, `Экран — ${deviceName(deviceId)}`, {
      width: Math.min(1600, Math.round(area.width * 0.8)),
      height: Math.min(1000, Math.round(area.height * 0.8))
    })
    sessions.set(h, { ...sess, winId: w.id })
    w.on('closed', () => sessions.delete(h))
    return { ok: true }
  }

  // Свой агент — предпочтительный путь: он не требует пароля учётной записи ОС вообще
  // (доверие получено по SSH при установке) и работает не только на Windows.
  const ag = await agentEndpoint(deviceId)
  if (ag.ok && ag.url && ag.token) {
    const st = await agentStatus(deviceId)
    if (st.running) {
      // Замок снимаем ДО открытия окна. Именно из-за него удалённый экран считался
      // неработающим: сеанс поднимался автовходом, но экран был заперт хранителем, и
      // транслировать было нечего. Отдельного вопроса пользователю нет — нажатие «Экран»
      // и есть решение хозяина машины (на самой машине агент показывает уведомление).
      const access: ScreenAccess =
        st.os === 'darwin'
          ? { state: 'unsupported', reason: 'macOS не использует logind' }
          : await ensureScreenUnlocked(deviceId)
      const decision = decideAgentScreenAccess(st.os, access)
      if (decision.action === 'reject') return { ok: false, error: decision.error }
      if (decision.action === 'open') {
        return openWindow({ deviceId, mode: 'agent', url: ag.url, token: ag.token, wsPort: 0 })
      }
      // Заперто или Windows probe не дал однозначного ответа: агент не должен fail-open.
      // RDP безопасен здесь тем, что открывает отдельный сеанс и не читает защищённый desktop.
      console.warn(`[screen] ${decision.reason} — иду запасным путём`)
    }
  }

  // Запасной путь — RDP через guacd. Он и только он требует пароль Windows.
  // Пустой ввод = берём сохранённый в хранилище (SQLCipher под мастер-паролем).
  const password = opts.password || getScreenPassword(deviceId) || ''
  if (!password)
    return {
      ok: false,
      // Формулировка важна: RDP — не «то же самое, но с паролем». Он заводит СВОЙ сеанс,
      // а не показывает то, что на мониторе, — и об этом лучше сказать до подключения,
      // чем оставить человека гадать, почему на экране не его рабочий стол.
      error:
        'Нужен пароль учётной записи Windows: запасной путь идёт через RDP, а он открывает ' +
        'отдельный сеанс, а не показывает то, что сейчас на мониторе.'
    }

  // Стартовое разрешение — по рабочей области монитора; точный размер окно допросит через
  // sendSize сразу после коннекта (resize-method=display-update), так что картинка будет 1:1.
  const r = await screenStart(deviceId, { password, width: area.width, height: area.height })
  if (!r.ok || !r.wsPort || !r.token) return { ok: false, error: r.error ?? 'не удалось запустить сеанс' }
  // Сохраняем только явно введённый пароль и только по галочке. Верность пароля тут ещё не
  // известна (RDP проверит его позже) — поэтому в интерфейсе есть «забыть» одним кликом.
  if (opts.remember && opts.password) setScreenPassword(deviceId, opts.password)

  return openWindow({ deviceId, mode: 'rdp', wsPort: r.wsPort, token: r.token })
}

/** Окно забирает параметры своего сеанса. Повторно — можно (реконнект), из чужого окна — нельзя. */
export function screenClaim(
  handle: string,
  senderWinId: number | null
): { ok: boolean; mode?: 'agent' | 'rdp'; wsPort?: number; token?: string; url?: string; error?: string } {
  const s = sessions.get(handle)
  if (!s) return { ok: false, error: 'сеанс не найден или уже закрыт' }
  if (s.winId !== senderWinId) return { ok: false, error: 'сеанс принадлежит другому окну' }
  return { ok: true, mode: s.mode, wsPort: s.wsPort, token: s.token, url: s.url }
}

/** Закрыть трансляции ОДНОГО устройства (его удалили — сеанс не должен пережить запись). */
export function closeDeviceScreens(deviceId: string): number {
  const mine = [...sessions.entries()].filter(([, s]) => s.deviceId === deviceId)
  for (const [handle, s] of mine) {
    const w = BrowserWindow.fromId(s.winId)
    if (w && !w.isDestroyed()) w.close()
    sessions.delete(handle)
  }
  // Мост guacd намеренно не трогаем: он общий, и его закрытие оборвало бы чужие сеансы.
  // Без записи в `sessions` окно всё равно ничего не получит по `screen:claim`.
  return mine.length
}

/** Закрыть все удалённые экраны и loopback-мост. Вызывается при lock и завершении приложения. */
export function closeAllScreens(): void {
  for (const s of sessions.values()) {
    const w = BrowserWindow.fromId(s.winId)
    if (w && !w.isDestroyed()) w.close()
  }
  sessions.clear()
  try {
    guacServer?.close?.()
  } catch {
    /* мост уже закрыт */
  }
  try {
    guacHttpServer?.closeAllConnections()
    guacHttpServer?.close()
  } catch {
    /* HTTP-сервер уже закрыт */
  }
  guacServer = null
  guacHttpServer = null
  guacPort = 0
  rdpReady.clear()
}
