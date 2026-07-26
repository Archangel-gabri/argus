// Multi-boot ПК: одна железка, N ОС (основной эндпоинт + altOs). Определяем живую ОС,
// переключаем загрузку, шлём питание/метрики на живой ОС. Команды OS-aware по семейству
// (Linux systemctl/grub, Windows PowerShell/shutdown.exe).
import dgram from 'node:dgram'
import { getOsEndpoints, getDeviceMac, type DeviceConn, type OsEndpoint } from './vault'
import { execOnConn } from './ssh'
import { tcpAlive } from './liveness'
import { LINUX_PROBE_V2, parseProbeV2 } from './metrics'
import type { PowerResult, PowerDiag, LiveMetrics, MountInfo, ProcInfo, GpuInfo } from './types'

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

/** Гонка: отдаём ПЕРВЫЙ ответивший эндпоинт, не дожидаясь таймаута остальных. */
function firstAlive(eps: OsEndpoint[]): Promise<LiveEp | null> {
  return new Promise((resolve) => {
    let pending = eps.length
    if (!pending) return resolve(null)
    for (const ep of eps) {
      void isAlive(ep.conn)
        .then((ok) => {
          if (ok) resolve({ ...ep, family: family(ep.os) })
          else if (--pending === 0) resolve(null)
        })
        .catch(() => {
          if (--pending === 0) resolve(null)
        })
    }
  })
}

/** Первый отвечающий ОС-эндпоинт (= какая ОС сейчас запущена).
 *
 *  Было: Promise.all по ВСЕМ эндпоинтам — значит ждали самый медленный. У двухзагрузочного ПК
 *  выключенная половина съедала весь 8-секундный SSH-таймаут, и опрос ПК стоил 9.4с, упирая в себя
 *  весь параллельный проход по парку. Стало: дешёвый TCP-отсев (~200мс) + гонка за первым живым. */
async function liveEndpoint(deviceId: string): Promise<LiveEp | null> {
  const eps = getOsEndpoints(deviceId)
  if (!eps.length) return null
  if (eps.length === 1) return firstAlive(eps)

  const reach = await Promise.all(eps.map(async (ep) => ({ ep, r: await tcpAlive(ep.conn.host, ep.conn.port, 2500) })))
  const open = reach.filter((x) => x.r.up).map((x) => x.ep)
  // Ровно один эндпоинт отдал SSH-баннер — этого достаточно: одновременно две ОС на одной
  // железке не работают. Второе SSH-подключение ради `echo` стоило бы ещё ~2с на ровном месте.
  if (open.length === 1) return { ...open[0], family: family(open[0].os) }
  // Никто не ответил (фаервол/нестандартный порт) или ответили несколько — проверяем по-честному.
  return firstAlive(open.length ? open : eps)
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
  load1?: number
  netRx?: number
  netTx?: number
  swapUsed?: number
  swapTotal?: number
  tempCpu?: number
  metrics?: LiveMetrics
}

// Богатый Windows-зонд — ровно тот же контракт LiveMetrics, что у LINUX_PROBE_V2, иначе вкладка
// «Метрики» у ПК на Windows оставалась пустой (она рендерит именно LiveMetrics, а старый сборщик
// отдавал только cpu/ram/disk/uptime для карточки). Классы Win32_PerfFormattedData_* отдают уже
// посчитанные значения «в секунду», поэтому второй сэмпл с паузой не нужен — сбор ~1с.
const WIN_METRICS_V2_PS = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$cpuAll = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor)
$total  = ($cpuAll | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1).PercentProcessorTime
$cores  = @($cpuAll | Where-Object { $_.Name -ne '_Total' } | Sort-Object { [int]$_.Name } | ForEach-Object { [int]$_.PercentProcessorTime })
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$pf = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
$net = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' })
$rx = ($net | Measure-Object -Property BytesReceivedPersec -Sum).Sum
$tx = ($net | Measure-Object -Property BytesSentPersec -Sum).Sum
$dsk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$mounts = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $tot=[double]$_.Size; $used=$tot-[double]$_.FreeSpace
  [ordered]@{ mount=$_.DeviceID; usedPct=if($tot){[int](($used/$tot)*100)}else{0}; usedGb=[math]::Round($used/1GB,1); totalGb=[math]::Round($tot/1GB,1) } })
$ramBytes = [double]$cs.TotalPhysicalMemory
$top = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
  Sort-Object -Property PercentProcessorTime -Descending | Select-Object -First 8 | ForEach-Object {
    [ordered]@{ cmd=$_.Name; cpu=[math]::Round([double]$_.PercentProcessorTime,1); mem=if($ramBytes){[math]::Round(([double]$_.WorkingSetPrivate/$ramBytes)*100,1)}else{0} } })
$tz = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
$tempC = $null
if ($tz -and $tz.CurrentTemperature) { $tempC = [math]::Round(($tz.CurrentTemperature - 2732) / 10.0, 1) }
$gpu = $null
if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
  $g = (& nvidia-smi.exe --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
  if ($g) { $p = $g -split '\\s*,\\s*'
    $gpu = [ordered]@{ util=[int]$p[0]; temp=[int]$p[1]; memUsed=[math]::Round([double]$p[2]/1024,1); memTotal=[math]::Round([double]$p[3]/1024,1); power=[math]::Round([double]$p[4],0) } } }
$sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" | Select-Object -First 1
$diskPct = if ($sys -and $sys.Size) { [int]((([double]$sys.Size - [double]$sys.FreeSpace) / [double]$sys.Size) * 100) } else { $null }
[ordered]@{ cpu=[int]$total; cores=$cores; ramTotalGb=[math]::Round($ramBytes/1GB,1)
  ramUsedGb=[math]::Round(([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory)/1MB,1)
  swapUsedGb=[math]::Round([double]$pf.CurrentUsage/1024,1); swapTotGb=[math]::Round([double]$pf.AllocatedBaseSize/1024,1)
  netRx=[int64]$rx; netTx=[int64]$tx; diskR=[int64]$dsk.DiskReadBytesPersec; diskW=[int64]$dsk.DiskWriteBytesPersec
  diskPct=$diskPct; uptimeSec=[int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; tempCpu=$tempC; gpu=$gpu
  mounts=$mounts; top=$top } | ConvertTo-Json -Compress -Depth 4`

const WIN_METRICS_V2 = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WIN_METRICS_V2_PS, 'utf16le').toString('base64')}`

const WIN_METRICS =
  '$c=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average; ' +
  '$o=Get-CimInstance Win32_OperatingSystem; ' +
  '$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"; ' +
  '$up=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds; ' +
  'Write-Output "$c"; Write-Output "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"; ' +
  'Write-Output "$([int](($d.Size-$d.FreeSpace)/$d.Size*100))"; Write-Output "$up"'

interface WinRawV2 {
  cpu?: number
  cores?: number[]
  ramTotalGb?: number
  ramUsedGb?: number
  swapUsedGb?: number
  swapTotGb?: number
  netRx?: number
  netTx?: number
  diskR?: number
  diskW?: number
  diskPct?: number | null
  uptimeSec?: number
  tempCpu?: number | null
  gpu?: GpuInfo | null
  mounts?: MountInfo[]
  top?: ProcInfo[]
}

/** Ответ богатого Windows-зонда → те же поля, что даёт Linux-ветка, включая полный LiveMetrics. */
function parseWinV2(out: string): (Partial<PcMetrics> & { metrics: LiveMetrics }) | null {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'))
  if (!line) return null
  let o: WinRawV2
  try {
    o = JSON.parse(line) as WinRawV2
  } catch {
    return null
  }
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const metrics: LiveMetrics = {
    cpu: n(o.cpu),
    cores: Array.isArray(o.cores) ? o.cores.map(n) : [],
    // У Windows нет loadavg как понятия — не выдумываем, отдаём нули.
    load: [0, 0, 0],
    ramUsed: n(o.ramUsedGb),
    ramTotal: n(o.ramTotalGb),
    cacheGb: 0,
    swapUsed: n(o.swapUsedGb),
    swapTotal: n(o.swapTotGb),
    netRx: n(o.netRx),
    netTx: n(o.netTx),
    diskR: n(o.diskR),
    diskW: n(o.diskW),
    disk: o.diskPct ?? undefined,
    uptime: n(o.uptimeSec),
    tempCpu: o.tempCpu ?? undefined,
    gpu: o.gpu ?? undefined,
    mounts: Array.isArray(o.mounts) ? o.mounts : [],
    top: Array.isArray(o.top) ? o.top : []
  }
  return {
    cpu: metrics.cpu,
    ramUsed: metrics.ramUsed,
    ramTotal: metrics.ramTotal,
    disk: metrics.disk,
    uptime: metrics.uptime,
    netRx: metrics.netRx,
    netTx: metrics.netTx,
    swapUsed: metrics.swapUsed,
    swapTotal: metrics.swapTotal,
    tempCpu: metrics.tempCpu,
    metrics
  }
}

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
    const r = await execOnConn(ep.conn, WIN_METRICS_V2, 15000)
    const rich = r.ok ? parseWinV2(r.output) : null
    if (rich) return { current: label, family: 'windows', ...rich }
    // Фолбэк на старый короткий сборщик: лучше цифры на карточке, чем ничего.
    const f = await execOnConn(ep.conn, WIN_METRICS, 12000)
    return { current: label, family: 'windows', ...(f.ok ? parseWinMetrics(f.output) : {}) }
  }
  const r = await execOnConn(ep.conn, LINUX_PROBE_V2, 12000)
  if (!r.ok) return { current: label, family: 'linux' }
  const m = parseProbeV2(r.output)
  return {
    current: label,
    family: 'linux',
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
/** Живой эндпоинт с повторами.
 *
 *  Замерено на живом стенде: канал до дальней ноды флапает примерно в одном случае из шести, и
 *  ОДНА неудачная проверка молча превращала команду питания в отказ «не в сети» — при полностью
 *  живом сервере. Команда просто не выполнялась, а пользователь видел враньё. */
async function liveEndpointRetry(deviceId: string, attempts = 3): Promise<LiveEp | null> {
  for (let i = 0; i < attempts; i++) {
    const ep = await liveEndpoint(deviceId)
    if (ep) return ep
    if (i < attempts - 1) await delay(1200)
  }
  return null
}

export async function power(
  deviceId: string,
  action: 'reboot' | 'poweroff' | 'suspend'
): Promise<PowerResult> {
  const ep = await liveEndpointRetry(deviceId)
  if (!ep)
    return {
      ok: false,
      os: '',
      phase: 'no-endpoint',
      error: 'не отвечает ни одна ОС (проверено 3 раза) — устройство выключено или канал недоступен'
    }
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
  const ep = await liveEndpointRetry(deviceId)
  if (!ep) return { ok: false, os: '', text: 'не отвечает ни одна ОС (проверено 3 раза)' }
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
