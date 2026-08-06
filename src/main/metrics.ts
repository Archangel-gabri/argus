// Богатый agentless-зонд (AIDA-вкладка). Один SSH-exec, секции-маркеры @@NAME. Rate-метрики
// (CPU per-core, сеть, disk I/O) — из дельты ДВУХ сэмплов с паузой 0.7с прямо в команде
// (self-contained, без хранения предыдущего состояния в main). Все секции опциональны:
// нет sensors/nvidia-smi/ss — соответствующие поля просто отсутствуют, не ошибка.
import type { LiveMetrics, MountInfo, ProcInfo, GpuInfo } from './types'
import { sections } from './shell-out'

const SAMPLE_SEC = 0.7

// LC_ALL=C по той же причине, что и в инвентаре: локализованные заголовки df/ps ломают разбор.
export const LINUX_PROBE_V2 = ['export LC_ALL=C',
  `echo @@S1; grep '^cpu' /proc/stat; echo @@N1; cat /proc/net/dev; echo @@D1; cat /proc/diskstats`,
  `sleep ${SAMPLE_SEC}`,
  `echo @@S2; grep '^cpu' /proc/stat; echo @@N2; cat /proc/net/dev; echo @@D2; cat /proc/diskstats`,
  `echo @@LOAD; cat /proc/loadavg`,
  `echo @@MEM; grep -E '^(MemTotal|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo`,
  // ВАЖНО про df: `-P` на BSD и macOS означает блоки по 512 БАЙТ, а не по 1024 — без явного
  // `-k` цифры там выходят вдвое меньше настоящих, причём молча. Флага `-x` на BSD/macOS нет
  // вовсе, поэтому исключаем служебные ФС уже при разборе, а не флагом.
  `echo @@MOUNTS; df -k -P 2>/dev/null`,
  `echo @@UP; cat /proc/uptime`,
  `echo @@TEMP; { for z in /sys/class/thermal/thermal_zone*/temp; do [ -r "$z" ] && cat "$z"; done; command -v sensors >/dev/null 2>&1 && sensors -u 2>/dev/null | awk -F: '/temp[0-9]+_input/{print $2}'; } 2>/dev/null`,
  `echo @@GPU; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>/dev/null`,
  // `--sort` есть только у GNU ps; на BSD и macOS сортировка по CPU это `-r`, а `-e` там
  // значит другое. Пробуем GNU-форму, при неудаче — переносимую.
  //
  // Выбор ветки обязан стоять ВНУТРИ группы, до конвейера: код возврата конвейера — это код
  // последней команды, то есть `head`, а он успешен всегда. Пока `||` стоял после `| head -9`,
  // фолбэк не выполнялся никогда, и на хосте без GNU ps секция приходила пустой — интерфейс
  // читает это как «процессов нет», хотя правда «не смогли спросить».
  `echo @@TOP; { ps -eo pcpu,pmem,comm --sort=-pcpu 2>/dev/null || ps -axco pcpu,pmem,comm -r 2>/dev/null; } | head -9`,
  `echo @@END`
].join('; ')

/** Разбить вывод на секции по строкам-маркерам @@NAME. */
const num = (s: string | undefined): number => {
  const n = parseFloat((s ?? '').trim())
  return Number.isFinite(n) ? n : 0
}
const KB_TO_GB = 1 / 1048576
const round1 = (n: number): number => Math.round(n * 10) / 10

/** /proc/stat cpu-строка → {total, idle}. Поля: user nice system idle iowait irq softirq steal … */
function cpuStat(line: string): { key: string; total: number; idle: number } {
  const t = line.trim().split(/\s+/)
  const idle = num(t[4]) + num(t[5])
  const nonidle = num(t[1]) + num(t[2]) + num(t[3]) + num(t[6]) + num(t[7]) + num(t[8])
  return { key: t[0], total: idle + nonidle, idle }
}

