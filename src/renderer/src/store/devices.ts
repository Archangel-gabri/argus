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
  remove: (id: string) => Promise<void>
  updateMetrics: (
    id: string,
    m: { cpu?: number; ramUsed?: number; ramTotal?: number; status?: DeviceDTO['status'] }
  ) => void
  refreshMetrics: () => Promise<void>
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
    if (!api) return
    await api.devices.remove(id)
    set({ devices: get().devices.filter((d) => d.id !== id) })
  },

  updateMetrics: (id, m) =>
    set({
      devices: get().devices.map((d) =>
        d.id === id
          ? {
              ...d,
              cpu: m.cpu ?? d.cpu,
              ram: { used: m.ramUsed ?? d.ram.used, total: m.ramTotal ?? d.ram.total },
              status: m.status ?? d.status
            }
          : d
      )
    }),

  // Agentless: probe only devices that have a real host + stored credential.
  refreshMetrics: async () => {
    if (!api) return
    const eligible = get().devices.filter((d) => d.hasSecret && !d.ip.includes('x.x'))
    await Promise.all(
      eligible.map(async (d) => {
        const r = await api.ssh.probe(d.id)
        get().updateMetrics(d.id, r.ok ? r : { status: 'offline' })
      })
    )
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
  return Object.entries(m)
    .map(([provider, usd]) => ({ provider, usd }))
    .sort((a, b) => b.usd - a.usd)
}
