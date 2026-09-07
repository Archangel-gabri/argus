import { create } from 'zustand'
import type { VaultStatus } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined
let operationEpoch = 0
let lockUnconfirmed = false
const LOCK_UNCONFIRMED = 'Не удалось подтвердить блокировку хранилища'

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
  // Превью в браузере — только при разработке. В собранном приложении отсутствие `window.api`
  // означает, что preload не поднялся; притворяться в этом случае «открытым» нельзя. Раньше
  // ветка не была ограничена сборкой, и любой сбой моста (contextBridge глотает ошибку в
  // console.error) открывал приложение БЕЗ запроса мастер-пароля и с выдуманными данными.
  status: api || !import.meta.env.DEV ? 'locked' : 'unlocked',
  keyringBackend: api ? 'unknown' : 'browser-preview',
  canRemember: false,
  busy: false,
  error: null,

  refresh: async () => {
    if (!api) return
    const epoch = operationEpoch
    try {
      const s = await api.vault.state()
      if (epoch !== operationEpoch) return
      // LockScreen mounts and refreshes immediately after concealment. An unlocked main
      // response is NOT permission to undo a lock whose acknowledgement was lost.
      if (lockUnconfirmed && s.status === 'unlocked') {
        set({ status: 'locked', error: LOCK_UNCONFIRMED })
        return
      }
      lockUnconfirmed = false
      set({ status: s.status, keyringBackend: s.keyringBackend, canRemember: s.canRemember, error: null })
    } catch {
      if (epoch === operationEpoch) set({ status: 'locked', error: 'Не удалось проверить состояние хранилища' })
    }
  },

  initialize: async (password) => {
    if (!api) {
      set({ status: 'unlocked' })
      return true
    }
    const epoch = ++operationEpoch
    set({ busy: true, error: null })
    try {
      if (lockUnconfirmed) {
        const reconciled = await api.vault.lock()
        if (epoch !== operationEpoch) return false
        lockUnconfirmed = reconciled.status === 'unlocked'
        if (reconciled.status !== 'uninitialized') {
          set({ status: 'locked', error: lockUnconfirmed ? LOCK_UNCONFIRMED : 'Хранилище уже создано. Введи мастер-пароль' })
          return false
        }
      }
      const r = await api.vault.initialize(password)
      if (epoch !== operationEpoch) return false
      if (r.ok) lockUnconfirmed = false
      set({
        status: r.state.status,
        keyringBackend: r.state.keyringBackend,
        canRemember: r.state.canRemember,
        error: r.ok ? null : r.error ?? 'Не удалось открыть хранилище'
      })
      return r.ok
    } catch {
      // Не показываем сырой IPC exception из операции с паролем.
      if (epoch === operationEpoch) {
        // Rejection does not prove that main did not create/open the vault: the reply
        // itself may have been lost. Never expose that state via refresh or a retry.
        lockUnconfirmed = true
        set((current) => ({
          status: current.status === 'uninitialized' ? 'uninitialized' : 'locked',
          error: 'Не удалось открыть хранилище'
        }))
      }
      return false
    } finally {
      if (epoch === operationEpoch) set({ busy: false })
    }
  },

  unlock: async (password) => {
    if (!api) {
      set({ status: 'unlocked' })
      return true
    }
    const epoch = ++operationEpoch
    set({ busy: true, error: null })
    try {
      if (lockUnconfirmed) {
        // main may still be unlocked and could short-circuit password validation. First
        // obtain an actual lock acknowledgement, then allow the normal password path.
        const locked = await api.vault.lock()
        if (epoch !== operationEpoch) return false
        if (locked.status === 'unlocked') {
          set({ status: 'locked', error: LOCK_UNCONFIRMED })
          return false
        }
        lockUnconfirmed = false
      }
      const r = await api.vault.unlock(password)
      if (epoch !== operationEpoch) return false
      set({
        status: r.state.status,
        keyringBackend: r.state.keyringBackend,
        canRemember: r.state.canRemember,
        error: r.ok ? null : r.error ?? 'Не удалось открыть хранилище'
      })
      return r.ok
    } catch {
      if (epoch === operationEpoch) {
        lockUnconfirmed = true
        set({ status: 'locked', error: 'Не удалось открыть хранилище' })
      }
      return false
    } finally {
      if (epoch === operationEpoch) set({ busy: false })
    }
  },

  lock: async () => {
    if (!api) return
    const epoch = ++operationEpoch
    lockUnconfirmed = true
    set({ status: 'locked', busy: false, error: null })
    try {
      const s = await api.vault.lock()
      if (epoch !== operationEpoch) return
      lockUnconfirmed = s.status === 'unlocked'
      set({ status: lockUnconfirmed ? 'locked' : s.status, error: lockUnconfirmed ? LOCK_UNCONFIRMED : null })
    } catch {
      // Скрыть DTO в renderer можно даже без ответа main; подтверждать закрытие БД нельзя.
      if (epoch === operationEpoch) set({ status: 'locked', error: LOCK_UNCONFIRMED })
    }
  }
}))
