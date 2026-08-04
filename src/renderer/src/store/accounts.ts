import { create } from 'zustand'
import type { FinanceAccount, FinanceAccountInput } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface AccountsStore {
  accounts: FinanceAccount[]
  loaded: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
  add: (input: FinanceAccountInput) => Promise<boolean>
  update: (id: string, input: FinanceAccountInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

export const useAccounts = create<AccountsStore>((set, get) => ({
  accounts: [],
  loaded: !api,
  loading: false,
  error: null,

  load: async () => {
    if (!api) {
      set({ loaded: true })
      return
    }
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      set({ accounts: await api.accounts.list(), loaded: true })
    } catch (error) {
      // Неудачная загрузка оставляет loaded=false: пустой список и «список не загрузился» —
      // разные вещи, и второе нельзя показывать как «счетов нет».
      set({ loaded: false, error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  },

  add: async (input) => {
    if (!api) return false
    try {
      const created = await api.accounts.create(input)
      set({ accounts: [...get().accounts, created], error: null })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    if (!api) return false
    try {
      const saved = await api.accounts.update(id, input)
      set({ accounts: get().accounts.map((a) => (a.id === id ? saved : a)), error: null })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  remove: async (id) => {
    if (!api) return false
    try {
      await api.accounts.remove(id)
      set({ accounts: get().accounts.filter((a) => a.id !== id), error: null })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  }
}))
