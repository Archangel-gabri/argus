// Сводка комплектующих (agentless-инвентарь). Linux — компаунд-exec (lscpu/lspci/nvidia-smi/
// lsblk/dmidecode; dmidecode под sudo -n, нет прав → секция пустая, не ошибка). Windows — CIM
// через -EncodedCommand (устойчиво к DefaultShell=PowerShell — урок live-теста 2026-07-23).
// Кэшируется в vault (железо меняется редко). Сбор по живой ОС (resolveConn через whichOs).
import { execOnce } from './ssh'
import { whichOs, osReachable, unreachableReason } from './pc'
import { getDeviceHardware, setDeviceHardware } from './vault'
import type { HardwareInfo, DiskInfo } from './types'
import { sections } from './shell-out'

// LC_ALL=C обязателен: разбор ищет английские подписи («Model name», «Core(s) per socket»),
// а на локализованном хосте lscpu печатает «Имя модели:» — и весь инвентарь выходил пустым
// на совершенно обычных Arch и Ubuntu с русской локалью.
const LINUX_HW_CMD = ['export LC_ALL=C',
  // Проверка читаемости перед `.` обязательна: провал специальной встроенной команды завершает
  // неинтерактивный POSIX-шелл целиком (проверено на dash/sh и `bash --posix`). На хосте без
  // /etc/os-release — busybox, минимальный образ — не выполнялась НИ ОДНА секция после @@OS,
  // и сбор железа не работал там никогда. Bash в обычном режиме это прощает, поэтому вживую
  // дефект не показывался. Та же охрана уже стоит в зонде (ssh.ts).
  `echo @@OS; [ ! -r /etc/os-release ] || . /etc/os-release; echo "$PRETTY_NAME"; uname -r; uname -m; hostname 2>/dev/null; (systemd-detect-virt 2>/dev/null || echo none)`,
  `echo @@CPU; lscpu 2>/dev/null`,
  `echo @@RAM; grep MemTotal /proc/meminfo`,
  `echo @@DIMM; sudo -n dmidecode -t memory 2>/dev/null | grep -E 'Size:|Speed:|Part Number:'`,
  `echo @@BOARD; cat /sys/devices/virtual/dmi/id/board_vendor /sys/devices/virtual/dmi/id/board_name 2>/dev/null`,
  `echo @@GPU; lspci 2>/dev/null | grep -Ei 'vga|3d|display'; nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null`,
  `echo @@DISK; lsblk -dbno NAME,SIZE,MODEL,ROTA,TYPE 2>/dev/null`,
  `echo @@NIC; ip -o link 2>/dev/null | awk -F': ' '{print $2}'`,
  `echo @@END`
].join('; ')

