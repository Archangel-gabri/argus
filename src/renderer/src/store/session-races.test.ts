import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FinanceAccount } from '@/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const synthetic = (id: string) => ({ id, hasKey: false, chain: 'ETH', address: 'synthetic', altOs: [], ip: '192.0.2.1' })
const list = () => vi.fn<() => Promise<unknown[]>>().mockResolvedValue([])

async function world() {
  vi.resetModules()
  const locked = { status: 'locked', keyringBackend: 'synthetic', canRemember: false }
  const api = {
    vault: {
      state: vi.fn().mockResolvedValue(locked), lock: vi.fn().mockResolvedValue(locked),
      unlock: vi.fn().mockResolvedValue({ ok: true, state: { ...locked, status: 'unlocked' } })
    },
    accounts: { list: list() }, subs: { list: list() },
    wallets: { list: list(), balance: vi.fn().mockResolvedValue({ status: 'ok', native: 1 }) },
    ai: {
      list: list(), checks: list(), quotas: list(), prices: list(),
      usage: vi.fn().mockResolvedValue({ days: [], blocks: [], collectedAt: 1 })
    },
    devices: { list: list(), liveness: vi.fn().mockResolvedValue({}) }
  }
  vi.stubGlobal('window', { api })
  const { useVault } = await import('./vault')
  const { useAccounts } = await import('./accounts')
  const { useSubs } = await import('./subs')
  const { useWallets } = await import('./wallets')
  const { useAi } = await import('./ai')
  const { useDevices } = await import('./devices')
  await useVault.getState().unlock('synthetic-password')
  const adapters = {
    accounts: { load: () => useAccounts.getState().load(), ids: () => useAccounts.getState().accounts.map(x => x.id),
      error: () => useAccounts.getState().error, busy: () => useAccounts.getState().loading },
    subs: { load: () => useSubs.getState().load(), ids: () => useSubs.getState().subs.map(x => x.id),
      error: () => useSubs.getState().error, busy: () => useSubs.getState().loading },
    wallets: { load: () => useWallets.getState().load(), ids: () => useWallets.getState().wallets.map(x => x.id),
      error: () => useWallets.getState().error, busy: () => useWallets.getState().loading },
    ai: { load: () => useAi.getState().load(), ids: () => useAi.getState().access.map(x => x.id),
      error: () => useAi.getState().error, busy: () => useAi.getState().loading },
    devices: { load: () => useDevices.getState().load(), ids: () => useDevices.getState().devices.map(x => x.id),
      error: () => useDevices.getState().error, busy: () => null }
  }
  return { api, adapters, vault: useVault }
}
const stores = ['accounts', 'subs', 'wallets', 'ai', 'devices'] as const
afterEach(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  vi.unstubAllGlobals()
})

describe.each(stores)('%s requests belong to one renderer session', (name) => {
  it('does not publish a late list or start follow-up IPC after lock', async () => {
    const { api, adapters, vault } = await world()
    const result = deferred<unknown[]>()
    api[name].list.mockReturnValueOnce(result.promise)
    const store = adapters[name]
    const pending = store.load()
    await vault.getState().lock()
    result.resolve([synthetic('obsolete')])
    await pending
    expect(store.ids()).toEqual([])
    expect(store.error()).toBeNull()
    expect(api.wallets.balance).not.toHaveBeenCalled()
    expect(api.ai.checks).not.toHaveBeenCalled()
    expect(api.devices.liveness).not.toHaveBeenCalled()
  })

  it('does not publish an old rejection into the concealed session', async () => {
    const { api, adapters, vault } = await world()
    const result = deferred<unknown[]>()
    api[name].list.mockReturnValueOnce(result.promise)
    const pending = adapters[name].load()
    await vault.getState().lock()
    result.reject(new Error('obsolete synthetic error'))
    await pending
    expect(adapters[name].error()).toBeNull()
    expect(adapters[name].ids()).toEqual([])
  })

  it.each(['resolve', 'reject'] as const)('old %s/finally cannot touch a newer pending load', async (settle) => {
    const { api, adapters, vault } = await world()
    const old = deferred<unknown[]>(), current = deferred<unknown[]>()
    api[name].list.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const store = adapters[name]
    const beforeLock = store.load()
    await vault.getState().lock()
    await vault.getState().unlock('synthetic-password')
    const afterUnlock = store.load()
    if (settle === 'resolve') old.resolve([synthetic('obsolete')])
    else old.reject(new Error('obsolete synthetic error'))
    await beforeLock
    expect(store.ids()).toEqual([])
    expect(store.error()).toBeNull()
    if (name !== 'devices') expect(store.busy()).toBe(true)
    current.resolve([synthetic('current')])
    await afterUnlock
    expect(store.ids()).toEqual(['current'])
    if (name !== 'devices') expect(store.busy()).toBe(false)
  })

  it('does not issue new list IPC while concealed', async () => {
    const { api, adapters, vault } = await world()
    await vault.getState().lock()
    await adapters[name].load()
    expect(api[name].list).not.toHaveBeenCalled()
  })
})

