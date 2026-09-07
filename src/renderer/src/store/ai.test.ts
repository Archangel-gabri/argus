import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAccess, AiAccessModel } from '@/types'

type AiApi = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
  checks: ReturnType<typeof vi.fn>
  quotas: ReturnType<typeof vi.fn>
  prices: ReturnType<typeof vi.fn>
  refreshPrices: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
  fetchModels: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  deleteModel: ReturnType<typeof vi.fn>
  usage: ReturnType<typeof vi.fn>
  collect: ReturnType<typeof vi.fn>
  setAccountSecret: ReturnType<typeof vi.fn>
  copyAccountPassword: ReturnType<typeof vi.fn>
  checkAccountKey: ReturnType<typeof vi.fn>
  importPasswords: ReturnType<typeof vi.fn>
  importPasswordsAll: ReturnType<typeof vi.fn>
}

const makeApi = (patch: Partial<AiApi> = {}): AiApi => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  check: vi.fn().mockResolvedValue({ status: 'valid' }),
  checks: vi.fn().mockResolvedValue([]),
  quotas: vi.fn().mockResolvedValue([]),
  prices: vi.fn().mockResolvedValue([]),
  refreshPrices: vi.fn().mockResolvedValue({ ok: true }),
  models: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ ok: true, total: 1, added: 1, removed: 0 }),
  setModel: vi.fn().mockResolvedValue(undefined),
  deleteModel: vi.fn().mockResolvedValue(undefined),
  usage: vi.fn().mockResolvedValue({ days: [], blocks: [], collectedAt: null }),
  collect: vi.fn().mockResolvedValue({ unpriced: [] }),
  setAccountSecret: vi.fn().mockResolvedValue(undefined),
  copyAccountPassword: vi.fn().mockResolvedValue({ ok: true }),
  checkAccountKey: vi.fn().mockResolvedValue(undefined),
  importPasswords: vi.fn().mockResolvedValue({ ok: true, imported: 1, added: 1 }),
  importPasswordsAll: vi.fn().mockResolvedValue({ ok: true, imported: 1, added: 1 }),
  ...patch
})

async function storeWith(api: AiApi) {
  vi.resetModules()
  vi.stubGlobal('window', { api: { ai: api } })
  ;(await import('./session-lifetime')).activateSession()
  return (await import('./ai')).useAi
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function conceal() {
  ;(await import('./session-lifetime')).invalidateSession()
  ;(await import('./ai')).resetAi()
}

type AiState = ReturnType<typeof import('./ai').useAi.getState>
const access = { id: 'a', hasKey: true, provider: 'openai' } as AiAccess
const model: AiAccessModel = {
  accessId: 'a', model: 'synthetic-model', favorite: false, markupPct: null,
  priceInput: null, priceOutput: null, notes: null
}
const actions: {
  name: string
  ipc: keyof AiApi
  run: (state: AiState) => Promise<unknown>
  value: unknown
  staleResult?: unknown
}[] = [
  { name: 'load', ipc: 'list', run: (s) => s.load(true), value: [access] },
  { name: 'add', ipc: 'create', run: (s) => s.add({ provider: 'openai' }), value: access, staleResult: false },
  { name: 'update', ipc: 'update', run: (s) => s.update('a', { provider: 'openai' }), value: access, staleResult: false },
  { name: 'remove', ipc: 'remove', run: (s) => s.remove('a'), value: { ok: true }, staleResult: false },
  { name: 'check', ipc: 'check', run: (s) => s.check('a'), value: { status: 'valid' } },
  { name: 'loadPrices', ipc: 'prices', run: (s) => s.loadPrices(), value: [{ model: 'old' }] },
  { name: 'refreshPrices', ipc: 'refreshPrices', run: (s) => s.refreshPrices('a'), value: { ok: true }, staleResult: false },
  { name: 'loadModels', ipc: 'models', run: (s) => s.loadModels('a'), value: [model] },
  { name: 'fetchModels', ipc: 'fetchModels', run: (s) => s.fetchModels('a'), value: { ok: true, total: 1, added: 1 }, staleResult: null },
  { name: 'setModel', ipc: 'setModel', run: (s) => s.setModel(model), value: undefined },
  { name: 'deleteModel', ipc: 'deleteModel', run: (s) => s.deleteModel('a', model.model), value: undefined },
  { name: 'loadUsage', ipc: 'usage', run: (s) => s.loadUsage(), value: { days: [{ model: 'old' }], blocks: [{ source: 'old' }], collectedAt: 1 } },
  { name: 'collect', ipc: 'collect', run: (s) => s.collect(), value: { unpriced: ['old'] } },
  { name: 'setAccountSecret', ipc: 'setAccountSecret', run: (s) => s.setAccountSecret('a', 'fixture@example.invalid', {}), value: undefined },
  { name: 'copyAccountPassword', ipc: 'copyAccountPassword', run: (s) => s.copyAccountPassword('a', 'fixture@example.invalid'), value: { ok: true }, staleResult: false },
  { name: 'checkAccountKey', ipc: 'checkAccountKey', run: (s) => s.checkAccountKey('a', 'fixture@example.invalid'), value: undefined },
  { name: 'importPasswords', ipc: 'importPasswords', run: (s) => s.importPasswords('a'), value: { ok: true, imported: 1, added: 1 }, staleResult: null },
  { name: 'importPasswordsAll', ipc: 'importPasswordsAll', run: (s) => s.importPasswordsAll(), value: { ok: true, imported: 1, added: 1 }, staleResult: null }
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI store: ошибки и незавершённые операции', () => {
  it('сбрасывает loading и показывает ошибку, если список не загрузился', async () => {
    const store = await storeWith(makeApi({ list: vi.fn().mockRejectedValue(new Error('IPC unavailable')) }))

    await store.getState().load()

    expect(store.getState()).toMatchObject({ loaded: false, loading: false, error: 'IPC unavailable' })
  })

  it('не запускает два одинаковых load одновременно', async () => {
    let resolve!: (value: unknown[]) => void
    const list = vi.fn(() => new Promise<unknown[]>((done) => (resolve = done)))
    const store = await storeWith(makeApi({ list }))

    const first = store.getState().load()
    const second = store.getState().load()
    expect(list).toHaveBeenCalledOnce()
    resolve([])
    await Promise.all([first, second])
  })

  it('всегда снимает checking и оставляет честный сетевой verdict при IPC reject', async () => {
    const store = await storeWith(makeApi({ check: vi.fn().mockRejectedValue(new Error('connection reset')) }))

    await store.getState().check('a')

    expect(store.getState().checking.a).toBe(false)
    expect(store.getState().checks.a).toEqual({
      status: 'error',
      detail: 'Проверка не выполнена: connection reset'
    })
  })

  it('не сообщает форме об успехе create, если IPC отклонил операцию', async () => {
    const store = await storeWith(makeApi({ create: vi.fn().mockRejectedValue(new Error('vault locked')) }))

    await expect(store.getState().add({ provider: 'openai', apiKey: 'test-key' })).resolves.toBe(false)
    expect(store.getState().error).toBe('vault locked')
  })
})

