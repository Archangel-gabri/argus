import { create } from 'zustand'
import type { Subscription, SubscriptionInput } from '@/types'
import { MOCK_SUBSCRIPTIONS } from '../data/subscriptions'

const api = typeof window !== 'undefined' ? window.api : undefined

interface SubsStore {
  subs: Subscription[]
  loaded: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
  create: (input: SubscriptionInput) => Promise<boolean>
  update: (id: string, input: SubscriptionInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

export const useSubs = create<SubsStore>((set, get) => ({
  subs: api ? [] : MOCK_SUBSCRIPTIONS,
  loaded: !api,
  loading: false,
  error: null,

  load: async () => {
    if (!api) {
      set({ subs: MOCK_SUBSCRIPTIONS, loaded: true })
      return
    }
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      set({ subs: await api.subs.list(), loaded: true })
    } catch (error) {
      set({ loaded: false, error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  },

  create: async (input) => {
    if (!api) return false
    set({ error: null })
    try {
      const sub = await api.subs.create(input)
      set({ subs: [...get().subs, sub] })
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
      const sub = await api.subs.update(id, input)
      set({ subs: get().subs.map((item) => (item.id === id ? sub : item)) })
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
      const result = await api.subs.remove(id)
      if (!result.ok) throw new Error(result.error ?? 'Подписка не удалена')
      set({ subs: get().subs.filter((sub) => sub.id !== id) })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  }
}))
