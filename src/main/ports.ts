// Список слушающих портов сервера (agentless, read-only). `ss -H -lntup` (sudo -n → fallback
// без sudo: без прав имя процесса не видно — не ошибка). Питает вкладку «Порты» + one-click туннель.
import { execOnce } from './ssh'
import { whichOs } from './pc'

export interface ListeningPort {
  proto: 'tcp' | 'udp'
  addr: string
  port: number
  process?: string
  pid?: number
  bind: 'loopback' | 'wildcard' | 'other'
}

// `ss` есть только в Linux. На FreeBSD слушающие сокеты показывает sockstat (обычно без root),
// на macOS — lsof.
//
// Команда сама выбирает инструмент по `uname -s`, одним заходом: каждый лишний вызов — это
// отдельное SSH-подключение со своим рукопожатием.
//
// На macOS берём МАШИНОЧИТАЕМЫЙ вывод lsof (`-F`), а не колоночный. Причина не в красоте:
// в колонке COMMAND у macOS живут имена с пробелами («Google Chrome», «Adobe Desktop Service»),
// и разбор по позициям на них разъезжается. В режиме `-F` каждое поле идёт своей строкой
// с однобуквенным префиксом — разъезжаться нечему. Два вызова, потому что состояние LISTEN
// есть только у TCP, а UDP-сокеты слушают самим фактом привязки.
const DARWIN_PORTS =
  `{ sudo -n lsof -nP -iTCP -sTCP:LISTEN -FpcnP 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN -FpcnP 2>/dev/null; ` +
  `sudo -n lsof -nP -iUDP -FpcnP 2>/dev/null || lsof -nP -iUDP -FpcnP 2>/dev/null; }`
const LIST_CMD =
  `__os=$(uname -s 2>/dev/null || echo Linux); ` +
  `if [ "$__os" = Darwin ]; then ${DARWIN_PORTS}; ` +
  `elif [ "$__os" = FreeBSD ]; then sockstat -46l 2>/dev/null || echo ARGUS_NO_SS; ` +
  `else sudo -n ss -H -lntup 2>/dev/null || ss -H -lntup 2>/dev/null || ` +
  `sockstat -46l 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN -FpcnP 2>/dev/null || echo ARGUS_NO_SS; fi`

function classifyBind(addr: string): ListeningPort['bind'] {
  if (/^(0\.0\.0\.0|\*|::|\[::\])$/.test(addr)) return 'wildcard'
  if (/^(127\.|\[?::1)/.test(addr)) return 'loopback'
  return 'other'
}

/** Разбор `ss -H -lntup`: Netid State Recv-Q Send-Q Local:Port Peer users:(("name",pid=N,fd=N)) */
export function parseSs(out: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  const seen = new Set<string>()
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length < 5) continue
    const netid = t[0]
    if (netid !== 'tcp' && netid !== 'udp') continue
    const local = t[4]
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const port = parseInt(local.slice(idx + 1), 10)
    if (!port) continue
    const addr = local.slice(0, idx).replace(/%\w+$/, '') // убрать %lo и т.п.
    const key = `${netid}/${addr}/${port}`
    if (seen.has(key)) continue
    seen.add(key)
    const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
    ports.push({
      proto: netid,
      addr,
      port,
      process: pm?.[1],
      pid: pm ? parseInt(pm[2], 10) : undefined,
      bind: classifyBind(addr)
    })
  }
  return ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

/** Собрать запись, отбросив дубли (tcp4+tcp6 на один и тот же адрес — одна строка). */
function push(ports: ListeningPort[], seen: Set<string>, p: ListeningPort): void {
  const key = `${p.proto}/${p.addr}/${p.port}`
  if (seen.has(key)) return
  seen.add(key)
  ports.push(p)
}

/** Порт — всё после ПОСЛЕДНЕГО двоеточия: в IPv6 двоеточий полно, и первое ничего не значит. */
function splitAddr(local: string): { addr: string; port: number } | null {
  const idx = local.lastIndexOf(':')
  if (idx < 0) return null
  const port = parseInt(local.slice(idx + 1), 10)
  if (!port) return null
  const addr = local
    .slice(0, idx)
    .replace(/^\[|\]$/g, '') // lsof пишет IPv6 в скобках
    .replace(/%\w+$/, '') // отбросить зону вида %lo0
  return { addr, port }
}

/**
 * FreeBSD `sockstat -46l`:
 * `USER COMMAND PID FD PROTO LOCAL ADDRESS FOREIGN ADDRESS`
 * ```
 * root  sshd  1234 4 tcp4 *:22            *:*
 * ```
 * Колонки после шестой в разных версиях отличаются (в 13+ добавили STATE), поэтому читаем
 * только первые шесть — они стабильны с незапамятных времён.
 */
export function parseSockstat(out: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  const seen = new Set<string>()
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length < 6) continue
    const proto = t[4]
    if (!/^(tcp|udp)[46]?$/.test(proto)) continue // icmp, divert и прочее нам не нужно
    const parts = splitAddr(t[5])
    if (!parts) continue
    const pid = parseInt(t[2], 10)
    push(ports, seen, {
      proto: proto.startsWith('udp') ? 'udp' : 'tcp',
      addr: parts.addr,
      port: parts.port,
      process: t[1] !== '?' ? t[1] : undefined,
      pid: Number.isFinite(pid) ? pid : undefined,
      bind: classifyBind(parts.addr)
    })
  }
  return ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

