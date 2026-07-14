// Dual-boot ПК: одна железка, две ОС. Определяем текущую ОС (какой эндпоинт отвечает),
// переключаем загрузку и шлём питание на живую ОС. Команды OS-aware (Linux systemctl/grub,
// Windows shutdown). Работает на живой ОС; вторая эндпоинт — из vault.getAltConn.
import { getDeviceConn, getAltConn, getDeviceOsPair, type DeviceConn } from './vault'
import { execOnConn } from './ssh'

export type OsTag = 'linux' | 'windows' | 'off'

interface Endpoint {
  os: OsTag
  conn: DeviceConn
}

const tagOs = (osStr: string | undefined): OsTag => (/win/i.test(osStr ?? '') ? 'windows' : 'linux')

/** Жив ли эндпоинт: echo работает в обоих шеллах (bash и Windows PowerShell). */
async function isAlive(conn: DeviceConn): Promise<boolean> {
  const r = await execOnConn(conn, 'echo argus-ok', 8000)
  return r.ok && r.output.includes('argus-ok')
}

/** Живой эндпоинт ПК + какая это ОС (тег из конфига: primary=device.os, alt=device.alt.os). */
async function liveEndpoint(deviceId: string): Promise<Endpoint | null> {
  const primary = getDeviceConn(deviceId)
  const alt = getAltConn(deviceId)
  const { os, altOs } = getDeviceOsPair(deviceId)
  const probes: Array<Promise<Endpoint | null>> = []
  if (primary) probes.push(isAlive(primary).then((ok) => (ok ? { os: tagOs(os), conn: primary } : null)))
  if (alt) probes.push(isAlive(alt).then((ok) => (ok ? { os: tagOs(altOs), conn: alt } : null)))
  const results = await Promise.all(probes)
  return results.find((r): r is Endpoint => r !== null) ?? null
}

/** Текущая ОС ПК (linux/windows/off). */
export async function whichOs(deviceId: string): Promise<{ current: OsTag }> {
  const ep = await liveEndpoint(deviceId)
  return { current: ep?.os ?? 'off' }
}

const CMD = {
  linux: {
    reboot: 'sudo -n systemctl reboot 2>/dev/null || systemctl reboot',
    poweroff: 'sudo -n systemctl poweroff 2>/dev/null || systemctl poweroff',
    suspend: 'sudo -n systemctl suspend 2>/dev/null || systemctl suspend',
    // В Windows: grub сам находит menuentry с Windows.
    toWindows:
      'e=$(awk -F"\'" \'/menuentry / && /[Ww]indows/{print $2; exit}\' /boot/grub/grub.cfg 2>/dev/null); ' +
      'if [ -n "$e" ]; then sudo -n grub-reboot "$e" && sudo -n systemctl reboot; else echo "no windows entry in grub"; fi'
  },
  windows: {
    // Шелл Windows OpenSSH = PowerShell → внешние .exe с явным именем.
    reboot: 'shutdown.exe /r /t 0',
    poweroff: 'shutdown.exe /s /t 0',
    suspend: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
    // GRUB — основной загрузчик, дефолт Linux → простой reboot вернёт в Linux.
    toLinux: 'shutdown.exe /r /t 0'
  }
} as const

/** Питание на живой ОС (reboot/poweroff/suspend). */
export async function power(
  deviceId: string,
  action: 'reboot' | 'poweroff' | 'suspend'
): Promise<{ ok: boolean; os: OsTag; output?: string; error?: string }> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: 'off', error: 'ПК не в сети (ни Linux, ни Windows не отвечают)' }
  const cmd = CMD[ep.os === 'windows' ? 'windows' : 'linux'][action]
  const r = await execOnConn(ep.conn, cmd, 10000)
  return { ok: r.ok || /closed|disconnect|ECONNRESET/i.test(r.error ?? ''), os: ep.os, output: r.output, error: r.error }
}

/** Переключить загрузку в target-ОС с той, что сейчас запущена. */
export async function boot(
  deviceId: string,
  target: 'linux' | 'windows'
): Promise<{ ok: boolean; os: OsTag; output?: string; error?: string }> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: 'off', error: 'ПК не в сети — сначала разбуди (WoL)' }
  if (ep.os === target) return { ok: true, os: ep.os, output: `Уже в ${target}` }
  let cmd: string
  if (target === 'windows' && ep.os === 'linux') cmd = CMD.linux.toWindows
  else if (target === 'linux' && ep.os === 'windows') cmd = CMD.windows.toLinux
  else return { ok: false, os: ep.os, error: 'нет команды перехода для этой пары ОС' }
  const r = await execOnConn(ep.conn, cmd, 10000)
  return { ok: r.ok || /closed|disconnect|ECONNRESET/i.test(r.error ?? ''), os: ep.os, output: r.output, error: r.error }
}
