// Multi-boot ПК: одна железка, N ОС (основной эндпоинт + altOs). Определяем живую ОС,
// переключаем загрузку, шлём питание/метрики на живой ОС. Команды OS-aware по семейству
// (Linux systemctl/grub, Windows PowerShell/shutdown.exe).
import dgram from 'node:dgram'
import { getOsEndpoints, getDeviceMac, type DeviceConn, type OsEndpoint } from './vault'
import { execOnConn, parseLinuxProbe, LINUX_PROBE_CMD } from './ssh'
import type { PowerResult, PowerDiag } from './types'

export type OsFamily = 'linux' | 'windows' | 'off'

const family = (osLabel: string): 'linux' | 'windows' => (/win/i.test(osLabel) ? 'windows' : 'linux')

/** POSIX single-quote экранирование: любую строку безопасно вставить в shell без инъекции. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Жив ли эндпоинт: echo работает в обоих шеллах (bash и Windows PowerShell). */
async function isAlive(conn: DeviceConn): Promise<boolean> {
  const r = await execOnConn(conn, 'echo argus-ok', 8000)
  return r.ok && r.output.includes('argus-ok')
}

interface LiveEp extends OsEndpoint {
  family: 'linux' | 'windows'
}

/** Первый отвечающий ОС-эндпоинт (= какая ОС сейчас запущена). */
async function liveEndpoint(deviceId: string): Promise<LiveEp | null> {
  const eps = getOsEndpoints(deviceId)
  const checked = await Promise.all(
    eps.map(async (ep) => ((await isAlive(ep.conn)) ? { ...ep, family: family(ep.os) } : null))
  )
  return checked.find((r): r is LiveEp => r !== null) ?? null
}

/** Текущая запущенная ОС: метка + семейство (или off). */
export async function whichOs(deviceId: string): Promise<{ current: string; family: OsFamily }> {
  const ep = await liveEndpoint(deviceId)
  return ep ? { current: ep.os || (ep.family === 'windows' ? 'Windows' : 'Linux'), family: ep.family } : { current: '', family: 'off' }
}

export interface PcMetrics {
  current: string
  family: OsFamily
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  disk?: number
  uptime?: number
}

const WIN_METRICS =
  '$c=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average; ' +
  '$o=Get-CimInstance Win32_OperatingSystem; ' +
  '$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"; ' +
  '$up=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds; ' +
  'Write-Output "$c"; Write-Output "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"; ' +
  'Write-Output "$([int](($d.Size-$d.FreeSpace)/$d.Size*100))"; Write-Output "$up"'

function parseWinMetrics(out: string): { cpu?: number; ramUsed?: number; ramTotal?: number; disk?: number; uptime?: number } {
  const l = out.trim().split('\n').map((s) => s.trim())
  const cpu = parseFloat(l[0])
  const [totalKb, freeKb] = (l[1] || '').split(/\s+/).map((n) => parseFloat(n) || 0)
  const disk = parseFloat(l[2])
  const uptime = parseInt(l[3], 10)
  const toGb = (kb: number): number => Math.round((kb / 1024 / 1024) * 10) / 10
  return {
    cpu: Number.isFinite(cpu) ? Math.round(cpu) : undefined,
    ramTotal: totalKb ? toGb(totalKb) : undefined,
    ramUsed: totalKb ? toGb(totalKb - freeKb) : undefined,
    disk: Number.isFinite(disk) ? disk : undefined,
    uptime: Number.isFinite(uptime) ? uptime : undefined
  }
}

/** Метрики живой ОС (OS-aware). */
export async function metrics(deviceId: string): Promise<PcMetrics> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { current: '', family: 'off' }
  const label = ep.os || (ep.family === 'windows' ? 'Windows' : 'Linux')
  if (ep.family === 'windows') {
    const r = await execOnConn(ep.conn, WIN_METRICS, 12000)
    return { current: label, family: 'windows', ...(r.ok ? parseWinMetrics(r.output) : {}) }
  }
  const r = await execOnConn(ep.conn, LINUX_PROBE_CMD, 12000)
  if (!r.ok) return { current: label, family: 'linux' }
  const m = parseLinuxProbe(r.output)
  return { current: label, family: 'linux', cpu: m.cpu, ramUsed: m.ramUsed, ramTotal: m.ramTotal, disk: m.disk, uptime: m.uptime }
}

