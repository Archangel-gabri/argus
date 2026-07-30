// Зонд метрик для macOS и FreeBSD.
//
// Отдельный файл, потому что общего кода с Linux почти нет: там весь сбор построен на /proc,
// которого здесь НЕТ. На FreeBSD procfs не монтируется по умолчанию и объявлен устаревшим,
// на macOS его не существует вовсе. Всё берётся из sysctl и системных утилит.
//
// Значения счётчиков накопительные, поэтому CPU и сеть считаются как дельта двух замеров
// с паузой — ровно так же, как в Linux-зонде.
import type { LiveMetrics, MountInfo, ProcInfo } from './types'

const SAMPLE_SEC = 0.7

/** Разбить вывод на секции по строкам-маркерам @@NAME (тот же формат, что у Linux-зонда). */
function sections(out: string): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)\s*$/)
    if (m) {
      cur = m[1]
      sec[cur] = []
    } else if (cur) {
      sec[cur].push(line)
    }
  }
  return sec
}

const num = (s: string | undefined): number => {
  const n = parseFloat((s ?? '').trim())
  return Number.isFinite(n) ? n : 0
}
const round1 = (n: number): number => Math.round(n * 10) / 10
const BYTES_TO_GB = 1 / 1024 ** 3

// ── FreeBSD ────────────────────────────────────────────────────────────────────────────────────
//
// kern.cp_time — пять накопительных счётчиков: user nice sys intr idle.
// kern.cp_times — то же по каждому ядру подряд.
// Память: свободные страницы = free + inactive + cache, размер страницы отдельным ключом.
export const FREEBSD_PROBE = [
  'export LC_ALL=C',
  `echo @@C1; sysctl -n kern.cp_time; echo @@CC1; sysctl -n kern.cp_times; echo @@N1; netstat -bin`,
  `sleep ${SAMPLE_SEC}`,
  `echo @@C2; sysctl -n kern.cp_time; echo @@CC2; sysctl -n kern.cp_times; echo @@N2; netstat -bin`,
  `echo @@MEM; sysctl -n hw.physmem vm.stats.vm.v_page_size vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count vm.stats.vm.v_cache_count 2>/dev/null`,
  `echo @@SWAP; swapinfo -k 2>/dev/null`,
  `echo @@LOAD; sysctl -n vm.loadavg`,
  `echo @@UP; sysctl -n kern.boottime; date +%s`,
  `echo @@MOUNTS; df -k -P 2>/dev/null`,
  // Датчик температуры есть только если загружен модуль coretemp/amdtemp — на VPS обычно нет.
  `echo @@TEMP; sysctl -n dev.cpu.0.temperature 2>/dev/null`,
  `echo @@TOP; ps -axco pcpu,pmem,comm -r 2>/dev/null | head -9`,
  'echo @@END'
].join('; ')

// ── macOS ──────────────────────────────────────────────────────────────────────────────────────
//
// CPU: у top первый замер всегда невалидный, поэтому берём ВТОРОЙ (-l 2) и последнюю строку.
// Память: vm_stat печатает размер страницы в заголовке — он разный (16К на Apple Silicon, 4К на Intel),
// поэтому парсим его, а не хардкодим.
export const DARWIN_PROBE = [
  'export LC_ALL=C',
  `echo @@N1; netstat -ibn`,
  `sleep ${SAMPLE_SEC}`,
  `echo @@N2; netstat -ibn`,
  `echo @@CPU; top -l 2 -n 0 -s 1 2>/dev/null | grep -i "CPU usage"`,
  `echo @@MEM; sysctl -n hw.memsize; vm_stat`,
  `echo @@SWAP; sysctl -n vm.swapusage`,
  `echo @@LOAD; sysctl -n vm.loadavg`,
  `echo @@UP; sysctl -n kern.boottime; date +%s`,
  `echo @@MOUNTS; df -k -P 2>/dev/null`,
  `echo @@TOP; ps -Aco pcpu,pmem,comm -r 2>/dev/null | head -9`,
  'echo @@END'
].join('; ')

