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
import GuacamoleLite from 'guacamole-lite'
import { execOnce, resolveConn } from './ssh'
import { whichOs } from './pc'
import type { ScreenPreflight } from './types'

// Linux: тип графической сессии (wayland/x11/headless), GPU, наличие NVENC/VAAPI, установлен ли агент.
const LINUX_PREFLIGHT = [
  `U=$(id -u)`,
  `echo @@SESSION; { [ -e "/run/user/$U/wayland-0" ] && echo wayland; } || { [ -e /tmp/.X11-unix/X0 ] && echo x11; } || echo headless`,
  `echo @@GPU; nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1; lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^[0-9a-f:.]* //' | head -1`,
  `echo @@NVENC; command -v nvidia-smi >/dev/null 2>&1 && echo yes || echo no`,
  `echo @@VAAPI; { ls /dev/dri/renderD128 >/dev/null 2>&1 && echo yes; } || echo no`,
  `echo @@AGENT; { [ -x "$HOME/.argus/argus-screen-agent" ] && echo yes; } || echo no`,
  `echo @@END`
].join('; ')

const WIN_PREFLIGHT_PS =
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';` +
  `$gpu=(Get-CimInstance Win32_VideoController|Select-Object -First 1).Name;` +
  `$nv=[bool](Get-Command nvidia-smi.exe -EA 0);` +
  `$agent=Test-Path "$env:LOCALAPPDATA\\Argus\\argus-screen-agent.exe";` +
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
  if (session === 'headless') warnings.push('Графическая сессия не найдена — захватывать нечего (нужен вход в систему).')
  if (backend === 'software') warnings.push('Аппаратного энкодера нет — будет софт-x264 (выше нагрузка CPU, целимся 1080p@15-30).')
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
let guacPort = 0
async function ensureGuacServer(): Promise<number> {
  if (guacServer && guacPort) return guacPort
  const httpServer = http.createServer()
  await new Promise<void>((res, rej) => {
    httpServer.once('error', rej)
    httpServer.listen(0, '127.0.0.1', () => res())
  })
  guacPort = (httpServer.address() as AddressInfo).port
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

  // Best-effort включить RDP (на Castiel уже включён; для других admin-ПК — с одного клика).
  await execOnce(deviceId, winRdpEnableCmd()).catch(() => undefined)

  const conn = await resolveConn(deviceId) // живой Windows-эндпоинт (host = Tailscale 100.x)
  if (!conn) return { ok: false, error: 'не удалось определить адрес ПК' }

  if (!(await ensureGuacd()))
    return { ok: false, error: 'guacd не запущен (Docker). Запусти: docker start argus-guacd' }
  const wsPort = await ensureGuacServer()
  const token = encryptToken({
    connection: {
      type: 'rdp',
      settings: {
        hostname: conn.host,
        port: '3389',
        username: conn.user,
        password: opts.password,
        security: 'any',
        'ignore-cert': 'true',
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
