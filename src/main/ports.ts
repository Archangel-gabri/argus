// Список слушающих портов сервера (agentless, read-only). `ss -H -lntup` (sudo -n → fallback
// без sudo: без прав имя процесса не видно — не ошибка). Питает вкладку «Порты» + one-click туннель.
import { execOnce } from './ssh'

export interface ListeningPort {
  proto: 'tcp' | 'udp'
  addr: string
  port: number
  process?: string
  pid?: number
  bind: 'loopback' | 'wildcard' | 'other'
}

const LIST_CMD = `sudo -n ss -H -lntup 2>/dev/null || ss -H -lntup 2>/dev/null || echo ARGUS_NO_SS`

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

export async function listListening(
  deviceId: string
): Promise<{ ok: boolean; ports: ListeningPort[]; error?: string }> {
  const r = await execOnce(deviceId, LIST_CMD)
  if (!r.ok) return { ok: false, ports: [], error: r.error }
  if (r.output.includes('ARGUS_NO_SS')) return { ok: false, ports: [], error: 'ss/netstat недоступны на хосте' }
  return { ok: true, ports: parseSs(r.output) }
}
