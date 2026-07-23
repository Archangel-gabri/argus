// Авто-геолокация устройств: кэш ip_geo (TTL 30д, в зашифрованном vault) → ipwho.is (один IP по
// TLS, только из main) → авто-заполнение пустых country/flag/provider → событие 'devices:geo' в
// renderer. Приватность: приватные/CGNAT/Tailscale/loopback наружу НЕ уходят.
import type { WebContents } from 'electron'
import { ipLookup, type IpInfo } from './net'
import { getIpGeo, setIpGeo, applyGeoToDevice } from './vault'

/** Публичный, гео-кодируемый IP? (не RFC1918/CGNAT 100.64/8/Tailscale/loopback/link-local). */
function isPublicResolvable(ip: string): boolean {
  const s = (ip || '').trim()
  if (!s || s.includes('x.x')) return false
  return !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|::1|fe80:|fc|fd)/i.test(s)
}

// Защита от дублей: не запускаем два запроса на один IP одновременно.
const inFlight = new Set<string>()

/** Резолв гео для устройства: кэш → сеть; кладёт в кэш; заполняет пустые поля; шлёт событие. */
export async function enrichDevice(wc: WebContents, deviceId: string, ip: string): Promise<void> {
  if (!isPublicResolvable(ip)) return
  let geo = getIpGeo(ip) as unknown as IpInfo | null
  if (!geo) {
    if (inFlight.has(ip)) return
    inFlight.add(ip)
    try {
      const r = await ipLookup(ip)
      if (!r.ok) return
      geo = r
      setIpGeo(ip, r as unknown as Record<string, unknown>)
    } finally {
      inFlight.delete(ip)
    }
  }
  if (!geo) return
  const updated = applyGeoToDevice(deviceId, { country: geo.country, flag: geo.flag, provider: geo.provider })
  if (updated && !wc.isDestroyed()) wc.send('devices:geo', { device: updated })
}

/** Фоновая дозагрузка гео для устройств без страны/флага (последовательно, с паузой — щадим сервис). */
export async function enrichMissing(
  wc: WebContents,
  devices: Array<{ id: string; ip: string; country: string; flag: string }>
): Promise<void> {
  const need = devices.filter(
    (d) => isPublicResolvable(d.ip) && (!d.country?.trim() || !d.flag || d.flag === '🖥️')
  )
  for (const d of need) {
    await enrichDevice(wc, d.id, d.ip)
    await new Promise((r) => setTimeout(r, 350))
  }
}
