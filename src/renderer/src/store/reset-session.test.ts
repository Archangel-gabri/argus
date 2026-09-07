import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAccess, DeviceDTO, FinanceAccount, Subscription, Wallet, WalletBalance } from '@/types'

const dataOnly = (state: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== 'function'))

async function populatedSession() {
  vi.resetModules()
  const locked = { status: 'locked', keyringBackend: 'synthetic', canRemember: false }
  const api = {
    lock: vi.fn().mockResolvedValue(locked), state: vi.fn().mockResolvedValue(locked),
    unlock: vi.fn().mockResolvedValue({ ok: true, state: { ...locked, status: 'unlocked' } })
  }
  vi.stubGlobal('window', { api: { vault: api } })
  const { useVault } = await import('./vault')
  const { useDevices } = await import('./devices')
  const { useWallets } = await import('./wallets')
  const { useSubs } = await import('./subs')
  const { useAccounts } = await import('./accounts')
  const { useAi } = await import('./ai')
  const { useUI } = await import('./ui')
  const lifetime = await import('./session-lifetime')
  const snapshot = () => ({
    devices: dataOnly(useDevices.getState()), wallets: dataOnly(useWallets.getState()),
    subs: dataOnly(useSubs.getState()), accounts: dataOnly(useAccounts.getState()),
    ai: dataOnly(useAi.getState()), ui: dataOnly(useUI.getState())
  })
  useUI.setState({ view: 'ai' }) // View/preferences survive; sensitive search/dialog DTOs do not.
  const empty = snapshot()
  await useVault.getState().unlock('synthetic-password')
  const device = { id: 'synthetic' } as DeviceDTO
  useDevices.setState({ devices: [device], loaded: true, error: 'old device error' })
  useWallets.setState({ wallets: [{ id: 'synthetic' } as Wallet],
    balances: { synthetic: { status: 'ok', native: 1 } as WalletBalance },
    balanceLoading: { synthetic: true }, balanceErrors: { synthetic: 'old balance error' },
    loaded: true, loading: true, error: 'old wallet error' })
  useSubs.setState({ subs: [{ id: 'synthetic' } as Subscription], loaded: true, loading: true, error: 'old sub error' })
  useAccounts.setState({ accounts: [{ id: 'synthetic' } as FinanceAccount], bankSessions: { synthetic: true },
    balanceIssues: { synthetic: 'old account issue' }, loaded: true, loading: true, error: 'old account error' })
  useAi.setState({ access: [{ id: 'synthetic' } as AiAccess], checks: { synthetic: { status: 'valid' } },
    lastOk: { synthetic: 1 }, quotas: { synthetic: [] }, models: { synthetic: [] },
    usageCollectedAt: 1, unpriced: ['synthetic'], loaded: true, loading: true,
    collecting: true, pricesLoading: true, checking: { synthetic: true }, error: 'old AI error' })
  useUI.setState({ search: 'synthetic private search', dialog: { mode: 'edit', device },
    detail: { device, tab: 'files' }, palette: true, sshImport: 'ssh', broadcast: true })
  return { api, vault: useVault, snapshot, empty, lifetime, devices: useDevices }
}
afterEach(() => vi.unstubAllGlobals())

describe('concealment synchronously resets all renderer session state', () => {
  it('invalidates before clearing, before the main lock acknowledgement and without mounting App', async () => {
    const { api, vault, snapshot, empty, lifetime, devices } = await populatedSession()
    let finish!: (value: { status: string }) => void
    api.lock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const ticket = lifetime.captureSession()
    const observed: boolean[] = []
    const unsubscribe = devices.subscribe(() => { observed.push(lifetime.isSessionCurrent(ticket)) })
    const pending = vault.getState().lock()
    expect(lifetime.captureSession()).toBeNull()
    expect(snapshot()).toEqual(empty)
    expect(observed).toContain(false)
    expect(observed).not.toContain(true)
    finish({ status: 'locked' })
    await pending
    unsubscribe()
  })

  it('keeps stores empty after an unacknowledged lock and refuses refresh-based reopening', async () => {
    const { api, vault, snapshot, empty, lifetime } = await populatedSession()
    api.lock.mockRejectedValueOnce(new Error('synthetic lost lock reply'))
    await vault.getState().lock()
    expect(snapshot()).toEqual(empty)
    api.state.mockResolvedValueOnce({ status: 'unlocked', keyringBackend: 'synthetic', canRemember: false })
    await vault.getState().refresh()
    expect(snapshot()).toEqual(empty)
    expect(lifetime.captureSession()).toBeNull()
    expect(vault.getState().status).toBe('locked')
  })

  it('also clears stores when state refresh fails closed, not only on an explicit lock', async () => {
    const { api, vault, snapshot, empty, lifetime } = await populatedSession()
    api.state.mockRejectedValueOnce(new Error('synthetic state reply lost'))
    await vault.getState().refresh()
    expect(snapshot()).toEqual(empty)
    expect(lifetime.captureSession()).toBeNull()
  })

  it('repeated inactive refreshes do not reactivate, while a fresh unlock starts a new lifetime', async () => {
    const { vault, snapshot, empty, lifetime } = await populatedSession()
    const old = lifetime.captureSession()
    await vault.getState().lock()
    await vault.getState().refresh()
    await vault.getState().refresh() // App/LockScreen StrictMode effect replay.
    expect(snapshot()).toEqual(empty)
    expect(lifetime.captureSession()).toBeNull()
    await vault.getState().unlock('synthetic-password')
    expect(lifetime.isSessionCurrent(old)).toBe(false)
    expect(lifetime.isSessionCurrent(lifetime.captureSession())).toBe(true)
  })
})
