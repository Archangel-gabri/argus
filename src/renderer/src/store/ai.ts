import { create } from 'zustand'
import type { AiAccess, AiAccessInput, AiAccessModel, AiCheck, AiPrice, AiUsageBlock, AiUsageDay } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

/** Поколение записи: растёт при каждой правке, чтобы вердикт старого ключа не осел на новом. */
const generation = new Map<string, number>()

interface AiStore {
  access: AiAccess[]
  checks: Record<string, AiCheck>
  /** Когда ключ последний раз подтверждённо работал (мс). Пишется в базе, живёт между запусками. */
  lastOk: Record<string, number | null>
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
    if (!api) {
      set({ loaded: true })
      return
    }
    if (get().loading || (get().loaded && !force)) return
    set({ loading: true, error: null })
    try {
      const access = await api.ai.list()
      set({ access, loaded: true })

      // Прошлые вердикты показываются сразу: пока идёт свежая проверка, честнее показать
      // «отвечал вчера», чем «не проверялся» — второе выглядит как отсутствие ключа.
      try {
        const saved = await api.ai.checks()
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
        /* сохранённых вердиктов может не быть — это нормально для первого запуска */
      }

      // Проверяем в фоне, но UI до ответа оставляет «не проверено»/«—», а не выдумывает нули.
      for (const a of access) if (a.hasKey) void get().check(a.id)
      void get().loadUsage()
      void get().loadPrices()
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  },

  add: async (input) => {
    if (!api) return false
    set({ error: null })
    try {
      const acc = await api.ai.create(input)
      set({ access: [...get().access, acc] })
      if (acc.hasKey) void get().check(acc.id)
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  update: async (id, input) => {
    generation.set(id, (generation.get(id) ?? 0) + 1)
    if (!api) return false
    set({ error: null })
    try {
      const acc = await api.ai.update(id, input)
      set({ access: get().access.map((a) => (a.id === id ? acc : a)) })
      // Ключ мог поменяться → перепроверить валидность/кредит.
      if (acc.hasKey) void get().check(id)
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
      const result = await api.ai.remove(id)
      if (!result.ok) throw new Error('Доступ не удалён')
      const checks = { ...get().checks }
      delete checks[id]
      set({ access: get().access.filter((a) => a.id !== id), checks })
      // Удаление обнуляет ссылки «чем заменить» у других записей — перечитываем список,
      // иначе интерфейс продолжит показывать фолбэк на несуществующий доступ.
      void get().load(true)
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  check: async (id) => {
    if (!api) return
    // Поколение записи растёт при каждой правке. Без него получалось так: ключ меняют, тут же
    // жмут «проверить», но идущая проверка СТАРОГО ключа ещё не завершилась — новая молча
    // отбрасывается защитой `checking`, а потом приходит вердикт по старому ключу и оседает
    // как результат для нового. Человек видит «ключ действителен» про ключ, которого уже нет.
    const startedAt = generation.get(id) ?? 0
    if (get().checking[id]) return
    set((state) => ({ checking: { ...state.checking, [id]: true } }))
    try {
      const result = await api.ai.check(id)
      if ((generation.get(id) ?? 0) !== startedAt) {
        // Запись успели изменить, пока мы спрашивали, — этот вердикт уже не про неё.
        set((state) => ({ checking: { ...state.checking, [id]: false } }))
        void get().check(id)
        return
      }
      set((state) => ({
        checks: { ...state.checks, [id]: result },
        // Отметку «работал» двигает только подтверждённо живой ключ — так же, как в базе.
        lastOk:
          result.status === 'valid' || result.status === 'quota'
            ? { ...state.lastOk, [id]: Date.now() }
            : state.lastOk
      }))
    } catch (error) {
      set((state) => ({
        checks: {
          ...state.checks,
          [id]: { status: 'error', detail: `Проверка не выполнена: ${messageOf(error)}` }
        }
      }))
    } finally {
      set((state) => ({ checking: { ...state.checking, [id]: false } }))
    }
  },

  loadPrices: async () => {
    if (!api) return
    set({ pricesLoading: true })
    try {
      const prices = await api.ai.prices()
      set({ prices })
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ pricesLoading: false })
    }
  },

  refreshPrices: async (accessId) => {
    if (!api) return false
    set({ pricesLoading: true, error: null })
    try {
      const r = await api.ai.refreshPrices(accessId)
      await get().loadPrices()
      // Каталог мог обновиться частично: вшитый снапшот залился, а сеть не ответила. Молчать
      // об этом нельзя — иначе «обновил цены» будет означать разное в разные дни.
      if (!r.ok) set({ error: `Живые цены не обновились: ${r.error ?? 'неизвестно'}` })
      return r.ok
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    } finally {
      set({ pricesLoading: false })
    }
  },

  loadModels: async (accessId) => {
    if (!api) return
    try {
      const models = await api.ai.models(accessId)
      set((state) => ({ models: { ...state.models, [accessId]: models } }))
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  setModel: async (model) => {
    if (!api) return
    try {
      await api.ai.setModel(model)
      await get().loadModels(model.accessId)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  deleteModel: async (accessId, model) => {
    if (!api) return
    try {
      await api.ai.deleteModel(accessId, model)
      await get().loadModels(accessId)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  loadUsage: async () => {
    if (!api) return
    try {
      const r = await api.ai.usage()
      set({ usage: r.days, blocks: r.blocks ?? [], usageCollectedAt: r.collectedAt })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  setAccountSecret: async (accessId, email, patch) => {
    if (!api) return
    try {
      await api.ai.setAccountSecret(accessId, email, patch)
      await get().load(true)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  copyAccountPassword: async (accessId, email) => {
    if (!api) return false
    try {
      const r = await api.ai.copyAccountPassword(accessId, email)
      if (!r.ok) set({ error: r.error ?? 'Пароль не скопирован' })
      return r.ok
    } catch (error) {
      set({ error: messageOf(error) })
      return false
    }
  },

  checkAccountKey: async (accessId, email) => {
    if (!api) return
    try {
      await api.ai.checkAccountKey(accessId, email)
      await get().load(true)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  importPasswords: async (accessId) => {
    if (!api) return null
    set({ error: null })
    try {
      const r = await api.ai.importPasswords(accessId)
      if (!r.ok) {
        set({ error: r.error ?? 'Импорт не выполнен' })
        return null
      }
      if (r.imported === 0) set({ error: r.error ?? 'Подходящих паролей в браузере нет' })
      await get().load(true)
      return { imported: r.imported, added: r.added ?? 0 }
    } catch (error) {
      set({ error: messageOf(error) })
      return null
    }
  },

  importPasswordsAll: async () => {
    if (!api) return null
    set({ error: null })
    try {
      const r = await api.ai.importPasswordsAll()
      if (!r.ok) {
        set({ error: r.error ?? 'Импорт не выполнен' })
        return null
      }
      await get().load(true)
      return { imported: r.imported, added: r.added }
    } catch (error) {
      set({ error: messageOf(error) })
      return null
    }
  },

  collect: async () => {
    if (!api || get().collecting) return
    set({ collecting: true, error: null })
    try {
      const r = await api.ai.collect()
      set({ unpriced: r.unpriced })
      await get().loadUsage()
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ collecting: false })
    }
  }
}))
