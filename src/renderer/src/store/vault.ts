import { create } from 'zustand'
import type { VaultStatus } from '@/types'
import { activateSession } from './session-lifetime'
import { resetRendererSession } from './reset-session'

const api = typeof window !== 'undefined' ? window.api : undefined
let operationEpoch = 0
let pendingOperation: number | null = null
let refreshSequence = 0
let lockUnconfirmed = false
const LOCK_UNCONFIRMED = 'Не удалось подтвердить блокировку хранилища'
if (!api && import.meta.env.DEV) activateSession()

function beginOperation(): number {
  const epoch = ++operationEpoch
  pendingOperation = epoch
  return epoch
}

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

/** One status boundary owns invalidation; App effects are deliberately not reset owners. */
function publishState(set: (patch: Partial<VaultStore>) => void, patch: Partial<VaultStore> & { status: VaultStatus }): void {
  if (patch.status === 'unlocked') activateSession()
  else resetRendererSession()
  set(patch)
}

export const useVault = create<VaultStore>((set, get) => ({
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
    // An observation is not an auth/lock acknowledgement. Do not publish an intermediate
    // main state while a mutation is pending, or let refresh supersede that mutation.
    if (!api || pendingOperation !== null) return
    const epoch = operationEpoch
    const request = ++refreshSequence
    try {
      const s = await api.vault.state()
      if (epoch !== operationEpoch || request !== refreshSequence) return
      // LockScreen mounts and refreshes immediately after concealment. An unlocked main
      // response is NOT permission to undo a lock whose acknowledgement was lost.
      if (lockUnconfirmed && s.status === 'unlocked') {
        publishState(set, { status: 'locked', error: LOCK_UNCONFIRMED })
        return
      }
      lockUnconfirmed = false
      publishState(set, { status: s.status, keyringBackend: s.keyringBackend, canRemember: s.canRemember, error: null })
    } catch {
      if (epoch === operationEpoch && request === refreshSequence) {
        publishState(set, { status: 'locked', error: 'Не удалось проверить состояние хранилища' })
      }
    }
  },

  initialize: async (password) => {
    if (!api) {
      const preview = import.meta.env.DEV
      publishState(set, { status: preview ? 'unlocked' : 'locked', error: preview ? null : 'Нет связи с приложением' })
      return preview
    }
    const epoch = beginOperation()
    set({ busy: true, error: null })
    try {
      if (lockUnconfirmed) {
        const reconciled = await api.vault.lock()
        if (epoch !== operationEpoch) return false
        lockUnconfirmed = reconciled.status === 'unlocked'
        if (reconciled.status !== 'uninitialized') {
          publishState(set, { status: 'locked', error: lockUnconfirmed ? LOCK_UNCONFIRMED : 'Хранилище уже создано. Введи мастер-пароль' })
          return false
        }
      }
      const r = await api.vault.initialize(password)
      if (epoch !== operationEpoch) return false
      const opened = r.ok && r.state.status === 'unlocked'
      lockUnconfirmed = !opened && r.state.status === 'unlocked'
      publishState(set, {
        status: opened ? 'unlocked' : r.state.status === 'uninitialized' ? 'uninitialized' : 'locked',
        keyringBackend: r.state.keyringBackend,
        canRemember: r.state.canRemember,
        error: opened ? null : r.error ?? 'Не удалось открыть хранилище'
      })
      return opened
    } catch {
      // Не показываем сырой IPC exception из операции с паролем.
      if (epoch === operationEpoch) {
        // Rejection does not prove that main did not create/open the vault: the reply
        // itself may have been lost. Never expose that state via refresh or a retry.
        lockUnconfirmed = true
        publishState(set, {
          status: get().status === 'uninitialized' ? 'uninitialized' : 'locked',
          error: 'Не удалось открыть хранилище'
        })
      }
      return false
    } finally {
      if (epoch === operationEpoch) {
        pendingOperation = null
        set({ busy: false })
      }
    }
  },

  unlock: async (password) => {
    if (!api) {
      const preview = import.meta.env.DEV
      publishState(set, { status: preview ? 'unlocked' : 'locked', error: preview ? null : 'Нет связи с приложением' })
      return preview
    }
    const epoch = beginOperation()
    set({ busy: true, error: null })
    try {
      if (lockUnconfirmed) {
        // main may still be unlocked and could short-circuit password validation. First
        // obtain an actual lock acknowledgement, then allow the normal password path.
        const locked = await api.vault.lock()
        if (epoch !== operationEpoch) return false
        if (locked.status === 'unlocked') {
          publishState(set, { status: 'locked', error: LOCK_UNCONFIRMED })
          return false
        }
        lockUnconfirmed = false
      }
      const r = await api.vault.unlock(password)
      if (epoch !== operationEpoch) return false
      const opened = r.ok && r.state.status === 'unlocked'
      lockUnconfirmed = !opened && r.state.status === 'unlocked'
      publishState(set, {
        status: opened ? 'unlocked' : r.state.status === 'uninitialized' ? 'uninitialized' : 'locked',
        keyringBackend: r.state.keyringBackend,
        canRemember: r.state.canRemember,
        error: opened ? null : r.error ?? 'Не удалось открыть хранилище'
      })
      return opened
    } catch {
      if (epoch === operationEpoch) {
        lockUnconfirmed = true
        publishState(set, { status: 'locked', error: 'Не удалось открыть хранилище' })
      }
      return false
    } finally {
      if (epoch === operationEpoch) {
        pendingOperation = null
        set({ busy: false })
      }
    }
  },

  lock: async () => {
    const epoch = beginOperation()
    lockUnconfirmed = true
    publishState(set, { status: 'locked', busy: false, error: null })
    try {
      if (!api) return
      const s = await api.vault.lock()
      if (epoch !== operationEpoch) return
      lockUnconfirmed = s.status === 'unlocked'
      publishState(set, { status: lockUnconfirmed ? 'locked' : s.status, error: lockUnconfirmed ? LOCK_UNCONFIRMED : null })
    } catch {
      // Скрыть DTO в renderer можно даже без ответа main; подтверждать закрытие БД нельзя.
      if (epoch === operationEpoch) publishState(set, { status: 'locked', error: LOCK_UNCONFIRMED })
    } finally {
      if (pendingOperation === epoch) pendingOperation = null
    }
  }
}))
