import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Subscription } from '@/types'

type SubsApi = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

const sub: Subscription = {
  id: 's1',
  name: 'VPS',
  provider: 'OVH',
  category: 'Hosting',
  amount: 12,
  currency: 'EUR',
  period: 'mo',
  nextRenewal: '2026-08-13', renewalDay: 13, deviceId: null,
  notes: null,
  manualRenewal: true
}
const makeApi = (patch: Partial<SubsApi> = {}): SubsApi => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  ...patch
})

async function storeWith(api: SubsApi) {
  vi.resetModules()
  vi.stubGlobal('window', { api: { subs: api } })
  const { activateSession } = await import('./session-lifetime')
  activateSession()
  return (await import('./subs')).useSubs
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('subscription operations cannot cross a renderer lock', () => {
  it.each(['create', 'update', 'remove'] as const)('ignores an old %s success after a new session starts', async (operation) => {
    let finish!: (value: unknown) => void
    const api = makeApi({ [operation]: vi.fn(() => new Promise(resolve => { finish = resolve })) })
    const store = await storeWith(api)
    const input = { ...sub }
    const pending = operation === 'create' ? store.getState().create(input)
      : operation === 'update' ? store.getState().update(sub.id, input) : store.getState().remove(sub.id)
    const lifetime = await import('./session-lifetime')
    lifetime.invalidateSession()
    store.setState({ subs: [sub], error: null })
    lifetime.activateSession()
    finish(operation === 'remove' ? { ok: true } : { ...sub, name: 'obsolete' })
    await expect(pending).resolves.toBe(false)
    expect(store.getState().subs).toEqual([sub])
    expect(store.getState().error).toBeNull()
  })

  it.each(['create', 'update', 'remove'] as const)('ignores an old %s rejection after reset', async (operation) => {
    let fail!: (error: Error) => void
    const api = makeApi({ [operation]: vi.fn(() => new Promise((_, reject) => { fail = reject })) })
    const store = await storeWith(api)
    const pending = operation === 'create' ? store.getState().create(sub)
      : operation === 'update' ? store.getState().update(sub.id, sub) : store.getState().remove(sub.id)
    const lifetime = await import('./session-lifetime')
    lifetime.invalidateSession()
    store.setState({ subs: [], error: null })
    fail(new Error('obsolete subscription error'))
    await expect(pending).resolves.toBe(false)
    expect(store.getState().error).toBeNull()
  })
})

describe('подписки store: честные async-результаты', () => {
  it('различает ошибку загрузки и пустой список', async () => {
    const store = await storeWith(makeApi({ list: vi.fn().mockRejectedValue(new Error('database busy')) }))
    await store.getState().load()
    expect(store.getState()).toMatchObject({ loaded: false, loading: false, error: 'database busy', subs: [] })
  })

  it('не закрывает create-сценарий ложным успехом', async () => {
    const store = await storeWith(makeApi({ create: vi.fn().mockRejectedValue(new Error('vault locked')) }))
    await expect(store.getState().create(sub)).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ subs: [], error: 'vault locked' })
  })

  it('оставляет прежнюю запись при ошибке update', async () => {
    const store = await storeWith(makeApi({ update: vi.fn().mockRejectedValue(new Error('write failed')) }))
    store.setState({ subs: [sub], loaded: true })
    await expect(store.getState().update(sub.id, { ...sub, name: 'Changed' })).resolves.toBe(false)
    expect(store.getState().subs).toEqual([sub])
  })

  it('не удаляет локально при ok=false из main', async () => {
    const store = await storeWith(makeApi({ remove: vi.fn().mockResolvedValue({ ok: false, error: 'не найдена' }) }))
    store.setState({ subs: [sub], loaded: true })
    await expect(store.getState().remove(sub.id)).resolves.toBe(false)
    expect(store.getState().subs).toEqual([sub])
  })
})
