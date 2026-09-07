import { afterEach, describe, expect, it, vi } from 'vitest'

async function storeWith(patch: Record<string, ReturnType<typeof vi.fn>> = {}) {
  vi.resetModules()
  const state = { status: 'locked', keyringBackend: 'kwallet', canRemember: true }
  const api = {
    state: vi.fn().mockResolvedValue(state),
    initialize: vi.fn().mockResolvedValue({ ok: true, state: { ...state, status: 'unlocked' } }),
    unlock: vi.fn().mockResolvedValue({ ok: true, state: { ...state, status: 'unlocked' } }),
    lock: vi.fn().mockResolvedValue(state),
    ...patch
  }
  vi.stubGlobal('window', { api: { vault: api } })
  return { store: (await import('./vault')).useVault, api }
}

afterEach(() => vi.unstubAllGlobals())

describe('vault renderer: rejected IPC is not a successful or permanently busy operation', () => {
  it.each(['initialize', 'unlock'] as const)('%s reports failure and releases busy', async (operation) => {
    const { store } = await storeWith({ [operation]: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })
    await expect(store.getState()[operation]('synthetic-password')).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ status: 'locked', busy: false, error: 'Не удалось открыть хранилище' })
  })

  it('state refresh fails closed with an error, then a successful retry clears it', async () => {
    const { store, api } = await storeWith()
    store.setState({ status: 'unlocked' })
    api.state.mockRejectedValueOnce(new Error('IPC unavailable'))
    await expect(store.getState().refresh()).resolves.toBeUndefined()
    expect(store.getState()).toMatchObject({ status: 'locked', error: 'Не удалось проверить состояние хранилища' })
    await store.getState().refresh()
    expect(store.getState().error).toBeNull()
  })

  it('failed lock hides renderer data without pretending main acknowledged it', async () => {
    const { store } = await storeWith({ lock: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })
    store.setState({ status: 'unlocked' })
    await expect(store.getState().lock()).resolves.toBeUndefined()
    expect(store.getState()).toMatchObject({ status: 'locked', error: 'Не удалось подтвердить блокировку хранилища' })
  })

  it('LockScreen state refresh cannot undo concealment after an unacknowledged lock', async () => {
    const { store, api } = await storeWith({ lock: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })
    store.setState({ status: 'unlocked' })
    await store.getState().lock()
    api.state.mockResolvedValue({ status: 'unlocked', keyringBackend: 'kwallet', canRemember: true })
    await store.getState().refresh()
    expect(store.getState()).toMatchObject({ status: 'locked', error: 'Не удалось подтвердить блокировку хранилища' })
    await expect(store.getState().unlock('synthetic-password')).resolves.toBe(false)
    expect(api.unlock).not.toHaveBeenCalled()
    api.lock.mockResolvedValue({ status: 'locked', keyringBackend: 'kwallet', canRemember: true })
    await store.getState().unlock('synthetic-password')
    expect(store.getState()).toMatchObject({ status: 'unlocked', error: null })
  })

  it('an unlock response started before lock cannot reopen the renderer', async () => {
    let finish!: (r: unknown) => void
    const { store } = await storeWith({ unlock: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve })) })
    const pending = store.getState().unlock('synthetic-password')
    await store.getState().lock()
    finish({ ok: true, state: { status: 'unlocked', keyringBackend: 'kwallet', canRemember: true } })
    await expect(pending).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ status: 'locked', busy: false })
  })

  it('failed initialization preserves setup so the owner can retry', async () => {
    const { store } = await storeWith({ initialize: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })
    store.setState({ status: 'uninitialized' })
    await store.getState().initialize('synthetic-password')
    expect(store.getState()).toMatchObject({ status: 'uninitialized', busy: false })
  })

  it.each(['initialize', 'unlock'] as const)('lost %s acknowledgement cannot allow wrong-password retry', async (operation) => {
    let mainUnlocked = false
    const locked = { status: 'locked', keyringBackend: 'kwallet', canRemember: true }
    const { store, api } = await storeWith({
      [operation]: vi.fn().mockImplementationOnce(() => {
        mainUnlocked = true
        return Promise.reject(new Error('lost acknowledgement'))
      }),
      lock: vi.fn().mockImplementation(() => { mainUnlocked = false; return Promise.resolve(locked) })
    })
    await expect(store.getState()[operation]('valid-password')).resolves.toBe(false)
    api.state.mockImplementation(() => Promise.resolve({ ...locked, status: mainUnlocked ? 'unlocked' : 'locked' }))
    await store.getState().refresh()
    expect(store.getState().status).toBe('locked')
    api.unlock.mockImplementation((password: string) => Promise.resolve(
      mainUnlocked || password === 'valid-password'
        ? { ok: true, state: { ...locked, status: 'unlocked' } }
        : { ok: false, error: 'Invalid master password', state: locked }
    ))
    await expect(store.getState().unlock('wrong-password')).resolves.toBe(false)
    expect(api.lock).toHaveBeenCalledOnce()
    expect(store.getState().status).toBe('locked')
  })

  it('ambiguous initialize retries reconcile an existing vault instead of initializing it again', async () => {
    const { store, api } = await storeWith({ initialize: vi.fn().mockRejectedValueOnce(new Error('lost acknowledgement')) })
    store.setState({ status: 'uninitialized' })
    await store.getState().initialize('synthetic-password')
    await expect(store.getState().initialize('synthetic-password')).resolves.toBe(false)
    expect(api.lock).toHaveBeenCalledOnce()
    expect(api.initialize).toHaveBeenCalledOnce()
    expect(store.getState().status).toBe('locked')
  })

  it.each(['initialize', 'unlock'] as const)('%s still accepts acknowledged success', async (operation) => {
    const { store } = await storeWith()
    await expect(store.getState()[operation]('synthetic-password')).resolves.toBe(true)
    expect(store.getState()).toMatchObject({ status: 'unlocked', busy: false, error: null })
  })
})