describe('AI store: граница сессии', () => {
  it('отбрасывает результат load сразу после invalidate', async () => {
    const pending = deferred<AiAccess[]>()
    const api = makeApi({ list: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    const operation = store.getState().load()
    ;(await import('./session-lifetime')).invalidateSession()
    const state = store.getState()
    pending.resolve([access])
    await operation
    expect(store.getState()).toEqual(state)
    expect(api.checks).not.toHaveBeenCalled()
  })

  it.each(actions)('$name не применяет старый success и не запускает follow-up IPC после lock', async (action) => {
    const pending = deferred<unknown>()
    const api = makeApi({ [action.ipc]: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    store.setState({ access: [access] })
    const operation = action.run(store.getState())
    expect(api[action.ipc]).toHaveBeenCalledOnce()
    await conceal()
    const concealed = store.getState()
    const calls = Object.values(api).map((fn) => fn.mock.calls.length)
    pending.resolve(action.value)
    expect(await operation).toEqual(action.staleResult)
    expect(store.getState()).toEqual(concealed)
    expect(Object.values(api).map((fn) => fn.mock.calls.length)).toEqual(calls)
  })

  it.each(actions.flatMap((action) => ['resolve', 'reject'].map((outcome) => ({ ...action, outcome }))))(
    '$name игнорирует старый $outcome/catch/finally после открытия новой сессии', async (action) => {
    const pending = deferred<unknown>()
    const store = await storeWith(makeApi({ [action.ipc]: vi.fn(() => pending.promise) }))
    const operation = action.run(store.getState())
    await conceal()
    ;(await import('./session-lifetime')).activateSession()
    store.setState({ loading: true, collecting: true, pricesLoading: true, checking: { a: true }, error: 'new session' })
    const current = store.getState()
    if (action.outcome === 'resolve') pending.resolve(action.value)
    else pending.reject(new Error('old session failure'))
    expect(await operation).toEqual(action.staleResult)
    expect(store.getState()).toEqual(current)
  })

  it.each(actions)('$name не делает IPC при заблокированной сессии', async (action) => {
    const api = makeApi()
    const store = await storeWith(api)
    await conceal()
    const state = store.getState()
    expect(await action.run(state)).toEqual(action.staleResult)
    expect(store.getState()).toEqual(state)
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled()
  })

  it.each(actions)('$name продолжает работать в текущей активной сессии', async (action) => {
    const api = makeApi({ [action.ipc]: vi.fn().mockResolvedValue(action.value) })
    const store = await storeWith(api)
    store.setState({ access: [access] })
    const result = await action.run(store.getState())
    expect(api[action.ipc]).toHaveBeenCalled()
    if (action.staleResult === false) expect(result).toBe(true)
    else if (action.staleResult === null) expect(result).not.toBeNull()
    else expect(result).toBeUndefined()
    expect(store.getState().error).toBeNull()
  })

  it.each([
    { action: 'refreshPrices', followup: 'prices' },
    { action: 'fetchModels', followup: 'models' },
    { action: 'importPasswords', followup: 'list' },
    { action: 'importPasswordsAll', followup: 'list' },
    { action: 'collect', followup: 'usage' }
  ] as const)('$action не завершает старую форму/операцию успехом после lock внутри $followup', async ({ action: name, followup }) => {
    const action = actions.find((candidate) => candidate.name === name)!
    const pending = deferred<unknown>()
    const api = makeApi({ [followup]: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    const operation = action.run(store.getState())
    await vi.waitFor(() => expect(api[followup]).toHaveBeenCalledOnce())
    await conceal()
    ;(await import('./session-lifetime')).activateSession()
    store.setState({ pricesLoading: true, collecting: true, loading: true, error: 'new session' })
    const state = store.getState()
    pending.resolve(followup === 'usage' ? { days: [], blocks: [], collectedAt: 1 } : [])
    expect(await operation).toEqual(action.staleResult)
    expect(store.getState()).toEqual(state)
  })

  it.each(['checks', 'quotas'] as const)('load прекращает цепочку после устаревшего %s', async (ipc) => {
    const pending = deferred<unknown[]>()
    const api = makeApi({ list: vi.fn().mockResolvedValue([access]), [ipc]: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    const operation = store.getState().load()
    await vi.waitFor(() => expect(api[ipc]).toHaveBeenCalledOnce())
    await conceal()
    const state = store.getState()
    const calls = Object.values(api).map((fn) => fn.mock.calls.length)
    pending.resolve([{ accessId: 'a', status: 'valid', lastOkAt: 1 }])
    await operation
    expect(store.getState()).toEqual(state)
    expect(Object.values(api).map((fn) => fn.mock.calls.length)).toEqual(calls)
  })

  it.each(['checks', 'quotas'] as const)('load не продолжает IPC после устаревшего reject %s', async (ipc) => {
    const pending = deferred<unknown[]>()
    const api = makeApi({ list: vi.fn().mockResolvedValue([access]), [ipc]: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    const operation = store.getState().load()
    await vi.waitFor(() => expect(api[ipc]).toHaveBeenCalledOnce())
    await conceal()
    const calls = Object.values(api).map((fn) => fn.mock.calls.length)
    pending.reject(new Error('old saved data unavailable'))
    await operation
    expect(Object.values(api).map((fn) => fn.mock.calls.length)).toEqual(calls)
    expect(store.getState()).toMatchObject({ loading: false, access: [], checks: {}, quotas: {}, error: null })
  })

  it('reset очищает все DTO, timestamp, verdict и busy maps', async () => {
    const store = await storeWith(makeApi())
    store.setState({
      access: [access], checks: { a: { status: 'valid' } }, lastOk: { a: 1 }, quotas: { a: [] },
      prices: [{ model: 'old' }] as AiState['prices'], models: { a: [model] },
      usage: [{ model: 'old' }] as AiState['usage'], blocks: [{ source: 'old' }] as AiState['blocks'],
      usageCollectedAt: 1, unpriced: ['old'], loaded: true, loading: true, collecting: true,
      pricesLoading: true, checking: { a: true }, error: 'old'
    })
    await conceal()
    expect(store.getState().models).toEqual({})
    expect(store.getState()).toMatchObject({
      access: [], checks: {}, lastOk: {}, quotas: {}, prices: [], models: {}, usage: [], blocks: [],
      usageCollectedAt: null, unpriced: [], loaded: false, loading: false, collecting: false,
      pricesLoading: false, checking: {}, error: null
    })
  })

  it('поздний check не очищает checking свежего запроса того же id', async () => {
    const old = deferred<unknown>()
    const current = deferred<unknown>()
    const api = makeApi({ check: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise) })
    const store = await storeWith(api)
    const first = store.getState().check('a')
    await conceal()
    ;(await import('./session-lifetime')).activateSession()
    const second = store.getState().check('a')
    old.resolve({ status: 'invalid' })
    await first
    expect(store.getState()).toMatchObject({ checking: { a: true }, checks: {} })
    current.resolve({ status: 'valid' })
    await second
    expect(store.getState()).toMatchObject({ checking: { a: false }, checks: { a: { status: 'valid' } } })
  })

  it.each(['resolve', 'reject'] as const)('сохраняет recheck нового ключа и его busy-state при старом %s в той же сессии', async (outcome) => {
    const old = deferred<unknown>()
    const current = deferred<unknown>()
    const api = makeApi({
      update: vi.fn().mockResolvedValue(access),
      check: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    })
    const store = await storeWith(api)
    store.setState({ access: [access] })
    const first = store.getState().check('a')
    await store.getState().update('a', { provider: 'openai', apiKey: 'synthetic-new-key' })
    if (outcome === 'resolve') old.resolve({ status: 'valid' })
    else old.reject(new Error('old key failed'))
    await first
    expect(api.check).toHaveBeenCalledTimes(2)
    expect(store.getState()).toMatchObject({ checking: { a: true }, checks: {} })
    current.resolve({ status: 'invalid' })
    await vi.waitFor(() => expect(store.getState().checks.a?.status).toBe('invalid'))
    expect(store.getState().checking.a).toBe(false)
  })
})
