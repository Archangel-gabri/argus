// Скринеринг (Этап 4) — фундамент. Пока: пред-полётная проба готовности ПК по SSH (ОС/сессия,
// аппаратный энкодер, тип захвата, установлен ли агент) → вкладка «Экран» показывает, заведётся ли
// стрим и на каком бэкенде. Сам стрим-агент (захват+энкод+WebRTC+ввод) — следующий инкремент.
// Архитектура (из docs/overhaul-2026-07-23/screen-research.md + синтеза Fable/Claude): свой единый
// тонкий агент (GStreamer webrtcsink / Pion), авто-provision по SSH, WebRTC в изолированном
// WebContentsView, ввод Win SendInput / Linux libei→uinput, энкод-каскад NVENC→VAAPI→софт.
import { execOnce } from './ssh'
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
