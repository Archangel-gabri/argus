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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('vault refresh belongs to the latest observation outside a mutation', () => {
  const locked = { status: 'locked', keyringBackend: 'synthetic', canRemember: false }
  const unlocked = { ...locked, status: 'unlocked' }

  it('an older refresh success cannot reopen after a newer locked refresh', async () => {
    const older = deferred<unknown>(), newer = deferred<unknown>()
    const { store } = await storeWith({ state: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) })
    const lifetime = await import('./session-lifetime')
    const first = store.getState().refresh()
    const second = store.getState().refresh()
    newer.resolve(locked)
    await second
    older.resolve(unlocked)
    await first
    expect(store.getState().status).toBe('locked')
    expect(lifetime.captureSession()).toBeNull()
  })

  it('an older refresh rejection cannot revoke a newer acknowledged active session', async () => {
    const older = deferred<unknown>(), newer = deferred<unknown>()
    const { store } = await storeWith({ state: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) })
    const lifetime = await import('./session-lifetime')
    const first = store.getState().refresh()
    const second = store.getState().refresh()
    newer.resolve(unlocked)
    await second
    const current = lifetime.captureSession()
    older.reject(new Error('synthetic old transport failure'))
    await first
    expect(store.getState()).toMatchObject({ status: 'unlocked', error: null })
    expect(lifetime.isSessionCurrent(current)).toBe(true)
  })

  it.each(['lock', 'initialize', 'unlock'] as const)('does not observe an intermediate state while %s awaits acknowledgement', async (operation) => {
    const reply = deferred<unknown>()
    const { store, api } = await storeWith({ [operation]: vi.fn().mockReturnValueOnce(reply.promise) })
    const lifetime = await import('./session-lifetime')
    const pending = operation === 'lock' ? store.getState().lock() : store.getState()[operation]('synthetic-password')
    api.state.mockResolvedValue(unlocked)
    await store.getState().refresh()
    expect(api.state).not.toHaveBeenCalled()
    expect(lifetime.captureSession()).toBeNull()
    reply.resolve(operation === 'lock' ? locked : { ok: true, state: unlocked })
    const result = await pending
    if (operation !== 'lock') expect(result).toBe(true)
    expect(store.getState()).toMatchObject({ status: operation === 'lock' ? 'locked' : 'unlocked', busy: false })
    const current = lifetime.captureSession()
    api.state.mockResolvedValue(operation === 'lock' ? locked : unlocked)
    await store.getState().refresh()
    expect(api.state).toHaveBeenCalledOnce()
    expect(lifetime.captureSession()).toBe(current)
  })

  it.each((['lock', 'initialize', 'unlock'] as const).flatMap(operation =>
    (['resolve', 'reject'] as const).map(settle => ({ operation, settle }))
  ))('old refresh $settle cannot cross a later $operation boundary', async ({ operation, settle }) => {
    const observation = deferred<unknown>()
    const { store } = await storeWith({ state: vi.fn().mockReturnValueOnce(observation.promise) })
    const lifetime = await import('./session-lifetime')
    const pending = store.getState().refresh()
    if (operation === 'lock') await store.getState().lock()
    else await expect(store.getState()[operation]('synthetic-password')).resolves.toBe(true)
    const current = lifetime.captureSession()
    const state = store.getState()
    if (settle === 'resolve') observation.resolve(operation === 'lock' ? unlocked : locked)
    else observation.reject(new Error('synthetic obsolete state failure'))
    await pending
    expect(store.getState()).toBe(state)
    expect(lifetime.captureSession()).toBe(current)
  })
})

describe('vault owns renderer lifetime activation', () => {
  it.each(['initialize', 'unlock'] as const)('does not activate on a rejected %s whose state says unlocked', async (operation) => {
    const { store } = await storeWith({ [operation]: vi.fn().mockResolvedValue({
      ok: false, error: 'Synthetic refusal', state: { status: 'unlocked', keyringBackend: 'synthetic', canRemember: false }
    }) })
    await expect(store.getState()[operation]('synthetic-password')).resolves.toBe(false)
    expect(store.getState().status).not.toBe('unlocked')
    expect((await import('./session-lifetime')).captureSession()).toBeNull()
  })

  it.each(['initialize', 'unlock'] as const)('activates only after a current acknowledged %s', async (operation) => {
    let finish!: (value: unknown) => void
    const { store } = await storeWith({ [operation]: vi.fn(() => new Promise(resolve => { finish = resolve })) })
    const lifetime = await import('./session-lifetime')
    const pending = store.getState()[operation]('synthetic-password')
    expect(lifetime.captureSession()).toBeNull()
    finish({ ok: true, state: { status: 'unlocked', keyringBackend: 'synthetic', canRemember: false } })
    await expect(pending).resolves.toBe(true)
    expect(lifetime.isSessionCurrent(lifetime.captureSession())).toBe(true)
  })

  it('does not cancel current requests for repeated acknowledged unlocked refreshes', async () => {
    const { store, api } = await storeWith()
    const lifetime = await import('./session-lifetime')
    await store.getState().unlock('synthetic-password')
    const ticket = lifetime.captureSession()
    api.state.mockResolvedValue({ status: 'unlocked', keyringBackend: 'synthetic', canRemember: false })
    await store.getState().refresh()
    await store.getState().refresh()
    expect(lifetime.captureSession()).toBe(ticket)
    expect(lifetime.isSessionCurrent(ticket)).toBe(true)
  })

  it('cannot activate through a missing production preload', async () => {
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubGlobal('window', {})
    const { useVault } = await import('./vault')
    const lifetime = await import('./session-lifetime')
    await expect(useVault.getState().unlock('synthetic-password')).resolves.toBe(false)
    await expect(useVault.getState().initialize('synthetic-password')).resolves.toBe(false)
    expect(useVault.getState().status).toBe('locked')
    expect(lifetime.captureSession()).toBeNull()
  })

  it('retains explicit development browser-preview activation', async () => {
    vi.resetModules()
    vi.stubEnv('DEV', true)
    vi.stubGlobal('window', {})
    const { useVault } = await import('./vault')
    const lifetime = await import('./session-lifetime')
    expect(useVault.getState().status).toBe('unlocked')
    expect(lifetime.isSessionCurrent(lifetime.captureSession())).toBe(true)
  })
})

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
