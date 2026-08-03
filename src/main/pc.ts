// Multi-boot ПК: одна железка, N ОС (основной эндпоинт + altOs). Определяем живую ОС,
// переключаем загрузку, шлём питание/метрики на живой ОС. Команды OS-aware по семейству
// (Linux systemctl/grub, Windows PowerShell/shutdown.exe).
import os from 'node:os'
import dgram from 'node:dgram'
import { getOsEndpoints, getDeviceMac, type DeviceConn, type OsEndpoint } from './vault'
import { execOnConn } from './ssh'
import { tcpAlive } from './liveness'
import { singleFlight } from './single-flight'
import { UNIVERSAL_PROBE, parseAnyProbe } from './metrics'
import type { PowerResult, PowerDiag, LiveMetrics, MountInfo, ProcInfo, GpuInfo } from './types'
import {
  BOOT_READY_MARKER,
  bootCommandSucceeded,
  bootEntryListResult
} from './pc-boot-policy'

export type OsFamily = 'linux' | 'windows' | 'off'

const family = (osLabel: string): 'linux' | 'windows' => (/win/i.test(osLabel) ? 'windows' : 'linux')

// Семейство по ФАКТУ, если метка ОС не заполнена.
//
// Метка — это то, что пользователь написал руками, и она вполне может быть пустой. Пустую строку
// `family()` относила к Linux, а значит на безымянный Windows-хост уходил `systemctl` — команда
// питания просто не работала, и по сообщению было не понять почему. Спрашиваем систему.
// Отдельным вызовом, а не заменой `echo argus-ok`: тот же `isAlive` проверяет, ПОГАСЛА ли машина
// после poweroff, и команда, которой на Windows нет, соврала бы там «погасла».
const famCache = new Map<string, 'linux' | 'windows'>()
async function resolveFamily(ep: OsEndpoint): Promise<'linux' | 'windows'> {
  if (ep.os.trim()) return family(ep.os)
  const key = `${ep.conn.host}:${ep.conn.port}`
  const hit = famCache.get(key)
  if (hit) return hit
  const r = await execOnConn(ep.conn, 'uname -s', 8000)
  const text = `${r.output}\n${r.error ?? ''}`
  // uname есть в любой POSIX-системе. Если вместо имени системы пришло «команда не найдена» —
  // мы не на POSIX. Текст ошибки тут такой же ответ, как и удачный вывод.
  const sawPosix = /linux|darwin|bsd|sunos|aix/i.test(text)
  const sawWindowsShell = /not recognized|not found|CommandNotFound|не является|не найден/i.test(text)
  const fam: 'linux' | 'windows' = sawPosix ? 'linux' : sawWindowsShell ? 'windows' : 'linux'
  // Кэшируем ТОЛЬКО измеренное. Ветка «ничего не поняли → linux» — это догадка по умолчанию,
  // и она возникает ровно тогда, когда связи не было вовсе. Раньше такая догадка ложилась в
  // кэш бессрочно: одна неудачная попытка навсегда назначала Windows-машине Linux-семейство,
  // после чего к ней уходил Linux-зонд, а починить это можно было только перезапуском.
  if (sawPosix || sawWindowsShell) famCache.set(key, fam)
  return fam
}

/**
 * Широковещательные адреса всех непетлевых IPv4-интерфейсов.
 *
 * Нужны для WoL: пакет в 255.255.255.255 уходит по маршруту по умолчанию, а при поднятом VPN
 * это туннель — то есть не та сеть, где стоит спящая машина.
 */
function broadcastAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const addr = i.address.split('.').map(Number)
      const mask = i.netmask.split('.').map(Number)
      if (addr.length !== 4 || mask.length !== 4) continue
      out.push(addr.map((o, k) => (o | (~mask[k] & 255)) >>> 0).join('.'))
    }
  }
  return out
}

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
        .then(async (ok) => {
          if (ok) resolve({ ...ep, family: await resolveFamily(ep) })
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

  // Хост за бастионом напрямую недостижим ПО ОПРЕДЕЛЕНИЮ: прямая TCP-проба всегда промахнётся
  // и отсеет живой эндпоинт. `liveness.ts` от этого уже защищается явной оговоркой, а здесь
  // защиты не было — двухзагрузочный ПК за бастионом отбраковывался целиком.
  if (eps.some((e) => e.conn.jump)) return firstAlive(eps)

  const reach = await Promise.all(eps.map(async (ep) => ({ ep, r: await tcpAlive(ep.conn.host, ep.conn.port, 2500) })))
  const open = reach.filter((x) => x.r.status === 'online').map((x) => x.ep)
  // Ровно один эндпоинт отдал SSH-баннер — этого достаточно: одновременно две ОС на одной
  // железке не работают. Второе SSH-подключение ради `echo` стоило бы ещё ~2с на ровном месте.
  if (open.length === 1) return { ...open[0], family: await resolveFamily(open[0]) }
  // Никто не ответил (фаервол/нестандартный порт) или ответили несколько — проверяем по-честному.
  return firstAlive(open.length ? open : eps)
}

/** Текущая запущенная ОС: метка + семейство (или off). */
export function whichOs(deviceId: string): Promise<{ current: string; family: OsFamily }> {
  return singleFlight(`whichOs:${deviceId}`, () => whichOsNow(deviceId))
}

async function whichOsNow(deviceId: string): Promise<{ current: string; family: OsFamily }> {
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

// Отсутствие счётчика отдаётся как $null, а НЕ приводится к нулю.
//
// `[int64]$dsk.DiskReadBytesPersec` при $dsk = $null даёт 0 — и разбор не может отличить
// «диск простаивал» от «счётчика не было». Ноль уезжал в карточку и в историю как измеренный,
// а признак diskIoAvailable, который специально для этого и заведён, всегда был true.
// Счётчики Win32_PerfFormattedData отваливаются не так редко: их ломает повреждённый реестр
// производительности, и лечится это отдельной командой.
//
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
[ordered]@{ cpu=if($null -ne $total){[int]$total}else{$null}; cores=$cores; ramTotalGb=[math]::Round($ramBytes/1GB,1)
  ramUsedGb=[math]::Round(([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory)/1MB,1)
  swapUsedGb=[math]::Round([double]$pf.CurrentUsage/1024,1); swapTotGb=[math]::Round([double]$pf.AllocatedBaseSize/1024,1)
  netRx=if($null -ne $rx){[int64]$rx}else{$null}; netTx=if($null -ne $tx){[int64]$tx}else{$null}
  diskR=if($dsk){[int64]$dsk.DiskReadBytesPersec}else{$null}; diskW=if($dsk){[int64]$dsk.DiskWriteBytesPersec}else{$null}
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
    diskIoAvailable:
      typeof o.diskR === 'number' && Number.isFinite(o.diskR) &&
      typeof o.diskW === 'number' && Number.isFinite(o.diskW),
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
export function metrics(deviceId: string): Promise<PcMetrics> {
  return singleFlight(`pcMetrics:${deviceId}`, () => metricsNow(deviceId))
}

async function metricsNow(deviceId: string): Promise<PcMetrics> {
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
  const r = await execOnConn(ep.conn, UNIVERSAL_PROBE, 15000)
  if (!r.ok) return { current: label, family: 'linux' }
  const m = parseAnyProbe(r.output)
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
    let settled = false
    // Любой выход отсюда обязан закрыть сокет и ответить ровно один раз. Без этого запрос
    // на пробуждение мог зависнуть НАВСЕГДА: `bind` без сети и обратный вызов `send`, который
    // не приходит, не порождают события 'error' — промис просто оставался висеть, а с ним
    // и кнопка в интерфейсе.
    const finish = (res: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* сокет мог уже закрыться сам */
      }
      resolve(res)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'не удалось отправить magic-пакет за 5с' }), 5000)

    sock.once('error', (e) => finish({ ok: false, error: e.message }))
    sock.bind(() => {
      try {
        sock.setBroadcast(true)
      } catch (e) {
        return finish({ ok: false, error: `широковещание недоступно: ${(e as Error).message}` })
      }
      // Шлём во ВСЕ широковещательные адреса, а не только в 255.255.255.255.
      //
      // Пакет в 255.255.255.255 уходит по маршруту по умолчанию. У владельца поднят VPN —
      // значит по умолчанию маршрут идёт в туннель, и пакет улетает туда, где спящей машины
      // нет. Ответ при этом честный по форме («отправлено») и бесполезный по существу: WoL
      // работает только внутри той же локальной сети, что и целевая машина.
      //
      // Поэтому адреса считаем по каждому непетлевому IPv4-интерфейсу и шлём в каждый.
      const targets = [...new Set(['255.255.255.255', ...broadcastAddresses()])]
      const ports = [9, 7] // 9 — стандарт WoL, 7 — исторический дубль
      let pending = targets.length * ports.length
      let sendErr: string | undefined
      let delivered = 0
      const doneOne = (err: Error | null): void => {
        if (err) {
          if (!sendErr) sendErr = err.message
        } else delivered++
        // Успехом считаем хотя бы одну удавшуюся отправку: часть интерфейсов может не
        // принимать широковещание, и это не повод объявлять отказ.
        if (--pending === 0)
          finish(delivered > 0 ? { ok: true } : { ok: false, error: sendErr ?? 'ни один интерфейс не принял пакет' })
      }
      for (const addr of targets) for (const port of ports) sock.send(packet, 0, packet.length, port, addr, doneOne)
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
// Команды питания для юникс-семейства. systemctl есть ТОЛЬКО в Linux — на macOS и FreeBSD
// его нет вовсе, и прежняя версия слала туда заведомо несуществующую команду.
// Порядок в цепочке: systemd → BSD/macOS shutdown → голый reboot/poweroff.
// Тонкости, из-за которых цепочка именно такая:
//   FreeBSD: выключение это `shutdown -p now` (-h только останавливает, питание остаётся);
//   macOS:   сон это `shutdown -s now` (root) либо `pmset sleepnow` — последний работает без sudo;
//   FreeBSD: сон — `zzz`, обёртка над ACPI/APM, либо напрямую `acpiconf -s3` (нужен root).
const CMD = {
  linux: {
    reboot:
      'sudo -n systemctl reboot -i 2>/dev/null || systemctl reboot -i 2>/dev/null || ' +
      'sudo -n shutdown -r now 2>/dev/null || sudo -n reboot',
    poweroff:
      'sudo -n systemctl poweroff -i 2>/dev/null || systemctl poweroff -i 2>/dev/null || ' +
      'sudo -n shutdown -p now 2>/dev/null || sudo -n shutdown -h now 2>/dev/null || sudo -n poweroff',
    suspend:
      'sudo -n systemctl suspend -i 2>/dev/null || systemctl suspend -i 2>/dev/null || ' +
      'pmset sleepnow 2>/dev/null || sudo -n zzz 2>/dev/null || sudo -n acpiconf -s3'
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
//
// НО: разрыв засчитывается только ПОСЛЕ того, как команда ушла. Ошибки фазы подключения
// («Timed out while waiting for handshake», отказ в соединении, провал авторизации) означают
// ровно обратное — команда не выполнялась вообще. Раньше они подходили под общий шаблон
// «timed out» и превращались в бодрое «✓ ПК перезагружается», хотя не произошло ничего.
const isConnectFailure = (err: string | undefined): boolean =>
  /handshake|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|authentication|All configured authentication methods failed|connect ETIMEDOUT/i.test(
    err ?? ''
  )
const isDropped = (err: string | undefined): boolean =>
  !isConnectFailure(err) && /closed|disconnect|ECONNRESET|timed?\s?out|exit \?|signal /i.test(err ?? '')

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
  // Отдельно — случай «до хоста не доехали»: это НЕ отказ хоста, команда не выполнялась.
  if (!r.ok && !dropped) {
    return {
      ok: false,
      os: ep.os,
      phase: isConnectFailure(r.error) ? 'unreachable' : 'rejected',
      output: r.output,
      error: (r.output?.trim() || r.error || 'команда отклонена хостом').slice(0, 400)
    }
  }

  // reboot: verify занял бы минуты — сообщаем «принято».
  if (action === 'reboot') {
    return { ok: true, os: ep.os, phase: 'accepted', output: 'команда отправлена — ПК перезагружается' }
  }

  // poweroff/suspend: ждём и проверяем, что эндпоинт действительно умер.
  //
  // Проверка ДВОЙНАЯ, и это принципиально. Канал до дальней ноды флапает примерно в одном
  // случае из шести — ровно поэтому рядом живёт `liveEndpointRetry` с тремя попытками. Но
  // вердикт «машина погасла» до сих пор выносился по ОДНОМУ промаху, то есть тот же флап,
  // от которого мы защищаемся при отправке команды, здесь превращался в «✓ ПК выключился».
  //
  // Асимметрия недопустима: утверждение о необратимом действии должно стоить не меньше
  // проверок, чем утверждение «не в сети».
  await delay(7000)
  let stillAlive = await isAlive(ep.conn)
  if (!stillAlive) {
    await delay(2000)
    stillAlive = await isAlive(ep.conn)
  }
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

export interface BootEntry {
  /** Что подставлять в поле «загрузочная запись»: 4 hex-цифры (Linux) или {GUID} (Windows). */
  id: string
  /** Человеческое имя записи, как его показывает сама машина. */
  label: string
}

/**
 * Список загрузочных записей прошивки — чтобы их не приходилось узнавать и вписывать руками.
 *
 * Это была главная причина, по которой переключение ОС не работало: без записи «перезагрузка»
 * не выбирает систему, а лишь отдаёт выбор загрузчику, и машина возвращается туда же, откуда
 * ушла. Узнать идентификатор можно было только вручную через bcdedit/efibootmgr — то есть
 * функция существовала, но пользоваться ею было нечем.
 */
export async function bootEntries(
  deviceId: string
): Promise<{ ok: boolean; os: string; entries: BootEntry[]; error?: string }> {
  const ep = await liveEndpoint(deviceId)
  if (!ep) return { ok: false, os: '', entries: [], error: 'машина не в сети' }
  if (ep.family === 'linux') {
    const r = await execOnConn(ep.conn, 'efibootmgr -v 2>/dev/null || sudo -n efibootmgr -v 2>/dev/null', 10000)
    const result = bootEntryListResult(r.ok, r.output, parseEfibootmgr(r.output), r.error)
    return { ...result, os: ep.os }
  }
  const r = await execOnConn(ep.conn, BCDEDIT_FIRMWARE_CMD, 15000)
  const result = bootEntryListResult(r.ok, r.output, parseBcdedit(r.output), r.error)
  return { ...result, os: ep.os }
}

/** `Boot0001* Windows Boot Manager\tHD(1,GPT,…)` → { id: '0001', label: 'Windows Boot Manager' } */
export function parseEfibootmgr(out: string): BootEntry[] {
  const entries: BootEntry[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^Boot([0-9A-Fa-f]{4})\*?\s+(.+)$/)
    if (!m) continue
    // Путь к загрузчику ОСТАВЛЯЕМ в подписи, и это не украшение.
    //
    // Прошивки сплошь и рядом дают одинаковые имена: две записи «Linux Boot Manager» или два
    // «UEFI OS» — обычное дело на машине с несколькими дисками. Выбросив путь, мы делали такие
    // записи неразличимыми в списке, и человек назначал загрузку наугад — то есть мог отправить
    // машину не в ту систему. Ровно от этого и защищает Windows-ветка, где путь загрузчика
    // стоит в подписи первым.
    const [rawName, ...restParts] = m[2].split('\t')
    const name = rawName.trim()
    const efiPath = restParts.join('\t').match(/\\EFI\\[^\s)]+\.efi/i)
    if (name) entries.push({ id: m[1], label: efiPath ? `${efiPath[0]} · ${name}` : name })
  }
  return entries
}

// Вывод bcdedit идёт в кодировке консоли, а на русской Windows это cp866 — подписи записей
// приезжали кракозябрами. `chcp 65001` переводит саму консоль в UTF-8 ДО запуска bcdedit,
// а OutputEncoding говорит PowerShell читать её ответ так же. Без первого второе бесполезно.
const BCDEDIT_PS =
  `chcp 65001 > $null; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
  `$ErrorActionPreference='SilentlyContinue'; & bcdedit /enum firmware`
const BCDEDIT_FIRMWARE_CMD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(BCDEDIT_PS, 'utf16le').toString('base64')}`

/**
 * `bcdedit /enum firmware` — блоки, разделённые пустой строкой.
 *
 * Разбираем ПО ФОРМЕ, а не по названиям полей: вывод bcdedit переведён, и на русской Windows
 * там не «identifier», а «идентификатор». Зато форма одинакова везде — первая строка блока
 * это имя записи, а первый в блоке идентификатор в фигурных скобках принадлежит именно ей
 * (bcdedit всегда печатает его первым полем; дальше в displayorder идут ЧУЖИЕ идентификаторы).
 */
export function parseBcdedit(out: string): BootEntry[] {
  const entries: BootEntry[] = []
  const blocks = out.replace(/\r/g, '').split(/\n\s*\n/)
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim())
    if (lines.length < 2) continue
    const label = lines[0].trim()
    if (/^-+$/.test(label)) continue
    const idm = b.match(/\{[0-9a-fA-F-]{36}\}|\{[a-z]+\}/)
    if (!idm) continue
    const id = idm[0]
    // Сам диспетчер прошивки — не цель загрузки, а список.
    if (id === '{fwbootmgr}') continue
    // Имена у записей прошивки сплошь одинаковые («Приложение микропрограммы»), выбрать по ним
    // нельзя. Путь к загрузчику различает их сразу: \EFI\refind\refind_x64.efi против
    // \EFI\Microsoft\Boot\bootmgfw.efi. Ищем по форме — названия полей переведены, значения нет.
    const pathm = b.match(/\\EFI\\[^\s]+\.efi/i)
    // Путь идёт ПЕРВЫМ: именно он различает записи, а имя у них у всех одинаковое.
    entries.push({ id, label: pathm ? `${pathm[0]} · ${label}` : label })
  }
  return entries
}

/** Загрузить target-ОС только по точно назначенной ей записи. Угадывание по имени загружает не ту ОС. */
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
    // Номер EFI-записи (4 hex-цифры) — самый общий путь: работает с любым загрузчиком,
    // а не только с GRUB. На этой машине, например, стоит rEFInd, и grub-reboot там бесполезен.
    if (target?.bootEntry && /^[0-9A-Fa-f]{4}$/.test(target.bootEntry.trim())) {
      cmd =
        `sudo -n efibootmgr --bootnext ${target.bootEntry.trim()} && ` +
        `printf '%s\\n' ${shq(BOOT_READY_MARKER)} && sudo -n systemctl reboot`
    } else if (target?.bootEntry) {
      // bootEntry — строка из устройства: валидируем (без переносов/абсурдной длины) и
      // экранируем одинарными кавычками, чтобы исключить command injection.
      if (!/^[^\n\r]{1,200}$/.test(target.bootEntry)) {
        return { ok: false, os: ep.os, error: 'некорректный bootEntry' }
      }
      cmd =
        `sudo -n grub-reboot ${shq(target.bootEntry)} && ` +
        `printf '%s\\n' ${shq(BOOT_READY_MARKER)} && sudo -n systemctl reboot`
    } else {
      return {
        ok: false,
        os: ep.os,
        error:
          `Для «${targetOs}» не назначена загрузочная запись. ` +
          'Открой правку устройства, нажми «Спросить машину» и назначь запись именно этой ОС.'
      }
    }
  } else {
    // Из Windows. Раньше здесь был просто `shutdown /r` в расчёте на то, что загрузчик по
    // умолчанию выберет Linux. Это НЕ переключение, а надежда: проверено на живой машине с
    // rEFInd — она честно перезагрузилась и вернулась в Windows, а приложение отрапортовало
    // успех. Настоящий механизм — одноразовый выбор EFI-записи через {fwbootmgr}.
    if (targetFamily !== 'linux') return { ok: false, os: ep.os, error: 'из Windows можно только в Linux' }
    const efiId = (target?.bootEntry || '').trim()
    if (!/^\{[0-9a-fA-F-]{36}\}$/.test(efiId)) {
      return {
        ok: false,
        os: ep.os,
        error:
          'не задана EFI-запись целевой ОС. Простая перезагрузка НЕ выбирает систему — она отдаёт ' +
          'выбор загрузчику, и машина вернётся в текущую ОС. Укажи в карточке устройства, в поле ' +
          '«EFI-запись» у этой ОС, идентификатор вида {xxxxxxxx-…} — посмотреть список: ' +
          'bcdedit /enum firmware'
      }
    }
    // ВАЖНО: не через `&&`. Оболочка по умолчанию у OpenSSH на Windows — PowerShell 5.1,
    // а там `&&` не разделитель команд, а синтаксическая ошибка (его добавили только в 7-й
    // версии). Команда молча не выполнялась — то самое «переключение», которое не переключало.
    // Плюс проверяем код возврата bcdedit: перезагружаться, не выставив запись, бессмысленно —
    // это возврат к «перезагрузились и надеемся».
    const ps =
      `$ErrorActionPreference='Continue'; ` +
      `& bcdedit /set '{fwbootmgr}' bootsequence '${efiId}'; ` +
      `if ($LASTEXITCODE -ne 0) { Write-Output 'ARGUS_BCDEDIT_FAILED'; exit 1 }; ` +
      `Write-Output '${BOOT_READY_MARKER}'; ` +
      `& shutdown.exe /r /t 0`
    cmd = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
  }
  const r = await execOnConn(ep.conn, cmd, 10000)
  if (r.output.includes('ARGUS_BCDEDIT_FAILED'))
    return { ok: false, os: ep.os, output: r.output, error: 'не удалось выставить загрузочную запись — перезагрузка отменена' }
  if (!bootCommandSucceeded(r.ok, r.output, r.error)) {
    return {
      ok: false,
      os: ep.os,
      output: r.output,
      error: r.error || 'команда не подтвердила BootNext; перезагрузка не считается запущенной'
    }
  }
  return { ok: true, os: ep.os, output: r.output }
}
