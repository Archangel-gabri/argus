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
  return (await import('./wallets')).useWallets
}

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
