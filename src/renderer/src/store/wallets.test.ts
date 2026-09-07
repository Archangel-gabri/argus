import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Wallet, WalletBalance } from '@/types'

type WalletApi = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  balance: ReturnType<typeof vi.fn>
}

const wallet: Wallet = {
  id: 'w1',
  chain: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  label: 'Main'
}
const ok = (native: number): WalletBalance => ({
  status: 'ok',
  native,
  symbol: 'ETH',
  usd: native * 2_000,
  updatedAt: 1
})
const makeApi = (patch: Partial<WalletApi> = {}): WalletApi => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  balance: vi.fn().mockResolvedValue(ok(0)),
  ...patch
})

async function storeWith(api: WalletApi) {
  vi.resetModules()
  vi.stubGlobal('window', { api: { wallets: api } })
  ;(await import('./session-lifetime')).activateSession()
  return (await import('./wallets')).useWallets
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function conceal() {
  ;(await import('./session-lifetime')).invalidateSession()
  ;(await import('./wallets')).resetWallets()
}

type WalletState = ReturnType<typeof import('./wallets').useWallets.getState>
const actions: {
  name: string
  ipc: keyof WalletApi
  run: (state: WalletState) => Promise<unknown>
  value: unknown
  staleResult?: unknown
}[] = [
  { name: 'load', ipc: 'list', run: (s) => s.load(), value: [wallet] },
  { name: 'add', ipc: 'create', run: (s) => s.add(wallet), value: wallet, staleResult: false },
  { name: 'update', ipc: 'update', run: (s) => s.update(wallet.id, wallet), value: wallet, staleResult: false },
  { name: 'remove', ipc: 'remove', run: (s) => s.remove(wallet.id), value: { ok: true }, staleResult: false },
  { name: 'refresh', ipc: 'balance', run: (s) => s.refresh(), value: ok(99) }
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('кошельки store: неизвестно, ошибка и гонки', () => {
  it('не показывает ошибку загрузки как пустой список', async () => {
    const store = await storeWith(makeApi({ list: vi.fn().mockRejectedValue(new Error('vault locked')) }))
    await store.getState().load()
    expect(store.getState()).toMatchObject({ loaded: false, loading: false, error: 'vault locked', wallets: [] })
  })

  it('склеивает два одновременных load', async () => {
    let resolve!: (value: Wallet[]) => void
    const list = vi.fn(() => new Promise<Wallet[]>((done) => (resolve = done)))
    const store = await storeWith(makeApi({ list }))
    const a = store.getState().load()
    const b = store.getState().load()
    expect(list).toHaveBeenCalledOnce()
    resolve([])
    await Promise.all([a, b])
  })

  it('не сообщает форме об успехе create при IPC reject', async () => {
    const store = await storeWith(makeApi({ create: vi.fn().mockRejectedValue(new Error('duplicate wallet')) }))
    await expect(store.getState().add({ chain: wallet.chain, address: wallet.address })).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ wallets: [], error: 'duplicate wallet' })
  })

  it('хранит явную ошибку баланса, а не вечный spinner', async () => {
    const api = makeApi({
      create: vi.fn().mockResolvedValue(wallet),
      balance: vi.fn().mockRejectedValue(new Error('IPC lost'))
    })
    const store = await storeWith(api)
    await expect(store.getState().add({ chain: wallet.chain, address: wallet.address })).resolves.toBe(true)
    expect(store.getState().balances.w1).toMatchObject({ status: 'error', native: null, usd: null, error: 'IPC lost' })
    expect(store.getState().balanceLoading.w1).toBe(false)
  })

  it('поздний ответ для старого адреса не затирает баланс нового', async () => {
    let resolveOld!: (value: WalletBalance) => void
    let resolveNew!: (value: WalletBalance) => void
    const balance = vi
      .fn()
      .mockImplementationOnce(() => new Promise<WalletBalance>((done) => (resolveOld = done)))
      .mockImplementationOnce(() => new Promise<WalletBalance>((done) => (resolveNew = done)))
    const updated = { ...wallet, address: '0x1111111111111111111111111111111111111111' }
    const store = await storeWith(makeApi({ update: vi.fn().mockResolvedValue(updated), balance }))
    store.setState({ wallets: [wallet], loaded: true })

    const refresh = store.getState().refresh()
    const update = store.getState().update(wallet.id, updated)
    await Promise.resolve()
    resolveNew(ok(2))
    await update
    resolveOld(ok(1))
    await refresh

    expect(store.getState().balances.w1.native).toBe(2)
  })

  it('не удаляет строку локально, если main не нашёл запись', async () => {
    const store = await storeWith(makeApi({ remove: vi.fn().mockResolvedValue({ ok: false, error: 'не найден' }) }))
    store.setState({ wallets: [wallet], loaded: true })
    await expect(store.getState().remove(wallet.id)).resolves.toBe(false)
    expect(store.getState().wallets).toEqual([wallet])
  })
})

