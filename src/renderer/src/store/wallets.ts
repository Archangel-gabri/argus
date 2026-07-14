import { create } from 'zustand'
import type { Wallet, WalletInput, WalletBalance } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface WalletsStore {
  wallets: Wallet[]
  balances: Record<string, WalletBalance>
  loaded: boolean
  loading: boolean
  load: () => Promise<void>
  add: (input: WalletInput) => Promise<void>
  update: (id: string, input: WalletInput) => Promise<void>
  remove: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

export const useWallets = create<WalletsStore>((set, get) => ({
  wallets: [],
  balances: {},
  loaded: !api,
  loading: false,

  load: async () => {
    if (!api) {
      set({ loaded: true })
      return
    }
    const wallets = await api.wallets.list()
    set({ wallets, loaded: true })
    get().refresh()
  },

  add: async (input) => {
    if (!api) return
    const w = await api.wallets.create(input)
    set({ wallets: [...get().wallets, w] })
    const bal = await api.wallets.balance(w.chain, w.address)
    set({ balances: { ...get().balances, [w.id]: bal } })
  },

  update: async (id, input) => {
    if (!api) return
    const w = await api.wallets.update(id, input)
    set({ wallets: get().wallets.map((x) => (x.id === id ? w : x)) })
    // Адрес/сеть могли поменяться → перезапросить баланс.
    const bal = await api.wallets.balance(w.chain, w.address)
    set({ balances: { ...get().balances, [w.id]: bal } })
  },

  remove: async (id) => {
    if (!api) return
    await api.wallets.remove(id)
    const b = { ...get().balances }
    delete b[id]
    set({ wallets: get().wallets.filter((w) => w.id !== id), balances: b })
  },

  refresh: async () => {
    if (!api || get().wallets.length === 0) return
    set({ loading: true })
    const entries = await Promise.all(
      get().wallets.map(async (w) => [w.id, await api.wallets.balance(w.chain, w.address)] as const)
    )
    set({ balances: Object.fromEntries(entries), loading: false })
  }
}))
