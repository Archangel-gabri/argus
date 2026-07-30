import { afterEach, describe, expect, it, vi } from 'vitest'

type AiApi = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
}

const makeApi = (patch: Partial<AiApi> = {}): AiApi => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  check: vi.fn().mockResolvedValue({ status: 'valid' }),
  ...patch
})

async function storeWith(api: AiApi) {
  vi.resetModules()
  vi.stubGlobal('window', { api: { ai: api } })
  return (await import('./ai')).useAi
}

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
