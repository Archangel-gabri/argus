import { create } from 'zustand'
import type { DeviceDTO, DeviceInput } from '@/types'
import { FALLBACK_DEVICES } from '@/data/mock'

const api = typeof window !== 'undefined' ? window.api : undefined

interface DevicesStore {
  devices: DeviceDTO[]
  loaded: boolean
  load: () => Promise<void>
  create: (input: DeviceInput) => Promise<{ ok: boolean; error?: string }>
  update: (id: string, input: DeviceInput) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  updateMetrics: (
    id: string,
    m: {
      cpu?: number
      ramUsed?: number
      ramTotal?: number
      status?: DeviceDTO['status']
      disk?: number
      uptime?: number
    }
  ) => void
  refreshMetrics: () => Promise<void>
  refreshOsStatus: () => Promise<void>
  refreshOne: (deviceId: string) => Promise<void>
}

export const useDevices = create<DevicesStore>((set, get) => ({
  devices: api ? [] : FALLBACK_DEVICES,
  loaded: !api,

  load: async () => {
    if (!api) {
      set({ devices: FALLBACK_DEVICES, loaded: true })
      return
    }
    const list = await api.devices.list()
    set({ devices: list, loaded: true })
    get().refreshOsStatus()
  },

  create: async (input) => {
    if (!api) return { ok: false, error: 'preview mode' }
    const r = await api.devices.create(input)
    if (r.ok && r.device) set({ devices: [...get().devices, r.device] })
    return { ok: r.ok, error: r.error }
  },

  update: async (id, input) => {
    if (!api) return { ok: false, error: 'preview mode' }
    const r = await api.devices.update(id, input)
    if (r.ok && r.device) {
      const updated = r.device
      set({ devices: get().devices.map((d) => (d.id === id ? updated : d)) })
    }
    return { ok: r.ok, error: r.error }
  },

  remove: async (id) => {
    if (!api) {
      set({ devices: get().devices.filter((d) => d.id !== id) })
      return { ok: true }
    }
    // Убираем из UI ТОЛЬКО если удаление в vault реально прошло — иначе устройство «исчезало»
    // из списка, оставаясь в базе (провалившееся удаление выглядело как успех).
    const r = await api.devices.remove(id)
    if (r?.ok) set({ devices: get().devices.filter((d) => d.id !== id) })
    return { ok: !!r?.ok, error: r?.error }
  },

  updateMetrics: (id, m) =>
    set({
      devices: get().devices.map((d) =>
        d.id === id
          ? {
              ...d,
              cpu: m.cpu ?? d.cpu,
              ram: { used: m.ramUsed ?? d.ram.used, total: m.ramTotal ?? d.ram.total },
              status: m.status ?? d.status,
              disk: m.disk ?? d.disk,
              uptime: m.uptime ?? d.uptime
            }
          : d
      )
    }),

  // Agentless: probe only devices that have a real host + stored credential.
  // Dual-boot ПК (alt) обрабатываются через refreshOsStatus (у них живой может быть Windows-эндпоинт).
  refreshMetrics: async () => {
    if (!api) return
    const eligible = get().devices.filter((d) => d.hasSecret && !d.ip.includes('x.x') && d.altOs.length === 0)
    await Promise.all(
      eligible.map(async (d) => {
        const r = await api.ssh.probe(d.id)
        get().updateMetrics(d.id, r.ok ? r : { status: 'offline' })
      })
    )
    get().refreshOsStatus()
  },

  // Dual-boot: живая ОС + метрики этой ОS (OS-aware) → статус + runningOs + cpu/ram/disk/uptime.
  refreshOsStatus: async () => {
    if (!api) return
    const pcs = get().devices.filter((d) => d.altOs.length > 0)
    await Promise.all(
      pcs.map(async (d) => {
        const r = await api.pc.metrics(d.id)
        const running = r.family === 'off' ? null : r.current || (r.family === 'windows' ? 'Windows' : d.os)
        set({
          devices: get().devices.map((x) =>
            x.id === d.id
              ? {
                  ...x,
                  status: r.family === 'off' ? 'offline' : 'online',
                  runningOs: running,
                  cpu: r.cpu ?? x.cpu,
                  ram: { used: r.ramUsed ?? x.ram.used, total: r.ramTotal ?? x.ram.total },
                  disk: r.disk ?? x.disk,
                  uptime: r.uptime ?? x.uptime
                }
              : x
          )
        })
      })
    )
  },

  // Точечный опрос одного устройства (для учащённого refresh при открытой карточке).
  refreshOne: async (deviceId) => {
    if (!api) return
    const d = get().devices.find((x) => x.id === deviceId)
    if (!d || !d.hasSecret || d.ip.includes('x.x')) return
    if (d.altOs.length > 0) {
      const r = await api.pc.metrics(deviceId)
      const running = r.family === 'off' ? null : r.current || (r.family === 'windows' ? 'Windows' : d.os)
      set({
        devices: get().devices.map((x) =>
          x.id === deviceId
            ? {
                ...x,
                status: r.family === 'off' ? 'offline' : 'online',
                runningOs: running,
                cpu: r.cpu ?? x.cpu,
                ram: { used: r.ramUsed ?? x.ram.used, total: r.ramTotal ?? x.ram.total },
                disk: r.disk ?? x.disk,
                uptime: r.uptime ?? x.uptime
              }
            : x
        )
      })
    } else {
      const r = await api.ssh.probe(deviceId)
      get().updateMetrics(deviceId, r.ok ? r : { status: 'offline' })
    }
  }
}))

export function totals(devices: DeviceDTO[]): { monthly: number; yearly: number } {
  const monthly = devices.reduce((s, d) => s + d.cost.usd, 0)
  return { monthly, yearly: monthly * 12 }
}

export function spendByProvider(devices: DeviceDTO[]): { provider: string; usd: number }[] {
  const m = devices.reduce<Record<string, number>>((acc, d) => {
    acc[d.provider] = (acc[d.provider] ?? 0) + d.cost.usd
    return acc
  }, {})
  // Только реальные траты — паспорт-устройства (Home/Samsung/…) с нулевой ценой не в разбивке.
  return Object.entries(m)
    .filter(([, usd]) => usd > 0)
    .map(([provider, usd]) => ({ provider, usd }))
    .sort((a, b) => b.usd - a.usd)
}