/** Wake-on-LAN: magic packet (6×0xFF + 16×MAC) в широковещалку. «Включить» из выключенного.
 *  Работает, если приложение в той же L2-сети, что и целевой ПК (или роутер форвардит WoL). */
export async function wake(deviceId: string): Promise<{ ok: boolean; error?: string }> {
  const mac = getDeviceMac(deviceId)
  if (!mac) return { ok: false, error: 'MAC не задан (укажи в карточке для WoL)' }
  const hex = mac.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 12) return { ok: false, error: 'Некорректный MAC' }
  const macBuf = Buffer.from(hex, 'hex')
  const packet = Buffer.alloc(102)
  packet.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6)
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', (e) => {
      try {
        sock.close()
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: e.message })
    })
    sock.bind(() => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* ignore */
      }
      // Шлём в общий broadcast и порт 9 (стандарт WoL); дублируем на 7.
      let pending = 2
      const doneOne = (): void => {
        if (--pending === 0) {
          try {
            sock.close()
          } catch {
            /* ignore */
          }
          resolve({ ok: true })
        }
      }
      sock.send(packet, 0, packet.length, 9, '255.255.255.255', doneOne)
      sock.send(packet, 0, packet.length, 7, '255.255.255.255', doneOne)
    })
  })
}

// Windows suspend — через -EncodedCommand (base64 UTF-16LE), НЕ inline -Command: если Windows
// OpenSSH DefaultShell = PowerShell (как на Castiel — проверено вживую 2026-07-23), то внешний
// PowerShell раскрывает `$false` внутри "-Command "…$false…"" в строку 'False' и команда падает.
// EncodedCommand устойчив к любому DefaultShell (нет кавычек/$ для внешнего шелла). Проверено
// end-to-end: Castiel реально уснул и проснулся по WoL.
const WIN_SUSPEND_PS =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
const WIN_SUSPEND_CMD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
  WIN_SUSPEND_PS,
  'utf16le'
).toString('base64')}`

// `-i` = ignore-inhibitors: без него logind/polkit отклоняют выключение при активной
// графической сессии (Steam-стрим, KDE Connect, запись экрана и т.п.). Финальное плечо —
// прямой sudo poweroff/reboot на случай отсутствия systemctl. Windows: /f = force (не давать
// приложениям заблокировать); shutdown.exe без $-переменных — устойчив под PowerShell-DefaultShell.
const CMD = {
  linux: {
    reboot: 'sudo -n systemctl reboot -i 2>/dev/null || systemctl reboot -i 2>/dev/null || sudo -n reboot',
    poweroff: 'sudo -n systemctl poweroff -i 2>/dev/null || systemctl poweroff -i 2>/dev/null || sudo -n poweroff',
    suspend: 'sudo -n systemctl suspend -i 2>/dev/null || systemctl suspend -i'
  },
  windows: {
    reboot: 'shutdown.exe /r /t 0 /f',
    poweroff: 'shutdown.exe /s /t 0 /f',
    suspend: WIN_SUSPEND_CMD
  }
} as const

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Разрыв SSH-канала — ожидаемый исход poweroff/reboot: команда ушла, но exit-код прийти не успел.
// Не считать это провалом (иначе кнопка врёт «✖», хотя машина гасится).
const isDropped = (err: string | undefined): boolean =>
  /closed|disconnect|ECONNRESET|timed?\s?out|exit \?|signal /i.test(err ?? '')

/** Питание на живой ОС. Двухфазно: отправляем команду, затем для poweroff/suspend проверяем,
 *  что машина реально погасла (иначе честно сообщаем «всё ещё отвечает» + причину из stderr). */
export async function power(
  deviceId: string,
  action: 'reboot' | 'poweroff' | 'suspend'
): Promise<PowerResult> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: '', phase: 'no-endpoint', error: 'ПК не в сети (ни одна ОС не отвечает)' }
  const cmd = CMD[ep.family][action]
  const r = await execOnConn(ep.conn, cmd, 10000)
  const dropped = isDropped(r.error)

  // Явный отказ хоста (не разрыв): показать РЕАЛЬНУЮ причину (inhibitor/polkit/нет прав).
  if (!r.ok && !dropped) {
    return {
      ok: false,
      os: ep.os,
      phase: 'rejected',
      output: r.output,
      error: (r.output?.trim() || r.error || 'команда отклонена хостом').slice(0, 400)
    }
  }

  // reboot: verify занял бы минуты — сообщаем «принято».
  if (action === 'reboot') {
    return { ok: true, os: ep.os, phase: 'accepted', output: 'команда отправлена — ПК перезагружается' }
  }

  // poweroff/suspend: ждём и проверяем, что эндпоинт действительно умер.
  await delay(7000)
  const stillAlive = await isAlive(ep.conn)
  if (stillAlive) {
    return {
      ok: false,
      os: ep.os,
      phase: 'still-up',
      error:
        (r.output?.trim() ||
          'команда отправлена, но ПК всё ещё отвечает — вероятно, блокирует активная сессия/инхибитор (см. «Диагностика»)').slice(0, 400)
    }
  }
  return {
    ok: true,
    os: ep.os,
    phase: 'verified',
    output: action === 'poweroff' ? '✓ ПК выключился' : '✓ ПК уснул'
  }
}

// Пред-полётная диагностика: кто мы, есть ли passwordless-sudo, что блокирует выключение.
const DIAG_LINUX =
  'echo "USER=$(whoami) UID=$(id -u)"; ' +
  'sudo -n true 2>/dev/null && echo "SUDO_N=ok" || echo "SUDO_N=нет (нужен пароль)"; ' +
  'echo "--- инхибиторы (что блокирует выключение) ---"; ' +
  'systemd-inhibit --list 2>/dev/null | grep -iE "shutdown|sleep|Who|What|Mode" | head -12 || echo "(нет / systemd-inhibit недоступен)"'
const DIAG_WIN =
  'powershell.exe -NoProfile -NonInteractive -Command "whoami; ' +
  '(whoami /priv | Select-String SeShutdown); ' +
  'Write-Output ((Get-CimInstance Win32_ComputerSystem).UserName)"'

/** Диагностика питания живой ОС — «почему не выключается». */
export async function powerDiag(deviceId: string): Promise<PowerDiag> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: '', text: 'ПК не в сети (ни одна ОС не отвечает)' }
  const r = await execOnConn(ep.conn, ep.family === 'windows' ? DIAG_WIN : DIAG_LINUX, 12000)
  return { ok: r.ok, os: ep.os, text: (r.output || r.error || 'нет вывода').slice(0, 1500) }
}

/** Загрузить target-ОС (по метке) с той, что сейчас запущена. Linux → grub-reboot к записи
 *  (bootEntry или матч по ключевому слову из имени ОС); Windows → reboot (grub-дефолт = Linux). */
export async function boot(
  deviceId: string,
  targetOs: string
): Promise<{ ok: boolean; os: string; output?: string; error?: string }> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: '', error: 'ПК не в сети — сначала разбуди (WoL)' }
  if ((ep.os || '') === targetOs) return { ok: true, os: ep.os, output: `Уже в ${targetOs}` }

  const target = getOsEndpoints(deviceId).find((e) => e.os === targetOs)
  const targetFamily = family(targetOs)
  let cmd: string
  if (ep.family === 'linux') {
    if (target?.bootEntry) {
      // bootEntry — строка из устройства: валидируем (без переносов/абсурдной длины) и
      // экранируем одинарными кавычками, чтобы исключить command injection.
      if (!/^[^\n\r]{1,200}$/.test(target.bootEntry)) {
        return { ok: false, os: ep.os, error: 'некорректный bootEntry' }
      }
      cmd = `sudo -n grub-reboot ${shq(target.bootEntry)} && sudo -n systemctl reboot`
    } else {
      // kw — только буквы/цифры (инъекция невозможна), но для единообразия тоже экранируем.
      const kw = (targetOs.split(/\s+/)[0] || targetOs).replace(/[^A-Za-z0-9]/g, '')
      cmd =
        `e=$(awk -F"'" -v k=${shq(kw)} 'BEGIN{IGNORECASE=1} /menuentry / && index(tolower($0), tolower(k)){print $2; exit}' /boot/grub/grub.cfg 2>/dev/null); ` +
        `if [ -n "$e" ]; then sudo -n grub-reboot "$e" && sudo -n systemctl reboot; else echo "grub entry not found"; fi`
    }
  } else {
    // Из Windows: в Linux — простой reboot (grub-дефолт = Linux). В другую Windows — н/д.
    if (targetFamily === 'linux') cmd = 'shutdown.exe /r /t 0'
    else return { ok: false, os: ep.os, error: 'из Windows можно только в Linux (reboot)' }
  }
  const r = await execOnConn(ep.conn, cmd, 10000)
  return { ok: r.ok || /closed|disconnect|ECONNRESET/i.test(r.error ?? ''), os: ep.os, output: r.output, error: r.error }
}