describe('кошельки store: граница сессии', () => {
  it('отбрасывает результат load сразу после invalidate', async () => {
    const pending = deferred<Wallet[]>()
    const api = makeApi({ list: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    const operation = store.getState().load()
    ;(await import('./session-lifetime')).invalidateSession()
    const state = store.getState()
    pending.resolve([wallet])
    await operation
    expect(store.getState()).toEqual(state)
    expect(api.balance).not.toHaveBeenCalled()
  })

  it.each(actions)('$name игнорирует старый success и не запускает follow-up balance', async (action) => {
    const pending = deferred<unknown>()
    const api = makeApi({ [action.ipc]: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    store.setState({ wallets: [wallet], loaded: true })
    const operation = action.run(store.getState())
    expect(api[action.ipc]).toHaveBeenCalledOnce()
    await conceal()
    const state = store.getState()
    const calls = Object.values(api).map((fn) => fn.mock.calls.length)
    pending.resolve(action.value)
    expect(await operation).toEqual(action.staleResult)
    expect(store.getState()).toEqual(state)
    expect(Object.values(api).map((fn) => fn.mock.calls.length)).toEqual(calls)
  })

  it.each(actions.flatMap((action) => ['resolve', 'reject'].map((outcome) => ({ ...action, outcome }))))(
    '$name не переносит старый $outcome/finally в новую сессию', async (action) => {
    const pending = deferred<unknown>()
    const store = await storeWith(makeApi({ [action.ipc]: vi.fn(() => pending.promise) }))
    store.setState({ wallets: [wallet] })
    const operation = action.run(store.getState())
    await conceal()
    ;(await import('./session-lifetime')).activateSession()
    store.setState({ wallets: [wallet], loading: true, balanceLoading: { w1: true }, error: 'new session' })
    const state = store.getState()
    if (action.outcome === 'resolve') pending.resolve(action.value)
    else pending.reject(new Error('old session failure'))
    expect(await operation).toEqual(action.staleResult)
    expect(store.getState()).toEqual(state)
  })

  it.each(actions)('$name не запускает IPC при inactive session', async (action) => {
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
    store.setState({ wallets: [wallet] })
    const result = await action.run(store.getState())
    expect(api[action.ipc]).toHaveBeenCalled()
    expect(result).toEqual(action.staleResult === false ? true : undefined)
    expect(store.getState().error).toBeNull()
  })

  it('reset очищает все кошельки, балансы, ошибки и busy flags', async () => {
    const store = await storeWith(makeApi())
    store.setState({ wallets: [wallet], balances: { w1: ok(1) }, balanceLoading: { w1: true },
      balanceErrors: { w1: 'old' }, loaded: true, loading: true, error: 'old' })
    await conceal()
    expect(store.getState()).toMatchObject({ wallets: [], balances: {}, balanceLoading: {},
      balanceErrors: {}, loaded: false, loading: false, error: null })
  })

  it.each(['resolve', 'reject'] as const)('старый balance %s не перезаписывает новый запрос того же id/address', async (outcome) => {
    const old = deferred<WalletBalance>()
    const current = deferred<WalletBalance>()
    const api = makeApi({ balance: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise) })
    const store = await storeWith(api)
    store.setState({ wallets: [wallet] })
    const first = store.getState().refresh()
    await conceal()
    ;(await import('./session-lifetime')).activateSession()
    store.setState({ wallets: [wallet] })
    const second = store.getState().refresh()
    if (outcome === 'resolve') old.resolve(ok(99))
    else old.reject(new Error('old balance failed'))
    await first
    expect(store.getState()).toMatchObject({ loading: true, balanceLoading: { w1: true }, balances: {}, balanceErrors: {} })
    current.resolve(ok(2))
    await second
    expect(store.getState()).toMatchObject({ loading: false, balanceLoading: { w1: false }, balances: { w1: ok(2) } })
  })

  it.each(['add', 'update'] as const)('%s не возвращает старый success после lock во время follow-up balance', async (name) => {
    const pending = deferred<WalletBalance>()
    const api = makeApi({ create: vi.fn().mockResolvedValue(wallet), update: vi.fn().mockResolvedValue(wallet),
      balance: vi.fn(() => pending.promise) })
    const store = await storeWith(api)
    store.setState({ wallets: [wallet] })
    const operation = name === 'add' ? store.getState().add(wallet) : store.getState().update(wallet.id, wallet)
    await vi.waitFor(() => expect(api.balance).toHaveBeenCalledOnce())
    await conceal()
    pending.resolve(ok(8))
    expect(await operation).toBe(false)
    expect(store.getState()).toMatchObject({ wallets: [], balances: {}, loading: false, balanceLoading: {} })
  })
})
