import { create } from 'zustand'
import type { FinanceAccount, FinanceAccountInput } from '@/types'
import { captureSession, isSessionCurrent } from './session-lifetime'

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
  setCreds: (id: string, creds: { apiKey: string; secret: string; passphrase?: string }) => Promise<boolean>
  refresh: () => Promise<void>
  bankLogin: (bank: string) => Promise<void>
  /** Есть ли живой вход в кабинет банка. Ключ — идентификатор банка. */
  bankSessions: Record<string, boolean>
  /**
   * Почему у счёта не обновился остаток. Ключ — идентификатор счёта.
   *
   * Раньше провал был беззвучным: ключ зеленел, подпись обещала «обновляется само», а цифра
   * не появлялась никогда. Понять причину (ключ не принят, счёт заведён не в той валюте) из
   * приложения было нельзя.
   */
  balanceIssues: Record<string, string>
  checkBankSessions: (banks: string[]) => Promise<void>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

export const useAccounts = create<AccountsStore>((set, get) => ({
  accounts: [],
  loaded: !api,
  loading: false,
  error: null,

  load: async () => {
    const ticket = captureSession()
    if (ticket === null) return
    if (!api) {
      set({ loaded: true })
      return
    }
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const accounts = await api.accounts.list()
      if (!isSessionCurrent(ticket)) return
      set({ accounts, loaded: true })
    } catch (error) {
      // Неудачная загрузка оставляет loaded=false: пустой список и «список не загрузился» —
      // разные вещи, и второе нельзя показывать как «счетов нет».
      if (isSessionCurrent(ticket)) set({ loaded: false, error: messageOf(error) })
    } finally {
      if (isSessionCurrent(ticket)) set({ loading: false })
    }
  },

  add: async (input) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    try {
      const created = await api.accounts.create(input)
      if (!isSessionCurrent(ticket)) return false
      set({ accounts: [...get().accounts, created], error: null })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    try {
      const saved = await api.accounts.update(id, input)
      if (!isSessionCurrent(ticket)) return false
      set({ accounts: get().accounts.map((a) => (a.id === id ? saved : a)), error: null })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  },

  setCreds: async (id, creds) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    try {
      const r = await api.accounts.setCreds(id, creds)
      if (!isSessionCurrent(ticket)) return false
      if (!r.ok) {
        set({ error: r.error ?? 'Ключи не сохранены' })
        return false
      }
      // Ключи ушли в main и обратно не вернутся: перечитываем список ради признака «ключи есть».
      await get().load()
      if (!isSessionCurrent(ticket)) return false
      await get().refresh()
      return isSessionCurrent(ticket)
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  },

  bankSessions: {},
  balanceIssues: {},

  bankLogin: async (bank) => {
    const ticket = captureSession()
    if (!api || ticket === null) return
    try {
      await api.accounts.bankLogin(bank)
      if (!isSessionCurrent(ticket)) return
      // После окна входа состояние меняется, и спросить надо СРАЗУ: иначе кнопка ещё долго
      // предлагает войти туда, где уже вошли.
      await get().checkBankSessions([bank])
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
    }
  },

  // Проверка дешёвая — читается своя кука, в сеть никто не ходит. Поэтому спрашиваем при
  // открытии экрана: без этого приложение предлагало «войти в Сбер» тому, кто уже вошёл, и
  // единственным способом узнать правду было нажать и посмотреть.
  checkBankSessions: async (banks) => {
    const ticket = captureSession()
    if (!api || ticket === null || banks.length === 0) return
    try {
      const pairs = await Promise.all(
        banks.map(async (b) => [b, (await api.accounts.bankSession(b)).logged] as const)
      )
      if (!isSessionCurrent(ticket)) return
      set((s) => ({ bankSessions: { ...s.bankSessions, ...Object.fromEntries(pairs) } }))
    } catch {
      /* состояние входа неизвестно — кнопка останется в виде «войти», это безопасный исход */
    }
  },

  refresh: async () => {
    const ticket = captureSession()
    if (!api || ticket === null) return
    try {
      const r = await api.accounts.refresh()
      if (!isSessionCurrent(ticket)) return
      const issues: Record<string, string> = {}
      for (const i of r.issues ?? []) issues[i.accountId] = i.error
      const accounts = await api.accounts.list()
      if (!isSessionCurrent(ticket)) return
      set({ accounts, balanceIssues: issues })
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
    }
  },

  remove: async (id) => {
    const ticket = captureSession()
    if (!api || ticket === null) return false
    try {
      await api.accounts.remove(id)
      if (!isSessionCurrent(ticket)) return false
      set({ accounts: get().accounts.filter((a) => a.id !== id), error: null })
      return true
    } catch (error) {
      if (isSessionCurrent(ticket)) set({ error: messageOf(error) })
      return false
    }
  }
}))

export function resetAccounts(): void {
  useAccounts.setState({ accounts: [], bankSessions: {}, balanceIssues: {}, loaded: false, loading: false, error: null })
}
