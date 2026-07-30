import { create } from 'zustand'
import type { VaultStatus } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface VaultStore {
  status: VaultStatus
  keyringBackend: string
  canRemember: boolean
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  initialize: (password: string) => Promise<boolean>
  unlock: (password: string) => Promise<boolean>
  lock: () => Promise<void>
}

export const useVault = create<VaultStore>((set) => ({
  // Browser fallback (no Electron API present): act unlocked so previews render.
  status: api ? 'locked' : 'unlocked',
  keyringBackend: api ? 'unknown' : 'browser-preview',
  canRemember: false,
  busy: false,
  error: null,

  refresh: async () => {
    if (!api) return
    const s = await api.vault.state()
    set({ status: s.status, keyringBackend: s.keyringBackend, canRemember: s.canRemember })
  },

  initialize: async (password) => {
    if (!api) {
      set({ status: 'unlocked' })
      return true
    }
    set({ busy: true, error: null })
    const r = await api.vault.initialize(password)
    set({
      busy: false,
      status: r.state.status,
      keyringBackend: r.state.keyringBackend,
      canRemember: r.state.canRemember,
      error: r.ok ? null : r.error ?? 'Не удалось открыть хранилище'
    })
    return r.ok
  },

  unlock: async (password) => {
    if (!api) {
      set({ status: 'unlocked' })
      return true
    }
    set({ busy: true, error: null })
    const r = await api.vault.unlock(password)
    set({
      busy: false,
      status: r.state.status,
      keyringBackend: r.state.keyringBackend,
      canRemember: r.state.canRemember,
      error: r.ok ? null : r.error ?? 'Не удалось открыть хранилище'
    })
    return r.ok
  },

  lock: async () => {
    if (!api) return
    const s = await api.vault.lock()
    set({ status: s.status })
  }
}))
