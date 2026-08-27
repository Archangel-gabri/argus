import { isIP } from 'node:net'

/**
 * Можно ли отправлять этот адрес во внешний гео-сервис.
 *
 * Проверка была в двух местах и в двух разных редакциях: `geo.ts` знал про link-local
 * `169.254.`, а `net.ts` — нет, и именно `net.ts` стоит за IPC-каналом `net:ipLookup`.
 * То есть более строгий фильтр обходился вызовом напрямую.
 *
 * Обе редакции сравнивали строку с несколькими префиксами, а этого мало:
 *
 *   — `::ffff:10.0.0.7` — тот же приватный адрес в другой записи, ни один префикс не совпадал;
 *   — `router.corp` — вообще не адрес, а имя, и оно уезжало на публичный сервис как есть,
 *     выдавая внутренние имена машин;
 *   — `0.0.0.0/8`, multicast и зарезервированные диапазоны не проверялись.
 *
 * Поэтому здесь не список запрещённых префиксов, а разбор адреса: сначала он обязан БЫТЬ
 * адресом, потом — не принадлежать ни одному непубличному диапазону.
 */
export function isGeoResolvable(value: string): boolean {
  const s = (value || '').trim()
  if (!s || s.includes('x.x')) return false

  const kind = isIP(s)
  // Имя хоста — не адрес. Раскрывать внутренние имена наружу незачем, а гео по ним всё равно нет.
  if (kind === 0) return false
  return kind === 4 ? isPublicV4(s) : isPublicV6(s.toLowerCase())
}

function isPublicV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = p

  if (a === 0) return false // «этот» хост/сеть
  if (a === 10) return false // RFC1918
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT — сюда же Tailscale
  if (a === 192 && b === 168) return false // RFC1918
  if (a === 192 && b === 0 && p[2] === 0) return false // IETF protocol assignments
  if (a === 192 && b === 0 && p[2] === 2) return false // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast (224/4) и зарезервированное (240/4), включая broadcast
  return true
}

function isPublicV6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return false

  // IPv4-mapped и IPv4-compatible: тот же адрес, другая запись. Разворачиваем и судим как v4 —
  // именно на этом обходился прежний фильтр.
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return isPublicV4(mapped[1])

  const head = ip.split(':')[0]
  if (/^fe[89ab]/.test(head)) return false // link-local fe80::/10
  if (/^f[cd]/.test(head)) return false // unique-local fc00::/7
  if (/^ff/.test(head)) return false // multicast ff00::/8
  if (/^64:ff9b$/.test(head + ':' + ip.split(':')[1])) return false // NAT64 well-known
  return true
}

/**
 * Хост в том виде, в каком его можно подставить в URL.
 *
 * Литерал IPv6 обязан быть в квадратных скобках: без них двоеточия адреса сливаются с
 * разделителем порта, и `wss://fd00::1:47990/stream` — не адрес вовсе, `new URL` бросает
 * `Invalid URL`. Для IPv4 и имён хостов ничего не меняется.
 */
export function hostForUrl(host: string): string {
  const s = (host || '').trim()
  if (!s || s.startsWith('[')) return s
  return isIP(s) === 6 ? `[${s}]` : s
}
