// Авто-геолокация устройств: кэш ip_geo (TTL 30д, в зашифрованном vault) → ipwho.is (один IP по
// TLS, только из main) → авто-заполнение пустых country/flag/provider → событие 'devices:geo' в
// renderer. Приватность: приватные/CGNAT/Tailscale/loopback наружу НЕ уходят.
import type { WebContents } from 'electron'
import { ipLookup, type IpInfo } from './net'
import { getIpGeo, setIpGeo, applyGeoToDevice } from './vault'
import { isGeoResolvable } from './ip-privacy'

// Проверка «можно ли отправлять адрес наружу» живёт в ip-privacy и одна на всех: раньше их
// было две, в разных редакциях, и слабейшая стояла за IPC-каналом.
const isPublicResolvable = isGeoResolvable

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
