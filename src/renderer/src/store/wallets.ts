import { create } from 'zustand'
import type { Wallet, WalletInput, WalletBalance } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface WalletsStore {
  wallets: Wallet[]
  balances: Record<string, WalletBalance>
  balanceLoading: Record<string, boolean>
  balanceErrors: Record<string, string>
  loaded: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
  add: (input: WalletInput) => Promise<boolean>
  update: (id: string, input: WalletInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  refresh: () => Promise<void>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

let balanceSequence = 0
let refreshSequence = 0
const latestBalanceRequest = new Map<string, number>()

export const useWallets = create<WalletsStore>((set, get) => ({
  wallets: [],
  balances: {},
  balanceLoading: {},
  balanceErrors: {},
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
    let loaded = false
    try {
      const wallets = await api.wallets.list()
      set({ wallets, loaded: true })
      loaded = true
    } catch (error) {
      set({ loaded: false, error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
    if (loaded) await get().refresh()
  },

  add: async (input) => {
    if (!api) return false
    set({ error: null })
    try {
      const wallet = await api.wallets.create(input)
      set({ wallets: [...get().wallets, wallet] })
      await refreshWallet(wallet, set, get)
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
      const wallet = await api.wallets.update(id, input)
      set({ wallets: get().wallets.map((item) => (item.id === id ? wallet : item)) })
      // Адрес/сеть могли поменяться: новый request-id не даст старому ответу затереть этот баланс.
      await refreshWallet(wallet, set, get)
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
      const result = await api.wallets.remove(id)
      if (!result.ok) throw new Error(result.error ?? 'Кошелёк не удалён')
      latestBalanceRequest.set(id, ++balanceSequence)
      const balances = { ...get().balances }
      const balanceLoading = { ...get().balanceLoading }
      const balanceErrors = { ...get().balanceErrors }
      delete balances[id]
      delete balanceLoading[id]
      delete balanceErrors[id]
      set({ wallets: get().wallets.filter((wallet) => wallet.id !== id), balances, balanceLoading, balanceErrors })
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  refresh: async () => {
    if (!api) return
    const wallets = [...get().wallets]
    if (wallets.length === 0) return
    const request = ++refreshSequence
    set({ loading: true })
    await Promise.all(wallets.map((wallet) => refreshWallet(wallet, set, get)))
    if (request === refreshSequence) set({ loading: false })
  }
}))

type WalletSet = Parameters<typeof useWallets.setState>[0] extends never ? never : typeof useWallets.setState

async function refreshWallet(
  wallet: Wallet,
  set: WalletSet,
  get: typeof useWallets.getState
): Promise<void> {
  if (!api) return
  const request = ++balanceSequence
  latestBalanceRequest.set(wallet.id, request)
  set((state) => ({ balanceLoading: { ...state.balanceLoading, [wallet.id]: true } }))
  try {
    const balance = await api.wallets.balance(wallet.chain, wallet.address)
    if (latestBalanceRequest.get(wallet.id) !== request) return
    const current = get().wallets.find((item) => item.id === wallet.id)
    if (!current || current.chain !== wallet.chain || current.address !== wallet.address) return
    set((state) => {
      const previous = state.balances[wallet.id]
      const balanceErrors = { ...state.balanceErrors }
      if (balance.status === 'error') {
        balanceErrors[wallet.id] = balance.error ?? 'Баланс неизвестен'
        if (previous && previous.status !== 'error' && previous.native !== null)
          return { balanceErrors }
      } else {
        delete balanceErrors[wallet.id]
      }
      return { balances: { ...state.balances, [wallet.id]: balance }, balanceErrors }
    })
  } catch (error) {
    if (latestBalanceRequest.get(wallet.id) !== request) return
    const message = messageOf(error)
    set((state) => {
      const previous = state.balances[wallet.id]
      const balanceErrors = { ...state.balanceErrors, [wallet.id]: message }
      if (previous && previous.status !== 'error' && previous.native !== null) return { balanceErrors }
      return {
        balances: {
          ...state.balances,
          [wallet.id]: {
            status: 'error',
            native: null,
            symbol: wallet.chain,
            usd: null,
            error: message,
            updatedAt: Date.now()
          }
        },
        balanceErrors
      }
    })
  } finally {
    if (latestBalanceRequest.get(wallet.id) === request)
      set((state) => ({ balanceLoading: { ...state.balanceLoading, [wallet.id]: false } }))
  }
}
