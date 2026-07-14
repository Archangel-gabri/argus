import { create } from 'zustand'
import type { AiAccount, AiAccountInput, AiCheck } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface AiStore {
  accounts: AiAccount[]
  checks: Record<string, AiCheck>
  loaded: boolean
  checking: Record<string, boolean>
  load: () => Promise<void>
  add: (input: AiAccountInput) => Promise<void>
  update: (id: string, input: AiAccountInput) => Promise<void>
  remove: (id: string) => Promise<void>
  check: (id: string) => Promise<void>
}

export const useAi = create<AiStore>((set, get) => ({
  accounts: [],
  checks: {},
  loaded: !api,
  checking: {},

  load: async () => {
    if (!api) {
      set({ loaded: true })
      return
    }
    const accounts = await api.ai.list()
    set({ accounts, loaded: true })
    // Проверяем валидность/кредит в фоне — иначе после перезапуска все ключи показывались
    // «не проверено, $0», хотя они рабочие.
    for (const a of accounts) void get().check(a.id)
  },

  add: async (input) => {
    if (!api) return
    const acc = await api.ai.create(input)
    set({ accounts: [...get().accounts, acc] })
    get().check(acc.id)
  },

  update: async (id, input) => {
    if (!api) return
    const acc = await api.ai.update(id, input)
    set({ accounts: get().accounts.map((a) => (a.id === id ? acc : a)) })
    // Ключ мог поменяться → перепроверить валидность/кредит.
    get().check(id)
  },

  remove: async (id) => {
    if (!api) return
    await api.ai.remove(id)
    const checks = { ...get().checks }
    delete checks[id]
    set({ accounts: get().accounts.filter((a) => a.id !== id), checks })
  },

  check: async (id) => {
    if (!api) return
    set({ checking: { ...get().checking, [id]: true } })
    const r = await api.ai.check(id)
    set({ checks: { ...get().checks, [id]: r }, checking: { ...get().checking, [id]: false } })
  }
}))