describe('account mutations and chained IPC keep their original lifetime', () => {
  const operations = ['add', 'update', 'remove', 'setCreds', 'refresh', 'bankLogin', 'checkBankSessions'] as const
  it.each(operations.flatMap(operation => (['resolve', 'reject'] as const).map(settle => ({ operation, settle }))))(
    '$operation ignores obsolete $settle without follow-up IPC', async ({ operation, settle }) => {
      const { api, vault } = await world()
      const pendingResult = deferred<unknown>()
      const mocks = Object.assign(api.accounts, {
        create: vi.fn(() => pendingResult.promise), update: vi.fn(() => pendingResult.promise),
        remove: vi.fn(() => pendingResult.promise), setCreds: vi.fn(() => pendingResult.promise),
        refresh: vi.fn(() => pendingResult.promise), bankLogin: vi.fn(() => pendingResult.promise),
        bankSession: vi.fn(() => pendingResult.promise)
      })
      const { useAccounts } = await import('./accounts')
      const actions = {
        add: () => useAccounts.getState().add({ name: 'synthetic' }),
        update: () => useAccounts.getState().update('synthetic', { name: 'synthetic' }),
        remove: () => useAccounts.getState().remove('synthetic'),
        setCreds: () => useAccounts.getState().setCreds('synthetic', { apiKey: 'synthetic', secret: 'synthetic' }),
        refresh: () => useAccounts.getState().refresh(),
        bankLogin: () => useAccounts.getState().bankLogin('synthetic'),
        checkBankSessions: () => useAccounts.getState().checkBankSessions(['synthetic'])
      }
      const pending = actions[operation]()
      await vault.getState().lock()
      if (settle === 'resolve') pendingResult.resolve({ id: 'obsolete', ok: true, logged: true, issues: [] })
      else pendingResult.reject(new Error('obsolete account error'))
      const result = await pending
      expect(useAccounts.getState()).toMatchObject({ accounts: [], bankSessions: {}, balanceIssues: {}, error: null })
      if (['add', 'update', 'remove', 'setCreds'].includes(operation)) expect(result).toBe(false)
      expect(mocks.list).not.toHaveBeenCalled()
      if (operation === 'bankLogin') expect(mocks.bankSession).not.toHaveBeenCalled()
      if (operation === 'setCreds') expect(mocks.refresh).not.toHaveBeenCalled()
    }
  )

  it('keeps acknowledged account creation, balance refresh and session flags working', async () => {
    const { api } = await world()
    const account = { id: 'current', name: 'synthetic' } as FinanceAccount
    Object.assign(api.accounts, {
      create: vi.fn().mockResolvedValue(account), refresh: vi.fn().mockResolvedValue({ issues: [] }),
      bankSession: vi.fn().mockResolvedValue({ logged: true })
    })
    api.accounts.list.mockResolvedValue([account])
    const { useAccounts } = await import('./accounts')
    await expect(useAccounts.getState().add({ name: 'synthetic' })).resolves.toBe(true)
    await useAccounts.getState().refresh()
    await useAccounts.getState().checkBankSessions(['synthetic'])
    expect(useAccounts.getState()).toMatchObject({ accounts: [account], bankSessions: { synthetic: true }, error: null })
  })

  it('does not start balance refresh after credentials reload crosses a lock', async () => {
    const { api, vault } = await world()
    const listReply = deferred<unknown[]>()
    api.accounts.list.mockReturnValueOnce(listReply.promise)
    const mocks = Object.assign(api.accounts, {
      setCreds: vi.fn().mockResolvedValue({ ok: true }), refresh: vi.fn().mockResolvedValue({ issues: [] })
    })
    const { useAccounts } = await import('./accounts')
    const pending = useAccounts.getState().setCreds('synthetic', { apiKey: 'synthetic', secret: 'synthetic' })
    await Promise.resolve()
    expect(api.accounts.list).toHaveBeenCalledOnce()
    await vault.getState().lock()
    listReply.resolve([])
    await expect(pending).resolves.toBe(false)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
