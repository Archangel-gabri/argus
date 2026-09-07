import { create } from 'zustand'
import type { Subscription, SubscriptionInput } from '@/types'
import { MOCK_SUBSCRIPTIONS } from '../data/subscriptions'
import { captureSession, isSessionCurrent } from './session-lifetime'

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
  subs: api || !import.meta.env.DEV ? [] : MOCK_SUBSCRIPTIONS,
  loaded: !api && import.meta.env.DEV,
  loading: false,
  error: null,

  load: async () => {
    const ticket = captureSession()
    if (ticket === null) return
    if (!api) {
      set({ subs: import.meta.env.DEV ? MOCK_SUBSCRIPTIONS : [], loaded: true })
      return
    }
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const subs = await api.subs.list()
      if (!isSessionCurrent(ticket)) return
      set({ subs, loaded: true })
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ loaded: false, error: messageOf(error) })
    } finally {
      if (isSessionCurrent(ticket)) set({ loading: false })
    }
  },

  create: async (input) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    set({ error: null })
    try {
      const sub = await api.subs.create(input)
      if (!isSessionCurrent(ticket)) return false
      set({ subs: [...get().subs, sub] })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    set({ error: null })
    try {
      const sub = await api.subs.update(id, input)
      if (!isSessionCurrent(ticket)) return false
      set({ subs: get().subs.map((item) => (item.id === id ? sub : item)) })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  },

  remove: async (id) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    set({ error: null })
    try {
      const result = await api.subs.remove(id)
      if (!isSessionCurrent(ticket)) return false
      if (!result.ok) throw new Error(result.error ?? 'Подписка не удалена')
      set({ subs: get().subs.filter((sub) => sub.id !== id) })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  }
}))

export function resetSubs(): void {
  useSubs.setState({ subs: [], loaded: false, loading: false, error: null })
}