/** `{ 0.42 0.35 0.30 }` → [0.42, 0.35, 0.30] */
function parseLoad(lines: string[]): [number, number, number] {
  const t = (lines[0] ?? '').replace(/[{}]/g, '').trim().split(/\s+/)
  return [num(t[0]), num(t[1]), num(t[2])]
}

/** `{ sec = 1738000000, usec = 123 } Sat …` → аптайм в секундах относительно now. */
function parseBoot(lines: string[]): number | undefined {
  const m = (lines[0] ?? '').match(/sec\s*=\s*(\d+)/)
  if (!m) return undefined
  const now = num(lines[1]) || Math.floor(Date.now() / 1000)
  const up = now - parseInt(m[1], 10)
  return up > 0 ? up : undefined
}

/**
 * `df -k -P` — размеры уже в килобайтах (флаг -k обязателен: на BSD и macOS `-P` сам по себе
 * означает блоки по 512 байт, и без него все числа вышли бы вдвое меньше).
 */
function parseMounts(lines: string[]): { mounts: MountInfo[]; root?: number } {
  const mounts: MountInfo[] = []
  let root: number | undefined
  const seen = new Set<string>()
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    if (t.length < 6 || t[0] === 'Filesystem') continue
    if (/^(devfs|map|procfs|linprocfs|fdescfs|tmpfs|none)/i.test(t[0])) continue
    const mount = t.slice(5).join(' ')
    // У APFS тома одного контейнера показывают одно и то же свободное место — не двоим.
    const key = `${t[0]}|${mount}`
    if (seen.has(key)) continue
    seen.add(key)
    const totalGb = round1((num(t[1]) * 1024) / 1024 ** 3)
    const usedGb = round1((num(t[2]) * 1024) / 1024 ** 3)
    const usedPct = num(t[4].replace('%', ''))
    if (mount === '/') root = usedPct
    mounts.push({ mount, usedPct, usedGb, totalGb })
  }
  return { mounts, root }
}

/** `ps -axco pcpu,pmem,comm -r` (сортировка по CPU — на BSD это `-r`, а не GNU-шный `--sort`). */
function parseTop(lines: string[]): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    if (t.length < 3 || !/^[\d.]+$/.test(t[0])) continue
    out.push({ cpu: num(t[0]), mem: num(t[1]), cmd: t.slice(2).join(' ') })
  }
  return out.slice(0, 8)
}

/**
 * `netstat -bin` / `-ibn`: каждый интерфейс печатает строку `<Link#N>` ПЛЮС по строке на каждый
 * адрес. Суммировать всё подряд нельзя — трафик задвоится, поэтому берём только Link-строки.
 */
function parseNet(lines: string[]): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const l of lines) {
    if (!/<Link#\d+>/.test(l)) continue
    const t = l.trim().split(/\s+/)
    // Ibytes и Obytes — последние числовые колонки; ищем их с конца, формат чуть разный по ОС.
    const nums = t.filter((x) => /^\d+$/.test(x)).map(Number)
    if (nums.length < 4) continue
    // …Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]
    const hasColl = nums.length >= 7
    const obytes = hasColl ? nums[nums.length - 2] : nums[nums.length - 1]
    const ibytes = nums[nums.length - (hasColl ? 5 : 4)]
    rx += ibytes
    tx += obytes
  }
  return { rx, tx }
}

function rate(a: number, b: number): number {
  const d = b - a
  return d > 0 ? Math.round(d / SAMPLE_SEC) : 0
}

