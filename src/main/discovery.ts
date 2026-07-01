import { execFile } from 'node:child_process'
import type { ParsedHost } from './sshconfig'

/** Enumerate the tailnet locally via `tailscale status --json` (zero creds). Returns [] if unavailable. */
export function discoverTailscale(): Promise<ParsedHost[]> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }
      try {
        const data = JSON.parse(stdout) as {
          Self?: Record<string, unknown>
          Peer?: Record<string, Record<string, unknown>>
        }
        const peers = data.Peer ? Object.values(data.Peer) : []
        const all = [...(data.Self ? [data.Self] : []), ...peers]
        const hosts: ParsedHost[] = all
          .filter((p) => p && p.HostName)
          .map((p) => {
            const ips = (p.TailscaleIPs as string[] | undefined) || []
            const dns = ((p.DNSName as string | undefined) || '').replace(/\.$/, '')
            return {
              name: String(p.HostName),
              host: ips[0] || dns || String(p.HostName),
              user: 'root',
              port: 22
            }
          })
        resolve(hosts)
      } catch {
        resolve([])
      }
    })
  })
}
