import { create } from 'zustand'
import { captureSession, isSessionCurrent } from './session-lifetime'
import type {
  AiAccess,
  AiAccessInput,
  AiAccessModel,
  AiCheck,
  AiPrice,
  AiQuotaSlice,
  AiUsageBlock,
  AiUsageDay
} from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

/** Поколение записи: растёт при каждой правке, чтобы вердикт старого ключа не осел на новом. */
const generation = new Map<string, number>()
let generationSequence = 0
let checkSequence = 0
const latestCheckRequest = new Map<string, number>()

interface AiStore {
  access: AiAccess[]
  checks: Record<string, AiCheck>
  /** Когда ключ последний раз подтверждённо работал (мс). Пишется в базе, живёт между запусками. */
  lastOk: Record<string, number | null>
  /** Срезы квоты, как их назвал сам провайдер, по идентификатору доступа. */
  quotas: Record<string, AiQuotaSlice[]>
  prices: AiPrice[]
  models: Record<string, AiAccessModel[]>
  usage: AiUsageDay[]
  /** Окна лимита по источникам — под полосу «текущая сессия». */
  blocks: AiUsageBlock[]
  usageCollectedAt: number | null
  /** Модели, встреченные в логах, но отсутствующие в каталоге цен. */
  unpriced: string[]
  loaded: boolean
  loading: boolean
  collecting: boolean
  pricesLoading: boolean
  error: string | null
  checking: Record<string, boolean>
  load: (force?: boolean) => Promise<void>
  add: (input: AiAccessInput) => Promise<boolean>
  update: (id: string, input: AiAccessInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  check: (id: string) => Promise<void>
  loadPrices: () => Promise<void>
  refreshPrices: (accessId?: string) => Promise<boolean>
  loadModels: (accessId: string) => Promise<void>
  fetchModels: (accessId: string) => Promise<{ total: number; added: number; removed: number } | null>
  setModel: (model: AiAccessModel) => Promise<void>
  deleteModel: (accessId: string, model: string) => Promise<void>
  loadUsage: () => Promise<void>
  collect: () => Promise<void>
  setAccountSecret: (accessId: string, email: string, patch: { password?: string; apiKey?: string }) => Promise<void>
  copyAccountPassword: (accessId: string, email: string) => Promise<boolean>
  checkAccountKey: (accessId: string, email: string) => Promise<void>
  importPasswords: (accessId: string) => Promise<{ imported: number; added: number } | null>
  importPasswordsAll: () => Promise<{ imported: number; added: number } | null>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Операция не выполнена'

export const useAi = create<AiStore>((set, get) => ({
  access: [],
  checks: {},
  lastOk: {},
  quotas: {},
  prices: [],
  models: {},
  usage: [],
  blocks: [],
  usageCollectedAt: null,
  unpriced: [],
  loaded: !api,
  loading: false,
  collecting: false,
  pricesLoading: false,
  error: null,
  checking: {},

  load: async (force = false) => {
    const session = captureSession()
    if (session === null) return
    if (!api) {
      set({ loaded: true })
      return
    }
    if (get().loading || (get().loaded && !force)) return
    set({ loading: true, error: null })
    try {
      const access = await api.ai.list()
      if (!isSessionCurrent(session)) return
      set({ access, loaded: true })

      // Прошлые вердикты показываются сразу: пока идёт свежая проверка, честнее показать
      // «отвечал вчера», чем «не проверялся» — второе выглядит как отсутствие ключа.
      try {
        if (!isSessionCurrent(session)) return
        const saved = await api.ai.checks()
        if (!isSessionCurrent(session)) return
        const checks: Record<string, AiCheck> = {}
        const lastOk: Record<string, number | null> = {}
        for (const c of saved) {
          checks[c.accessId] = {
            status: c.status as AiCheck['status'],
            remaining: c.remaining,
            usage: c.usage,
            detail: c.detail ?? undefined
          }
          lastOk[c.accessId] = c.lastOkAt
        }
        set({ checks, lastOk })
      } catch {
        if (!isSessionCurrent(session)) return
        /* сохранённых вердиктов может не быть — это нормально для первого запуска */
      }

      try {
        if (!isSessionCurrent(session)) return
        const quotas = await api.ai.quotas()
        if (!isSessionCurrent(session)) return
        const byAccess: Record<string, AiQuotaSlice[]> = {}
        for (const q of quotas) (byAccess[q.accessId] ??= []).push(q)
        set({ quotas: byAccess })
      } catch {
        if (!isSessionCurrent(session)) return
        /* квот может не быть — это нормально */
      }

      // Проверяем в фоне, но UI до ответа оставляет «не проверено»/«—», а не выдумывает нули.
      for (const a of access) {
        if (!isSessionCurrent(session)) return
        if (a.hasKey) void get().check(a.id)
      }
      if (!isSessionCurrent(session)) return
      void get().loadUsage()
      if (!isSessionCurrent(session)) return
      void get().loadPrices()
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    } finally {
      if (isSessionCurrent(session)) set({ loading: false })
    }
  },

  add: async (input) => {
    const session = captureSession()
    if (!api || session === null) return false
    set({ error: null })
    try {
      const acc = await api.ai.create(input)
      if (!isSessionCurrent(session)) return false
      set({ access: [...get().access, acc] })
      if (!isSessionCurrent(session)) return false
      if (acc.hasKey) void get().check(acc.id)
      return true
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    const session = captureSession()
    if (!api || session === null) return false
    generation.set(id, ++generationSequence)
    set({ error: null })
    try {
      const acc = await api.ai.update(id, input)
      if (!isSessionCurrent(session)) return false
      set({ access: get().access.map((a) => (a.id === id ? acc : a)) })
      if (!isSessionCurrent(session)) return false
      // Ключ мог поменяться → перепроверить валидность/кредит.
      if (acc.hasKey) void get().check(id)
      return true
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return false
    }
  },

  remove: async (id) => {
    const session = captureSession()
    if (!api || session === null) return false
    set({ error: null })
    try {
      const result = await api.ai.remove(id)
      if (!isSessionCurrent(session)) return false
      if (!result.ok) throw new Error('Доступ не удалён')
      const checks = { ...get().checks }
      delete checks[id]
      set({ access: get().access.filter((a) => a.id !== id), checks })
      if (!isSessionCurrent(session)) return false
      // Удаление обнуляет ссылки «чем заменить» у других записей — перечитываем список,
      // иначе интерфейс продолжит показывать фолбэк на несуществующий доступ.
      void get().load(true)
      return true
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return false
    }
  },

  check: async (id) => {
    const session = captureSession()
    if (!api || session === null) return
    // Поколение записи растёт при каждой правке. Без него получалось так: ключ меняют, тут же
    // жмут «проверить», но идущая проверка СТАРОГО ключа ещё не завершилась — новая молча
    // отбрасывается защитой `checking`, а потом приходит вердикт по старому ключу и оседает
    // как результат для нового. Человек видит «ключ действителен» про ключ, которого уже нет.
    const startedAt = generation.get(id) ?? 0
    if (get().checking[id]) return
    const request = ++checkSequence
    latestCheckRequest.set(id, request)
    const ownsRequest = () => isSessionCurrent(session) && latestCheckRequest.get(id) === request
    const recheckIfEdited = () => {
      if ((generation.get(id) ?? 0) === startedAt) return false
      // Neither a verdict nor a transport error for the old key describes the edited key.
      set((state) => ({ checking: { ...state.checking, [id]: false } }))
      if (isSessionCurrent(session)) void get().check(id)
      return true
    }
    set((state) => ({ checking: { ...state.checking, [id]: true } }))
    try {
      const result = await api.ai.check(id)
      if (!ownsRequest()) return
      if (recheckIfEdited()) return
      set((state) => ({
        checks: { ...state.checks, [id]: result },
        // Отметку «работал» двигает только подтверждённо живой ключ — так же, как в базе.
        lastOk:
          result.status === 'valid' || result.status === 'quota'
            ? { ...state.lastOk, [id]: Date.now() }
            : state.lastOk
      }))
    } catch (error) {
      if (!ownsRequest()) return
      if (recheckIfEdited()) return
      set((state) => ({
        checks: {
          ...state.checks,
          [id]: { status: 'error', detail: `Проверка не выполнена: ${messageOf(error)}` }
        }
      }))
    } finally {
      if (ownsRequest()) set((state) => ({ checking: { ...state.checking, [id]: false } }))
    }
  },

  loadPrices: async () => {
    const session = captureSession()
    if (!api || session === null) return
    set({ pricesLoading: true })
    try {
      const prices = await api.ai.prices()
      if (!isSessionCurrent(session)) return
      set({ prices })
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    } finally {
      if (isSessionCurrent(session)) set({ pricesLoading: false })
    }
  },

  refreshPrices: async (accessId) => {
    const session = captureSession()
    if (!api || session === null) return false
    set({ pricesLoading: true, error: null })
    try {
      const r = await api.ai.refreshPrices(accessId)
      if (!isSessionCurrent(session)) return false
      await get().loadPrices()
      if (!isSessionCurrent(session)) return false
      // Каталог мог обновиться частично: вшитый снапшот залился, а сеть не ответила. Молчать
      // об этом нельзя — иначе «обновил цены» будет означать разное в разные дни.
      if (!r.ok) set({ error: `Живые цены не обновились: ${r.error ?? 'неизвестно'}` })
      return r.ok
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return false
    } finally {
      if (isSessionCurrent(session)) set({ pricesLoading: false })
    }
  },

  loadModels: async (accessId) => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      const models = await api.ai.models(accessId)
      if (!isSessionCurrent(session)) return
      set((state) => ({ models: { ...state.models, [accessId]: models } }))
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  fetchModels: async (accessId) => {
    const session = captureSession()
    if (!api || session === null) return null
    set({ error: null })
    try {
      const r = await api.ai.fetchModels(accessId)
      if (!isSessionCurrent(session)) return null
      if (!r.ok) {
        set({ error: r.error ?? 'Список моделей не обновлён' })
        return null
      }
      await get().loadModels(accessId)
      if (!isSessionCurrent(session)) return null
      return { total: r.total ?? 0, added: r.added, removed: r.removed ?? 0 }
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return null
    }
  },

  setModel: async (model) => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      await api.ai.setModel(model)
      if (!isSessionCurrent(session)) return
      await get().loadModels(model.accessId)
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  deleteModel: async (accessId, model) => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      await api.ai.deleteModel(accessId, model)
      if (!isSessionCurrent(session)) return
      await get().loadModels(accessId)
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  loadUsage: async () => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      const r = await api.ai.usage()
      if (!isSessionCurrent(session)) return
      set({ usage: r.days, blocks: r.blocks ?? [], usageCollectedAt: r.collectedAt })
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  setAccountSecret: async (accessId, email, patch) => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      await api.ai.setAccountSecret(accessId, email, patch)
      if (!isSessionCurrent(session)) return
      await get().load(true)
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  copyAccountPassword: async (accessId, email) => {
    const session = captureSession()
    if (!api || session === null) return false
    try {
      const r = await api.ai.copyAccountPassword(accessId, email)
      if (!isSessionCurrent(session)) return false
      if (!r.ok) set({ error: r.error ?? 'Пароль не скопирован' })
      return r.ok
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return false
    }
  },

  checkAccountKey: async (accessId, email) => {
    const session = captureSession()
    if (!api || session === null) return
    try {
      await api.ai.checkAccountKey(accessId, email)
      if (!isSessionCurrent(session)) return
      await get().load(true)
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    }
  },

  importPasswords: async (accessId) => {
    const session = captureSession()
    if (!api || session === null) return null
    set({ error: null })
    try {
      const r = await api.ai.importPasswords(accessId)
      if (!isSessionCurrent(session)) return null
      if (!r.ok) {
        set({ error: r.error ?? 'Импорт не выполнен' })
        return null
      }
      if (r.imported === 0) set({ error: r.error ?? 'Подходящих паролей в браузере нет' })
      if (!isSessionCurrent(session)) return null
      await get().load(true)
      if (!isSessionCurrent(session)) return null
      return { imported: r.imported, added: r.added ?? 0 }
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return null
    }
  },

  importPasswordsAll: async () => {
    const session = captureSession()
    if (!api || session === null) return null
    set({ error: null })
    try {
      const r = await api.ai.importPasswordsAll()
      if (!isSessionCurrent(session)) return null
      if (!r.ok) {
        set({ error: r.error ?? 'Импорт не выполнен' })
        return null
      }
      await get().load(true)
      if (!isSessionCurrent(session)) return null
      return { imported: r.imported, added: r.added }
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
      return null
    }
  },

  collect: async () => {
    const session = captureSession()
    if (!api || session === null || get().collecting) return
    set({ collecting: true, error: null })
    try {
      const r = await api.ai.collect()
      if (!isSessionCurrent(session)) return
      set({ unpriced: r.unpriced })
      if (!isSessionCurrent(session)) return
      await get().loadUsage()
    } catch (error) {
      if (isSessionCurrent(session)) set({ error: messageOf(error) })
    } finally {
      if (isSessionCurrent(session)) set({ collecting: false })
    }
  }
}))

/** Session invalidation happens first in the reset aggregator; counters are never reused. */
export function resetAi(): void {
  generation.clear()
  latestCheckRequest.clear()
  useAi.setState({
    access: [], checks: {}, lastOk: {}, quotas: {}, prices: [], models: {},
    usage: [], blocks: [], usageCollectedAt: null, unpriced: [], loaded: !api,
    loading: false, collecting: false, pricesLoading: false, error: null, checking: {}
  })
}
