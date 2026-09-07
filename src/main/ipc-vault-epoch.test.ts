// Capture the real IPC handlers, but import no service/native/owner-data implementations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
type AuthResult = { ok: boolean; error?: string; state: { status: string } }
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  unlocked: false,
  policy: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  initialize: vi.fn<(...args: unknown[]) => Promise<void>>(),
  unlock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  lock: vi.fn(),
  seed: vi.fn(),
  collect: vi.fn(async () => ({ records: 0 }))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => { harness.handlers.set(name, handler) }, on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: {}, dialog: {}
}))
vi.mock('node:fs', () => ({ promises: {} }))
vi.mock('./vault/vault', () => ({
  initialize: harness.initialize,
  unlock: harness.unlock,
  isUnlocked: () => harness.unlocked,
  vaultStatus: () => harness.unlocked ? 'unlocked' : 'locked',
  listAiAccess: () => [],
  listFinanceAccounts: () => []
}))
vi.mock('./security/lockdown', () => ({ lockApplication: harness.lock }))
vi.mock('../shared/password-strength', () => ({ masterPasswordPolicyError: harness.policy }))
vi.mock('./finance/bank-session', () => ({ setLoginListener: vi.fn() }))
vi.mock('./ai/ai-prices', () => ({ seedPricesIfEmpty: harness.seed }))
vi.mock('./ai/ai-seed', () => ({ seedAiAccess: vi.fn() }))
vi.mock('./finance/subs-seed', () => ({ seedSubscriptions: vi.fn() }))
vi.mock('./finance/finance-seed', () => ({ seedFinanceAccounts: vi.fn() }))
vi.mock('./ai/ai-accounts-migrate', () => ({ migrateToAccounts: vi.fn() }))
vi.mock('./ai/ai-accounts-prune', () => ({ pruneUnverifiedAccounts: vi.fn() }))
vi.mock('./ai/spend-link', () => ({ linkPaidDevices: () => [] }))
vi.mock('./ai/ai-usage', () => ({ collectUsage: harness.collect }))