/** Дельта CPU total + per-core между двумя сэмплами. */
function cpuDelta(s1: string[], s2: string[]): { total: number; cores: number[] } {
  const map1 = new Map(s1.filter((l) => l.startsWith('cpu')).map((l) => { const c = cpuStat(l); return [c.key, c] as const }))
  let total = 0
  const cores: number[] = []
  for (const l of s2) {
    if (!l.startsWith('cpu')) continue
    const c = cpuStat(l)
    const p = map1.get(c.key)
    if (!p) continue
    const dt = c.total - p.total
    const di = c.idle - p.idle
    const pct = dt > 0 ? Math.min(100, Math.max(0, Math.round((100 * (dt - di)) / dt))) : 0
    if (c.key === 'cpu') total = pct
    else cores[parseInt(c.key.slice(3), 10)] = pct
  }
  return { total, cores: cores.filter((v) => v !== undefined) }
}

/** Сумма rx/tx байт по интерфейсам (кроме lo) из /proc/net/dev. */
function netTotals(lines: string[]): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const raw of lines) {
    if (!raw.includes(':')) continue
    const t = raw.replace(':', ' ').trim().split(/\s+/)
    if (t[0] === 'lo' || !t[0]) continue
    rx += num(t[1])
    tx += num(t[9])
  }
  return { rx, tx }
}

const PHYS_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/

/** Сумма sectors read/written (×512 = байт) по физическим дискам из /proc/diskstats. */
function diskTotals(lines: string[]): { r: number; w: number; measured: boolean } {
  let r = 0
  let w = 0
  // `measured` отличает «дисков не нашлось» от «диск простаивал». Список имён намеренно узкий
  // (обычные диски и nvme), поэтому на машине с LVM (`dm-0`), софт-рейдом (`md0`) или без
  // секции diskstats он не совпадёт ни разу — и сумма честно останется нулём. Раньше такой
  // случай отдавался как измеренный ноль, и интерфейс показывал «0 Б/с» вместо «недоступно»:
  // отсутствие данных выглядело как факт простоя.
  let measured = false
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/)
    if (t.length < 10 || !PHYS_DISK.test(t[2])) continue
    measured = true
    r += num(t[5]) * 512
    w += num(t[9]) * 512
  }
  return { r, w, measured }
}

function parseMem(lines: string[]): { used: number; total: number; cache: number; swapUsed: number; swapTotal: number } {
  const kv: Record<string, number> = {}
  for (const l of lines) {
    const m = l.match(/^(\w+):\s+(\d+)/)
    if (m) kv[m[1]] = num(m[2])
  }
  const total = kv.MemTotal || 0
  const used = total - (kv.MemAvailable || 0)
  const cache = (kv.Cached || 0) + (kv.SReclaimable || 0)
  return {
    used: round1(used * KB_TO_GB),
    total: round1(total * KB_TO_GB),
    cache: round1(cache * KB_TO_GB),
    swapUsed: round1(((kv.SwapTotal || 0) - (kv.SwapFree || 0)) * KB_TO_GB),
    swapTotal: round1((kv.SwapTotal || 0) * KB_TO_GB)
  }
}

function parseMounts(lines: string[]): { mounts: MountInfo[]; root?: number } {
  const mounts: MountInfo[] = []
  let root: number | undefined
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    if (t.length < 6 || t[0] === 'Filesystem') continue
    // Служебные ФС отсеиваем здесь, а не флагом `-x`: его нет на BSD и macOS.
    if (/^(tmpfs|devtmpfs|overlay|squashfs|devfs|procfs|linprocfs|linsysfs|fdescfs|none|udev|map\b)/i.test(t[0]))
      continue
    const blocks = num(t[1]) // килобайты: команда идёт с явным -k (см. комментарий у зонда)
    const usedKb = num(t[2])
    const usedPct = num(t[4].replace('%', ''))
    const mount = t.slice(5).join(' ')
    if (!blocks) continue
    mounts.push({ mount, usedPct, usedGb: round1(usedKb * KB_TO_GB), totalGb: round1(blocks * KB_TO_GB) })
    if (mount === '/') root = usedPct
  }
  return { mounts, root }
}