/** Разбор ответа зонда FreeBSD. */
export function parseFreeBsd(out: string): LiveMetrics {
  const s = sections(out)
  const cpuDelta = (a: string[], b: string[]): number => {
    const x = (a[0] ?? '').trim().split(/\s+/).map(num)
    const y = (b[0] ?? '').trim().split(/\s+/).map(num)
    if (x.length < 5 || y.length < 5) return 0
    const totalA = x.reduce((p, c) => p + c, 0)
    const totalB = y.reduce((p, c) => p + c, 0)
    const idle = y[4] - x[4]
    const dt = totalB - totalA
    return dt > 0 ? Math.max(0, Math.min(100, Math.round((100 * (dt - idle)) / dt))) : 0
  }
  const coresDelta = (a: string[], b: string[]): number[] => {
    const x = (a[0] ?? '').trim().split(/\s+/).map(num)
    const y = (b[0] ?? '').trim().split(/\s+/).map(num)
    const cores: number[] = []
    for (let i = 0; i + 5 <= Math.min(x.length, y.length); i += 5) {
      let dt = 0
      for (let k = 0; k < 5; k++) dt += y[i + k] - x[i + k]
      const idle = y[i + 4] - x[i + 4]
      cores.push(dt > 0 ? Math.max(0, Math.min(100, Math.round((100 * (dt - idle)) / dt))) : 0)
    }
    return cores
  }

  const mem = (s.MEM ?? []).map(num)
  const [physBytes, pageSize, free, inactive, cache] = [mem[0] ?? 0, mem[1] ?? 4096, mem[2] ?? 0, mem[3] ?? 0, mem[4] ?? 0]
  const freeBytes = (free + inactive + cache) * pageSize
  const ramTotal = round1(physBytes * BYTES_TO_GB)
  const ramUsed = round1(Math.max(0, physBytes - freeBytes) * BYTES_TO_GB)

  // swapinfo -k: Device 1K-blocks Used Avail Capacity
  let swapTotal = 0
  let swapUsed = 0
  for (const l of s.SWAP ?? []) {
    const t = l.trim().split(/\s+/)
    if (t.length < 4 || /^Device/i.test(t[0])) continue
    swapTotal += (num(t[1]) * 1024) * BYTES_TO_GB
    swapUsed += (num(t[2]) * 1024) * BYTES_TO_GB
  }

  const n1 = parseNet(s.N1 ?? [])
  const n2 = parseNet(s.N2 ?? [])
  const { mounts, root } = parseMounts(s.MOUNTS ?? [])
  // dev.cpu.0.temperature отдаёт «45.0C»
  const tempRaw = (s.TEMP ?? [])[0]
  const tempCpu = tempRaw ? num(tempRaw.replace(/C\s*$/i, '')) || undefined : undefined

  return {
    cpu: cpuDelta(s.C1 ?? [], s.C2 ?? []),
    cores: coresDelta(s.CC1 ?? [], s.CC2 ?? []),
    load: parseLoad(s.LOAD ?? []),
    ramUsed,
    ramTotal,
    cacheGb: round1(cache * pageSize * BYTES_TO_GB),
    swapUsed: round1(swapUsed),
    swapTotal: round1(swapTotal),
    netRx: rate(n1.rx, n2.rx),
    netTx: rate(n1.tx, n2.tx),
    // Дисковый ввод-вывод на BSD требует отдельного замера iostat. Числовые поля остаются
    // ради стабильного wire-контракта, но UI обязан смотреть на флаг, а не выдавать 0 за замер.
    diskR: 0,
    diskW: 0,
    diskIoAvailable: false,
    disk: root,
    uptime: parseBoot(s.UP ?? []),
    tempCpu,
    mounts,
    top: parseTop(s.TOP ?? [])
  }
}