// These imports belong to unrelated registered handlers; none may reach a real service.
vi.mock('./remote/ssh', () => ({}))
vi.mock('./remote/sftp', () => ({}))
vi.mock('./remote/forward', () => ({}))
vi.mock('./remote/sshconfig', () => ({}))
vi.mock('./devices/discovery', () => ({}))
vi.mock('./finance/onchain', () => ({}))
vi.mock('./ai/ai', () => ({}))
vi.mock('./support/brand-icon', () => ({}))
vi.mock('./security/browser-passwords', () => ({}))
vi.mock('./ai/ai-models', () => ({}))
vi.mock('./ai/ai-quota', () => ({}))
vi.mock('./finance/exchanges', () => ({}))
vi.mock('./finance/tinvest', () => ({}))
vi.mock('./finance/tbank', () => ({}))
vi.mock('./devices/pc', () => ({}))
vi.mock('./devices/ports', () => ({}))
vi.mock('./watchdog', () => ({}))
vi.mock('./devices/hardware', () => ({}))
vi.mock('./screen/screen', () => ({}))
vi.mock('./screen/agent', () => ({}))
vi.mock('./remote/net', () => ({}))
vi.mock('./devices/liveness', () => ({}))
vi.mock('./devices/device-disposal', () => ({}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const open = (operation: 'initialize' | 'unlock'): Promise<AuthResult> =>
  harness.handlers.get(`vault:${operation}`)!({}, 'synthetic-unit-password') as Promise<AuthResult>
const lock = (): void => { harness.handlers.get('vault:lock')!({}) }
async function flushBackground(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.handlers.clear()
  harness.unlocked = false
  harness.policy.mockReset().mockResolvedValue(null)
  const succeed = async (): Promise<void> => { harness.unlocked = true }
  harness.initialize.mockReset().mockImplementation(succeed)
  harness.unlock.mockReset().mockImplementation(succeed)
  const access = await import('./vault/access-epoch')
  harness.lock.mockReset().mockImplementation(() => {
    access.revokePendingAccess()
    harness.unlocked = false
  })
  const { registerIpc } = await import('./ipc')
  registerIpc()
})
afterEach(flushBackground)

describe('vault IPC authentication belongs to the access generation it started in', () => {
  it.each(['initialize', 'unlock'] as const)('runs afterUnlock after uninterrupted %s', async (operation) => {
    await expect(open(operation)).resolves.toMatchObject({ ok: true, state: { status: 'unlocked' } })
    expect(harness.seed).toHaveBeenCalledOnce()
    expect(harness.collect).toHaveBeenCalledOnce()
  })

  it('never begins initialization after lock while password policy was pending', async () => {
    const policy = deferred<string | null>()
    harness.policy.mockReturnValueOnce(policy.promise)
    const pending = open('initialize')
    lock()
    policy.resolve(null)
    await expect(pending).resolves.toMatchObject({ ok: false, state: { status: 'locked' } })
    expect(harness.initialize).not.toHaveBeenCalled()
    expect(harness.seed).not.toHaveBeenCalled()
    expect(harness.collect).not.toHaveBeenCalled()
  })

  it.each(['initialize', 'unlock'] as const)('does not run late afterUnlock when lock interrupts %s', async (operation) => {
    const result = deferred<void>()
    harness[operation].mockReturnValueOnce(result.promise)
    const pending = open(operation)
    await Promise.resolve() // initialize first awaits password policy.
    expect(harness[operation]).toHaveBeenCalledOnce()
    lock()
    result.resolve(undefined)
    await expect(pending).resolves.toMatchObject({ ok: false, state: { status: 'locked' } })
    expect(harness.seed).not.toHaveBeenCalled()
    expect(harness.collect).not.toHaveBeenCalled()
  })

  it('checks the generation even if a delayed implementation reports itself unlocked', async () => {
    const result = deferred<void>()
    harness.unlock.mockReturnValueOnce(result.promise)
    const pending = open('unlock')
    lock()
    harness.unlocked = true // A state flag alone is not authority for the obsolete operation.
    result.resolve(undefined)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(harness.seed).not.toHaveBeenCalled()
    expect(harness.collect).not.toHaveBeenCalled()
  })

  it('does not report success or run afterUnlock if an operation resolves while still locked', async () => {
    harness.unlock.mockResolvedValueOnce(undefined)
    await expect(open('unlock')).resolves.toMatchObject({ ok: false, state: { status: 'locked' } })
    expect(harness.seed).not.toHaveBeenCalled()
  })

  it('allows a fresh initialization after a cancelled policy check', async () => {
    const policy = deferred<string | null>()
    harness.policy.mockReturnValueOnce(policy.promise)
    const pending = open('initialize')
    lock()
    policy.resolve(null)
    await expect(pending).resolves.toMatchObject({ ok: false })
    await expect(open('initialize')).resolves.toMatchObject({ ok: true, state: { status: 'unlocked' } })
    expect(harness.initialize).toHaveBeenCalledOnce()
    expect(harness.seed).toHaveBeenCalledOnce()
  })

  it('keeps a policy refusal from initializing or running afterUnlock', async () => {
    harness.policy.mockResolvedValueOnce('Synthetic policy refusal')
    await expect(open('initialize')).resolves.toMatchObject({ ok: false, error: 'Synthetic policy refusal' })
    expect(harness.initialize).not.toHaveBeenCalled()
    expect(harness.seed).not.toHaveBeenCalled()
  })

  it.each(['initialize', 'unlock'] as const)('preserves a rejected %s without afterUnlock', async (operation) => {
    harness[operation].mockRejectedValueOnce(new Error('Synthetic authentication failure'))
    await expect(open(operation)).resolves.toMatchObject({ ok: false, error: 'Synthetic authentication failure' })
    expect(harness.seed).not.toHaveBeenCalled()
    expect(harness.collect).not.toHaveBeenCalled()
  })
})