/** Температура: thermal_zone (ЦЕЛЫЕ миллиградусы) vs sensors (градусы С ТОЧКОЙ) — различаем по
 *  наличию точки. Берём макс. в правдоподобном диапазоне 15–110°C (= самый горячий датчик). */
function parseTemp(lines: string[]): number | undefined {
  let best: number | undefined
  for (const l of lines) {
    const s = l.trim()
    if (!s) continue
    let v = parseFloat(s)
    if (!Number.isFinite(v) || v === 0) continue
    if (!s.includes('.')) v = v / 1000 // целое = миллиградусы thermal_zone
    if (v >= 15 && v <= 110 && (best === undefined || v > best)) best = Math.round(v * 10) / 10
  }
  return best
}

function parseGpu(lines: string[]): GpuInfo | undefined {
  const line = lines.find((l) => l.includes(','))
  if (!line) return undefined
  const t = line.split(',').map((s) => num(s))
  return { util: t[0], temp: t[1], memUsed: round1(t[2] / 1024), memTotal: round1(t[3] / 1024), power: t[4] || undefined }
}

function parseTop(lines: string[]): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    if (t.length < 3 || t[0] === '%CPU' || !/^\d/.test(t[0])) continue
    out.push({ cpu: num(t[0]), mem: num(t[1]), cmd: t.slice(2).join(' ') })
  }
  return out.slice(0, 8)
}

/** Полный разбор вывода LINUX_PROBE_V2 в LiveMetrics. Best-effort — отсутствующие секции = дефолты. */
export function parseProbeV2(out: string): LiveMetrics {
  const s = sections(out)
  const cpu = cpuDelta(s.S1 ?? [], s.S2 ?? [])
  const n1 = netTotals(s.N1 ?? [])
  const n2 = netTotals(s.N2 ?? [])
  const d1 = diskTotals(s.D1 ?? [])
  const d2 = diskTotals(s.D2 ?? [])
  const mem = parseMem(s.MEM ?? [])
  const { mounts, root } = parseMounts(s.MOUNTS ?? [])
  const load = (s.LOAD?.[0] ?? '').trim().split(/\s+/)
  return {
    cpu: cpu.total,
    cores: cpu.cores,
    load: [num(load[0]), num(load[1]), num(load[2])],
    ramUsed: mem.used,
    ramTotal: mem.total,
    cacheGb: mem.cache,
    swapUsed: mem.swapUsed,
    swapTotal: mem.swapTotal,
    netRx: Math.max(0, Math.round((n2.rx - n1.rx) / SAMPLE_SEC)),
    netTx: Math.max(0, Math.round((n2.tx - n1.tx) / SAMPLE_SEC)),
    diskR: Math.max(0, Math.round((d2.r - d1.r) / SAMPLE_SEC)),
    diskW: Math.max(0, Math.round((d2.w - d1.w) / SAMPLE_SEC)),
    // Только если оба замера действительно нашли физические диски. Иначе это не ноль, а «не знаю».
    diskIoAvailable: d1.measured && d2.measured,
    disk: root,
    uptime: s.UP ? Math.floor(num((s.UP[0] ?? '').trim().split(/\s+/)[0])) : undefined,
    tempCpu: parseTemp(s.TEMP ?? []),
    gpu: parseGpu(s.GPU ?? []),
    mounts,
    top: parseTop(s.TOP ?? [])
  }
}

// ── Единая точка разбора ───────────────────────────────────────────────────────────────────────
// Универсальный зонд сам выбирает ветку по ОС, поэтому и разбор выбирается по его ответу.
import { probedFamily, parseFreeBsd, parseDarwin, universalProbe } from './metrics-bsd'

export const UNIVERSAL_PROBE = universalProbe(LINUX_PROBE_V2)

export function parseAnyProbe(out: string): LiveMetrics {
  const fam = probedFamily(out)
  if (fam === 'darwin') return parseDarwin(out)
  if (fam === 'freebsd') return parseFreeBsd(out)
  return parseProbeV2(out)
}
