export interface ParsedProbeHost {
  os: string
  hostname: string
  cores?: number
  cpu?: number
  ramTotal?: number
  ramUsed?: number
}

const finitePositive = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Разобрать маркерный POSIX-ответ или однострочный JSON Windows PowerShell. */
export function parseProbeHostOutput(out: string): ParsedProbeHost | null {
  const jsonLine = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('ARGUS_WINDOWS='))
  if (jsonLine) {
    try {
      const value = JSON.parse(jsonLine.slice('ARGUS_WINDOWS='.length)) as Record<string, unknown>
      const os = typeof value.os === 'string' ? value.os.trim() : ''
      const hostname = typeof value.hostname === 'string' ? value.hostname.trim() : ''
      if (!os || !hostname) return null
      const ramTotalMb = finitePositive(value.ramTotalMb)
      const ramFreeMb = finitePositive(value.ramFreeMb) ?? 0
      return {
        os,
        hostname,
        cores: finitePositive(value.cores),
        ramTotal: ramTotalMb ? Math.round((ramTotalMb / 1024) * 10) / 10 : undefined,
        ramUsed: ramTotalMb ? Math.round(((ramTotalMb - ramFreeMb) / 1024) * 10) / 10 : undefined
      }
    } catch {
      return null
    }
  }

  const kv: Record<string, string> = {}
  for (const line of out.split(/\r?\n/)) {
    const match = /^ARGUS_([A-Z]+)=(.*)$/.exec(line.trim())
    if (match) kv[match[1]] = match[2].trim()
  }
  if (!kv.OS || !kv.HOST) return null
  const cores = finitePositive(kv.CORES)
  const load = Number(kv.LOAD)
  const totalMb = finitePositive(kv.MEMTOTAL)
  const usedMb = finitePositive(kv.MEMUSED)
  return {
    os: kv.OS,
    hostname: kv.HOST,
    cores,
    cpu:
      cores && Number.isFinite(load)
        ? Math.min(100, Math.max(0, Math.round((load / cores) * 100)))
        : undefined,
    ramTotal: totalMb ? Math.round((totalMb / 1024) * 10) / 10 : undefined,
    ramUsed: usedMb ? Math.round((usedMb / 1024) * 10) / 10 : undefined
  }
}
