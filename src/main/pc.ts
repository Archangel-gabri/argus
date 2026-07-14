// Multi-boot ПК: одна железка, N ОС (основной эндпоинт + altOs). Определяем живую ОС,
// переключаем загрузку, шлём питание/метрики на живой ОС. Команды OS-aware по семейству
// (Linux systemctl/grub, Windows PowerShell/shutdown.exe).
import { getOsEndpoints, type DeviceConn, type OsEndpoint } from './vault'
import { execOnConn, parseLinuxProbe, LINUX_PROBE_CMD } from './ssh'

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

const CMD = {
  linux: {
    reboot: 'sudo -n systemctl reboot 2>/dev/null || systemctl reboot',
    poweroff: 'sudo -n systemctl poweroff 2>/dev/null || systemctl poweroff',
    suspend: 'sudo -n systemctl suspend 2>/dev/null || systemctl suspend'
  },
  windows: {
    reboot: 'shutdown.exe /r /t 0',
    poweroff: 'shutdown.exe /s /t 0',
    suspend: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
  }
} as const

/** Питание на живой ОС. */
export async function power(
  deviceId: string,
  action: 'reboot' | 'poweroff' | 'suspend'
): Promise<{ ok: boolean; os: string; output?: string; error?: string }> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: '', error: 'ПК не в сети (ни одна ОС не отвечает)' }
  const cmd = CMD[ep.family][action]
  const r = await execOnConn(ep.conn, cmd, 10000)
  return { ok: r.ok || /closed|disconnect|ECONNRESET/i.test(r.error ?? ''), os: ep.os, output: r.output, error: r.error }
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
