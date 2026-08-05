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
  return (await import('./subs')).useSubs
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
