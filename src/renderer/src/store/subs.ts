import { create } from 'zustand'
import type { Subscription, SubscriptionInput } from '@/types'
import { MOCK_SUBSCRIPTIONS } from '@/data/subscriptions'

const api = typeof window !== 'undefined' ? window.api : undefined

interface SubsStore {
  subs: Subscription[]
  loaded: boolean
  load: () => Promise<void>
  create: (input: SubscriptionInput) => Promise<void>
  update: (id: string, input: SubscriptionInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useSubs = create<SubsStore>((set, get) => ({
  subs: api ? [] : MOCK_SUBSCRIPTIONS,
  loaded: !api,

  load: async () => {
    if (!api) {
      set({ subs: MOCK_SUBSCRIPTIONS, loaded: true })
      return
    }
    set({ subs: await api.subs.list(), loaded: true })
  },

  create: async (input) => {
    if (!api) return
    const sub = await api.subs.create(input)
    set({ subs: [...get().subs, sub] })
  },

  update: async (id, input) => {
    if (!api) return
    const sub = await api.subs.update(id, input)
    set({ subs: get().subs.map((s) => (s.id === id ? sub : s)) })
  },

  remove: async (id) => {
    if (!api) return
    await api.subs.remove(id)
    set({ subs: get().subs.filter((s) => s.id !== id) })
  }
}))