/** Разбор ответа зонда macOS. */
export function parseDarwin(out: string): LiveMetrics {
  const s = sections(out)

  // «CPU usage: 4.76% user, 9.52% sys, 85.71% idle» — берём ПОСЛЕДНЮЮ строку: первый замер
  // top всегда невалидный.
  const cpuLines = (s.CPU ?? []).filter((l) => /idle/i.test(l))
  const last = cpuLines[cpuLines.length - 1] ?? ''
  const idleM = last.match(/([\d.]+)%\s*idle/i)
  const cpu = idleM ? Math.max(0, Math.min(100, Math.round(100 - parseFloat(idleM[1])))) : 0

  // Первая строка @@MEM — hw.memsize, дальше вывод vm_stat.
  const memLines = s.MEM ?? []
  const physBytes = num(memLines[0])
  const pageM = memLines.join('\n').match(/page size of (\d+) bytes/i)
  const pageSize = pageM ? parseInt(pageM[1], 10) : 4096
  const vmVal = (name: string): number => {
    const m = memLines.find((l) => l.toLowerCase().startsWith(`pages ${name.toLowerCase()}`))
    return m ? num(m.split(':')[1]?.replace(/\./g, '')) : 0
  }
  const freePages = vmVal('free') + vmVal('inactive') + vmVal('speculative')
  const ramTotal = round1(physBytes * BYTES_TO_GB)
  const ramUsed = round1(Math.max(0, physBytes - freePages * pageSize) * BYTES_TO_GB)

  // vm.swapusage: «total = 2048,00M  used = 512,00M  free = 1536,00M»
  const swapRaw = (s.SWAP ?? [])[0] ?? ''
  const swapNum = (key: string): number => {
    const m = swapRaw.match(new RegExp(`${key}\\s*=\\s*([\\d.,]+)([MGK])`, 'i'))
    if (!m) return 0
    const v = parseFloat(m[1].replace(',', '.'))
    const mul = m[2].toUpperCase() === 'G' ? 1 : m[2].toUpperCase() === 'M' ? 1 / 1024 : 1 / 1024 ** 2
    return v * mul
  }

  const n1 = parseNet(s.N1 ?? [])
  const n2 = parseNet(s.N2 ?? [])
  const { mounts, root } = parseMounts(s.MOUNTS ?? [])

  return {
    cpu,
    // Загрузку ПО ЯДРАМ на macOS из командной строки не получить — нужен системный вызов
    // host_processor_info, а он требует cgo. Отдаём пусто, а не выдуманные числа.
    cores: [],
    load: parseLoad(s.LOAD ?? []),
    ramUsed,
    ramTotal,
    cacheGb: 0,
    swapUsed: round1(swapNum('used')),
    swapTotal: round1(swapNum('total')),
    netRx: rate(n1.rx, n2.rx),
    netTx: rate(n1.tx, n2.tx),
    diskR: 0,
    diskW: 0,
    diskIoAvailable: false,
    disk: root,
    uptime: parseBoot(s.UP ?? []),
    // Датчика температуры без прав root на macOS нет; на Apple Silicon нет и SMC-пути.
    tempCpu: undefined,
    mounts,
    top: parseTop(s.TOP ?? [])
  }
}

// ── Универсальный зонд ─────────────────────────────────────────────────────────────────────────
//
// Одна команда, которая сама выбирает ветку по факту ОС. Именно одна, а не «сначала спросим
// uname, потом отправим зонд»: каждый лишний вызов execOnce — это ещё одно SSH-подключение
// со своим рукопожатием, то есть секунды на ровном месте.
//
// Ветвление через if, а НЕ через case: тела зондов содержат awk-скрипты, а `;;` внутри них
// закрыл бы ветку case раньше времени.
export function universalProbe(linuxProbe: string): string {
  return [
    'echo @@OSFAM',
    '__os=$(uname -s 2>/dev/null || echo Linux)',
    'echo "$__os"',
    `if [ "$__os" = Darwin ]; then ${DARWIN_PROBE}`,
    `elif [ "$__os" = FreeBSD ]; then ${FREEBSD_PROBE}`,
    `else ${linuxProbe}`,
    'fi'
  ].join('; ')
}

/** Какая ОС ответила на универсальный зонд. */
export function probedFamily(out: string): 'darwin' | 'freebsd' | 'linux' {
  const m = out.match(/@@OSFAM\s*\n\s*(\S+)/)
  const v = (m?.[1] ?? '').toLowerCase()
  if (v === 'darwin') return 'darwin'
  if (v.includes('bsd')) return 'freebsd'
  return 'linux'
}
