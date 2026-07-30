interface ForwardPorts {
  localPort: number
  remotePort: number
}

const BROWSER_PORTS = new Set([80, 443, 2053, 3000, 3300, 8080, 8006, 9000, 5601, 9090])
const HTTPS_PORTS = new Set([443, 2053, 8006])

export const isForwardPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535

/** Сервис на хосте сопоставляем с destination, а не с произвольно выбранным localhost-портом. */
export function forwardedRemotePorts(forwards: ForwardPorts[]): Set<number> {
  return new Set(forwards.map((forward) => forward.remotePort))
}

/** URL локального конца туннеля; тип сервиса определяет remotePort. */
export function browserUrlForForward(forward: ForwardPorts): string | null {
  if (!BROWSER_PORTS.has(forward.remotePort)) return null
  const scheme = HTTPS_PORTS.has(forward.remotePort) ? 'https' : 'http'
  return `${scheme}://localhost:${forward.localPort}`
}
