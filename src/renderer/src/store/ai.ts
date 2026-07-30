import { create } from 'zustand'
import type { AiAccount, AiAccountInput, AiCheck } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface AiStore {
  accounts: AiAccount[]
  checks: Record<string, AiCheck>
  loaded: boolean
  loading: boolean
  error: string | null
  checking: Record<string, boolean>
  load: (force?: boolean) => Promise<void>
  add: (input: AiAccountInput) => Promise<boolean>
  update: (id: string, input: AiAccountInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  check: (id: string) => Promise<void>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

export const useAi = create<AiStore>((set, get) => ({
  accounts: [],
  checks: {},
  loaded: !api,
  loading: false,
  error: null,
  checking: {},

  load: async (force = false) => {
    if (!api) {
      set({ loaded: true })
      return
    }
    if (get().loading || (get().loaded && !force)) return
    set({ loading: true, error: null })
    try {
      const accounts = await api.ai.list()
      set({ accounts, loaded: true })
      // Проверяем в фоне, но UI до ответа оставляет «не проверено»/«—», а не выдумывает нули.
      for (const a of accounts) void get().check(a.id)
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  },

  add: async (input) => {
    if (!api) return false
    set({ error: null })
    try {
      const acc = await api.ai.create(input)
      set({ accounts: [...get().accounts, acc] })
      void get().check(acc.id)
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    if (!api) return false
    set({ error: null })
    try {
      const acc = await api.ai.update(id, input)
      set({ accounts: get().accounts.map((a) => (a.id === id ? acc : a)) })
      // Ключ мог поменяться → перепроверить валидность/кредит.
      void get().check(id)
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  remove: async (id) => {
    if (!api) return false
    set({ error: null })
    try {
      const result = await api.ai.remove(id)
      if (!result.ok) throw new Error('Аккаунт не удалён')
      const checks = { ...get().checks }
      delete checks[id]
      set({ accounts: get().accounts.filter((a) => a.id !== id), checks })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  check: async (id) => {
    if (!api) return
    if (get().checking[id]) return
    set((state) => ({ checking: { ...state.checking, [id]: true } }))
    try {
      const result = await api.ai.check(id)
      set((state) => ({ checks: { ...state.checks, [id]: result } }))
    } catch (error) {
      set((state) => ({
        checks: {
          ...state.checks,
          [id]: { status: 'error', detail: `Проверка не выполнена: ${messageOf(error)}` }
        }
      }))
    } finally {
      set((state) => ({ checking: { ...state.checking, [id]: false } }))
    }
  }
}))
