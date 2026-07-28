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
// на macOS — lsof (без root видно только свои сокеты, чужие процессы требуют прав).
const LIST_CMD =
  `sudo -n ss -H -lntup 2>/dev/null || ss -H -lntup 2>/dev/null || ` +
  `sockstat -46l 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || echo ARGUS_NO_SS`

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
  const parsed = parseSs(r.output)
  // Формат sockstat/lsof другой — разбор ss ничего не найдёт. Честно говорим об этом,
  // а не показываем пустой список как «портов нет».
  if (!parsed.length)
    return {
      ok: false,
      ports: [],
      error: 'список получен, но в формате этой ОС (sockstat/lsof) — разбор пока только для ss и Windows'
    }
  return { ok: true, ports: parsed }
}