/**
 * macOS/BSD `lsof -F` — по полю на строку с однобуквенным префиксом:
 * `p` PID · `c` команда · `f` дескриптор (начало нового сокета) · `P` протокол · `n` адрес.
 * Процесс объявляется один раз, дальше идут его сокеты — поэтому pid/команду держим как
 * «текущие», пока не встретится следующий `p`.
 */
export function parseLsof(out: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  const seen = new Set<string>()
  let pid: number | undefined
  let cmd: string | undefined
  let proto: 'tcp' | 'udp' | undefined
  let name: string | undefined

  const flush = (): void => {
    if (!proto || !name) return
    // Установленные соединения (`->`) — не слушающие сокеты. У UDP так выглядит connect().
    if (!name.includes('->')) {
      const parts = splitAddr(name)
      if (parts) {
        push(ports, seen, {
          proto,
          addr: parts.addr === '*' ? '*' : parts.addr,
          port: parts.port,
          process: cmd,
          pid,
          bind: classifyBind(parts.addr)
        })
      }
    }
    proto = undefined
    name = undefined
  }

  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      flush()
      const n = parseInt(val, 10)
      pid = Number.isFinite(n) ? n : undefined
      cmd = undefined
    } else if (tag === 'c') {
      cmd = val || undefined
    } else if (tag === 'f') {
      flush() // новый дескриптор — предыдущий сокет закончился
    } else if (tag === 'P') {
      proto = val.toLowerCase() === 'udp' ? 'udp' : val.toLowerCase() === 'tcp' ? 'tcp' : undefined
    } else if (tag === 'n') {
      name = val
    }
  }
  flush()
  return ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

/**
 * Формат определяем по САМОМУ выводу, а не по тому, какой ОС мы её считаем: угадали ОС неверно —
 * получили бы пустой список, который выглядит как «портов нет», а это худшая из возможных лжи
 * в панели портов.
 */
export function parseAnyPorts(out: string): ListeningPort[] {
  const lines = out.split('\n')
  if (lines.some((l) => /^p\d+$/.test(l.trim()))) return parseLsof(out)
  if (lines.some((l) => /^\S+\s+\S+\s+\d+\s+\d+\s+(tcp|udp)[46]\s/.test(l))) return parseSockstat(out)
  return parseSs(out)
}

// ── Windows ────────────────────────────────────────────────────────────────────────────────────
// `ss` есть только в Linux, поэтому на ПК под Windows вкладка «Порты» просто отваливалась.
// Get-NetTCPConnection даёт слушающие сокеты, имя процесса добираем по PID.
const WIN_PORTS_PS =
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';` +
  `$procs=@{};Get-Process|ForEach-Object{$procs[$_.Id]=$_.ProcessName};` +
  `@(Get-NetTCPConnection -State Listen|ForEach-Object{` +
  `[ordered]@{proto='tcp';addr=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess;name=$procs[[int]$_.OwningProcess]}})+` +
  `@(Get-NetUDPEndpoint|ForEach-Object{` +
  `[ordered]@{proto='udp';addr=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess;name=$procs[[int]$_.OwningProcess]}})` +
  `|ConvertTo-Json -Compress -Depth 3`
const winPortsCmd = (): string =>
  `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WIN_PORTS_PS, 'utf16le').toString('base64')}`

interface WinPortRow {
  proto?: string
  addr?: string
  port?: number
  pid?: number
  name?: string
}

export function parseWinPorts(out: string): ListeningPort[] {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('[') || l.startsWith('{'))
  if (!line) return []
  let rows: WinPortRow[]
  try {
    const parsed: unknown = JSON.parse(line)
    rows = Array.isArray(parsed) ? (parsed as WinPortRow[]) : [parsed as WinPortRow]
  } catch {
    return []
  }
  const seen = new Set<string>()
  const ports: ListeningPort[] = []
  for (const r of rows) {
    const proto = r.proto === 'udp' ? 'udp' : 'tcp'
    const addr = String(r.addr ?? '')
    const port = Number(r.port)
    if (!port) continue
    const key = `${proto}/${addr}/${port}`
    if (seen.has(key)) continue
    seen.add(key)
    ports.push({ proto, addr, port, process: r.name || undefined, pid: r.pid || undefined, bind: classifyBind(addr) })
  }
  return ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

export async function listListening(
  deviceId: string
): Promise<{ ok: boolean; ports: ListeningPort[]; error?: string }> {
  const os = await whichOs(deviceId)
  if (os.family === 'off') return { ok: false, ports: [], error: 'устройство не в сети' }
  if (os.family === 'windows') {
    const w = await execOnce(deviceId, winPortsCmd())
    if (!w.ok) return { ok: false, ports: [], error: w.error }
    const parsed = parseWinPorts(w.output)
    return parsed.length
      ? { ok: true, ports: parsed }
      : { ok: false, ports: [], error: 'не удалось прочитать список портов Windows' }
  }
  const r = await execOnce(deviceId, LIST_CMD)
  if (!r.ok) return { ok: false, ports: [], error: r.error }
  if (r.output.includes('ARGUS_NO_SS'))
    return { ok: false, ports: [], error: 'на хосте нет ни ss, ни sockstat, ни lsof' }
  const parsed = parseAnyPorts(r.output)
  // Пустой разбор при непустом выводе — это НЕ «портов нет», это неузнанный формат.
  // Показать пустой список означало бы соврать, поэтому говорим прямо.
  if (!parsed.length && r.output.trim())
    return { ok: false, ports: [], error: 'список получен, но его формат не распознан' }
  return { ok: true, ports: parsed }
}