const WIN_HW_PS = [
  // UTF-8 вывод — иначе кириллица (напр. «Майкрософт Windows 11 Pro») приходит cp866-мохито по SSH.
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue'`,
  `$cpu=Get-CimInstance Win32_Processor;$gpu=Get-CimInstance Win32_VideoController`,
  `$bb=Get-CimInstance Win32_BaseBoard;$mem=Get-CimInstance Win32_PhysicalMemory`,
  `$dsk=Get-CimInstance Win32_DiskDrive;$os=Get-CimInstance Win32_OperatingSystem`,
  `[ordered]@{os=$os.Caption;kernel=$os.Version;arch=$os.OSArchitecture;hostname=$env:COMPUTERNAME;` +
    `cpuModel=($cpu|Select-Object -First 1).Name;cpuCores=($cpu|Measure-Object NumberOfCores -Sum).Sum;` +
    `cpuThreads=($cpu|Measure-Object NumberOfLogicalProcessors -Sum).Sum;cpuMhzMax=($cpu|Select-Object -First 1).MaxClockSpeed;` +
    `ramGb=[math]::Round(($mem|Measure-Object Capacity -Sum).Sum/1GB,1);` +
    `dimms=@($mem|ForEach-Object{"$([math]::Round($_.Capacity/1GB))GB $($_.Speed)MHz"});` +
    `board="$($bb.Manufacturer) $($bb.Product)";gpus=@($gpu|ForEach-Object{$_.Name});` +
    `gpuDriver=($gpu|Select-Object -First 1).DriverVersion;` +
    `disks=@($dsk|ForEach-Object{@{name=$_.Model;sizeGb=[math]::Round($_.Size/1GB);ssd=([string]$_.MediaType -match 'SSD')}})` +
    `}|ConvertTo-Json -Depth 5 -Compress`
].join(';')
const WIN_HW_CMD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WIN_HW_PS, 'utf16le').toString('base64')}`

const lscpuVal = (lines: string[], key: string): string | undefined => {
  const l = lines.find((x) => x.trim().startsWith(key))
  return l ? l.slice(l.indexOf(':') + 1).trim() : undefined
}

/** «Size: 16384 MB» / «16 GB» → GB-строка «16GB»; пустые/No Module — пропускаем. */
function parseDimms(lines: string[]): string[] {
  const sizes: string[] = []
  const speeds: string[] = []
  for (const l of lines) {
    const sm = l.match(/Size:\s*([\d.]+)\s*(GB|MB)/i)
    if (sm) sizes.push(sm[2].toUpperCase() === 'MB' ? `${Math.round(parseFloat(sm[1]) / 1024)}GB` : `${sm[1]}GB`)
    const spm = l.match(/Speed:\s*(\d+)\s*(MT\/s|MHz)/i)
    if (spm) speeds.push(`${spm[1]}MHz`)
  }
  return sizes.map((s, i) => (speeds[i] ? `${s} ${speeds[i]}` : s))
}

/**
 * `lsblk -dbno NAME,SIZE,MODEL,ROTA,TYPE` — колонки NAME SIZE MODEL ROTA TYPE.
 *
 * MODEL сплошь и рядом пуст: у виртуальных дисков (vda в облаке, zram) модели просто нет.
 * Тогда в строке остаётся четыре поля вместо пяти — и требование «не меньше пяти» выбрасывало
 * такой диск целиком. У арендованного сервера это означало, что дисков не видно вообще.
 * Крайние поля стоят на местах всегда, поэтому читаем с краёв, а модель — то, что осталось
 * посередине, хоть бы и пусто.
 */
export function parseDisks(lines: string[]): DiskInfo[] {
  const out: DiskInfo[] = []
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    if (t.length < 4) continue
    const name = t[0]
    const sizeB = t[1]
    const type = t[t.length - 1]
    const rota = t[t.length - 2]
    const model = t.slice(2, -2).join(' ')
    if (type !== 'disk' || /^(loop|sr|zram|ram)/.test(name)) continue
    const sizeGb = Math.round(parseFloat(sizeB) / 1e9)
    if (!Number.isFinite(sizeGb)) continue
    out.push({ name, model: model || undefined, sizeGb, ssd: rota === '0' })
  }
  return out
}

function parseLinuxHw(out: string): HardwareInfo {
  const s = sections(out)
  const os = s.OS ?? []
  const cpu = s.CPU ?? []
  const gpuLines = s.GPU ?? []
  const gpus = gpuLines
    .filter((l) => /vga|3d|display/i.test(l) && l.includes(':'))
    .map((l) => l.replace(/^[0-9a-f:.]+\s*/i, '').replace(/.*controller:\s*/i, '').trim())
  const nvidia = gpuLines.find((l) => l.includes(',') && !/vga|3d|display/i.test(l))
  const memKb = parseInt((s.RAM?.[0] ?? '').replace(/\D/g, ''), 10) || 0
  const cpusN = parseInt(lscpuVal(cpu, 'CPU(s)') ?? '', 10) || undefined
  const cores = parseInt(lscpuVal(cpu, 'Core(s) per socket') ?? '', 10)
  const sockets = parseInt(lscpuVal(cpu, 'Socket(s)') ?? '', 10) || 1
  const board = (s.BOARD ?? []).map((x) => x.trim()).filter(Boolean).join(' ')
  return {
    os: os[0]?.trim() || undefined,
    kernel: os[1]?.trim() || undefined,
    arch: os[2]?.trim() || undefined,
    hostname: os[3]?.trim() || undefined,
    virt: os[4]?.trim() && os[4].trim() !== 'none' ? os[4].trim() : undefined,
    cpuModel: lscpuVal(cpu, 'Model name'),
    cpuCores: cores ? cores * sockets : cpusN,
    cpuThreads: cpusN,
    cpuMhzMax: parseFloat(lscpuVal(cpu, 'CPU max MHz') ?? '') || undefined,
    ramGb: memKb ? Math.round((memKb / 1048576) * 10) / 10 : undefined,
    dimms: parseDimms(s.DIMM ?? []),
    board: board || undefined,
    gpus: nvidia ? [nvidia.split(',')[0].trim(), ...gpus.filter((g) => !/nvidia/i.test(g))] : gpus,
    gpuDriver: nvidia ? nvidia.split(',')[1]?.trim() : undefined,
    disks: parseDisks(s.DISK ?? []),
    nics: (s.NIC ?? []).map((x) => x.trim()).filter((x) => x && x !== 'lo')
  }
}

function parseWinHw(out: string): HardwareInfo {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'))
  if (!line) return {}
  try {
    const o = JSON.parse(line) as Record<string, unknown> & { disks?: Array<{ name?: string; sizeGb?: number; ssd?: boolean }> }
    return {
      os: (o.os as string) || undefined,
      kernel: (o.kernel as string) || undefined,
      arch: (o.arch as string) || undefined,
      hostname: (o.hostname as string) || undefined,
      cpuModel: ((o.cpuModel as string) || '').trim() || undefined,
      cpuCores: (o.cpuCores as number) || undefined,
      cpuThreads: (o.cpuThreads as number) || undefined,
      cpuMhzMax: (o.cpuMhzMax as number) || undefined,
      ramGb: (o.ramGb as number) || undefined,
      dimms: (o.dimms as string[]) || [],
      board: ((o.board as string) || '').trim() || undefined,
      gpus: (o.gpus as string[]) || [],
      gpuDriver: (o.gpuDriver as string) || undefined,
      disks: (o.disks || []).map((d) => ({ name: (d.name || 'Диск').trim(), sizeGb: d.sizeGb || 0, ssd: !!d.ssd })),
      nics: []
    }
  } catch {
    return {}
  }
}

/** Собрать железо заново (по живой ОС) + записать в кэш. */
export async function refreshHardware(deviceId: string): Promise<{ ok: boolean; info?: HardwareInfo; error?: string }> {
  const os = await whichOs(deviceId)
  if (!osReachable(os.family)) return { ok: false, error: unreachableReason(os.family) }
  const r = await execOnce(deviceId, os.family === 'windows' ? WIN_HW_CMD : LINUX_HW_CMD)
  if (!r.ok) return { ok: false, error: r.error }
  const info = os.family === 'windows' ? parseWinHw(r.output) : parseLinuxHw(r.output)
  // Пустой разбор — это «машина ничего не отдала», а не «железа нет». У Linux-команды код
  // возврата всегда 0 (она склеена из необязательных источников), поэтому `r.ok` тут ничего
  // не доказывает: одна неудачная попытка затирала собранный инвентарь пустотой, и карточка
  // теряла процессор, память и диски до следующего удачного сбора.
  const empty =
    !info.cpuModel && !info.ramGb && (info.disks?.length ?? 0) === 0 && (info.nics?.length ?? 0) === 0
  if (empty) return { ok: false, error: 'машина не отдала ни одной секции — прежний инвентарь оставлен' }
  info.collectedAt = Date.now()
  setDeviceHardware(deviceId, info as unknown as Record<string, unknown>)
  return { ok: true, info }
}

/** Железо из кэша (или null). */
export function getHardware(deviceId: string): { info: HardwareInfo; collectedAt: number } | null {
  const c = getDeviceHardware(deviceId)
  return c ? { info: c.info as unknown as HardwareInfo, collectedAt: c.collectedAt } : null
}
