import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import SSHConfig from 'ssh-config'

export interface ParsedHost {
  name: string
  host: string
  user: string
  port: number
  identityFile?: string
  proxyJump?: string
}

/** Parse ~/.ssh/config into concrete hosts (skips wildcard patterns). Resolves via ssh-config compute. */
export function parseSshConfig(): ParsedHost[] {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  let cfg: ReturnType<typeof SSHConfig.parse>
  try {
    cfg = SSHConfig.parse(raw)
  } catch {
    return []
  }

  const out: ParsedHost[] = []
  for (const line of cfg as unknown as Array<{ param?: string; value?: string | string[] }>) {
    if (line.param !== 'Host') continue
    const values = Array.isArray(line.value) ? line.value : [line.value]
    for (const host of values) {
      if (!host || host.includes('*') || host.includes('?')) continue // skip patterns
      const resolved = cfg.compute(host) as Record<string, string | string[] | undefined>
      const get = (k: string): string | undefined => {
        const v = resolved[k]
        return Array.isArray(v) ? v[0] : v
      }
      out.push({
        name: host,
        host: get('HostName') || host,
        user: get('User') || 'root',
        port: parseInt(get('Port') || '22', 10) || 22,
        identityFile: get('IdentityFile'),
        proxyJump: get('ProxyJump')
      })
    }
  }
  return out
}
