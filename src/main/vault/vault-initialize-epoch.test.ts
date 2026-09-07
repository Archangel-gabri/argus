// Actual vault initialization/control flow, with an entirely in-memory filesystem and driver.
// This belongs to unit, not *.vault.test.ts: no native SQLCipher, real files or owner seed data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handles: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  derive: vi.fn<(...args: unknown[]) => Promise<string>>(),
  rename: vi.fn<(from: string, to: string) => void>(),
  execute: vi.fn<(sql: string) => void>(),
  findSeed: vi.fn(() => null)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/virtual-argus-unit' } }))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => harness.files.has(path),
  readFileSync: (path: string) => {
    const value = harness.files.get(path)
    if (value === undefined) throw new Error('Missing virtual file')
    return value
  },
  writeFileSync: (path: string, value: string) => { harness.files.set(path, value) },
  renameSync: harness.rename,
  unlinkSync: (path: string) => { harness.files.delete(path) }
}))
vi.mock('better-sqlite3-multiple-ciphers', () => ({
  default: class SyntheticDatabase {
    close = vi.fn()
    constructor(path: string) {
      harness.files.set(path, 'synthetic encrypted database')
      harness.handles.push(this)
    }
    pragma(): void {}
    exec(sql: string): void { harness.execute(sql) }
    prepare(): { all: () => unknown[]; run: () => void } {
      return { all: () => [], run: () => {} }
    }
  }
}))
vi.mock('./crypto', () => ({ deriveKeyHex: harness.derive }))
vi.mock('./seed-file', () => ({ findSeedFile: harness.findSeed }))

const META = '/virtual-argus-unit/argus-vault.meta.json'
const PENDING = `${META}.new`
const PASSWORD = 'synthetic-unit-password'
const KEY = '0'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let vault: typeof import('./vault')
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.files.clear()
  harness.handles.length = 0
  harness.derive.mockReset().mockResolvedValue(KEY)
  harness.execute.mockReset()
  harness.rename.mockReset().mockImplementation((from, to) => {
    const value = harness.files.get(from)
    if (value === undefined) throw new Error('Missing virtual rename source')
    harness.files.set(to, value)
    harness.files.delete(from)
  })
  vault = await import('./vault')
})
afterEach(() => { vault.lock() })

describe('initialize respects the main access lifetime', () => {
  it('publishes an uninterrupted initialization and lock closes its only handle', async () => {
    await vault.initialize(PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
    expect(harness.files.has(META)).toBe(true)
    expect(harness.files.has(PENDING)).toBe(false)
    expect(harness.handles).toHaveLength(1)
    expect(harness.handles[0].close).not.toHaveBeenCalled()
    vault.lock()
    expect(vault.vaultStatus()).toBe('locked')
    expect(harness.handles[0].close).toHaveBeenCalledOnce()
  })

  it('does not open or publish a database when lock revokes pending key derivation', async () => {
    const key = deferred<string>()
    harness.derive.mockReturnValueOnce(key.promise)
    const pending = vault.initialize(PASSWORD)
    const rejected = expect(pending).rejects.toThrow(/заблокировали|отмен/i)
    const recoverableMeta = harness.files.get(PENDING)
    vault.lock()
    key.resolve(KEY)
    await rejected
    expect(vault.isUnlocked()).toBe(false)
    expect(harness.handles).toHaveLength(0)
    expect(harness.rename).not.toHaveBeenCalled()
    expect(harness.findSeed).not.toHaveBeenCalled()
    expect(harness.files.get(PENDING)).toBe(recoverableMeta)
  })

  it('allows a fresh retry after cancellation using the same recoverable salt', async () => {
    const key = deferred<string>()
    harness.derive.mockReturnValueOnce(key.promise)
    const pending = vault.initialize(PASSWORD)
    const rejected = expect(pending).rejects.toThrow()
    const recoverableMeta = harness.files.get(PENDING)
    vault.lock()
    key.resolve(KEY)
    await rejected
    await vault.initialize(PASSWORD)
    expect(vault.isUnlocked()).toBe(true)
    expect(harness.files.get(META)).toBe(recoverableMeta)
    expect(harness.handles).toHaveLength(1)
  })

  it('does not close or replace the newer initialization when an older key finishes last', async () => {
    const oldKey = deferred<string>()
    const newKey = deferred<string>()
    harness.derive.mockReturnValueOnce(oldKey.promise).mockReturnValueOnce(newKey.promise)
    const oldOperation = vault.initialize(PASSWORD)
    const rejected = expect(oldOperation).rejects.toThrow(/заблокировали|отмен/i)
    vault.lock()
    const currentOperation = vault.initialize(PASSWORD)
    newKey.resolve(KEY)
    await currentOperation
    oldKey.resolve(KEY)
    await rejected
    expect(vault.isUnlocked()).toBe(true)
    expect(harness.handles).toHaveLength(1)
    expect(harness.handles[0].close).not.toHaveBeenCalled()
  })

  it('closes only its local handle if access is revoked before publication', async () => {
    // Reentrant synthetic revocation exercises the cleanup branch without a native driver.
    harness.execute.mockImplementationOnce(() => { vault.lock() })
    await expect(vault.initialize(PASSWORD)).rejects.toThrow(/заблокировали|отмен/i)
    expect(vault.isUnlocked()).toBe(false)
    expect(harness.handles).toHaveLength(1)
    expect(harness.handles[0].close).toHaveBeenCalledOnce()
    expect(harness.rename).not.toHaveBeenCalled()
    expect(harness.files.has(PENDING)).toBe(true)
    expect(harness.files.has(META)).toBe(false)
    expect(harness.findSeed).not.toHaveBeenCalled()
  })

  it('preserves recovery metadata and closes a handle on migration failure', async () => {
    harness.execute.mockImplementationOnce(() => { throw new Error('Synthetic migration failure') })
    await expect(vault.initialize(PASSWORD)).rejects.toThrow('Synthetic migration failure')
    expect(vault.isUnlocked()).toBe(false)
    expect(harness.handles[0].close).toHaveBeenCalledOnce()
    expect(harness.files.has(PENDING)).toBe(true)
    expect(harness.files.has(META)).toBe(false)
  })

  it('does not open a handle when key derivation rejects', async () => {
    harness.derive.mockRejectedValueOnce(new Error('Synthetic derivation failure'))
    await expect(vault.initialize(PASSWORD)).rejects.toThrow('Synthetic derivation failure')
    expect(harness.handles).toHaveLength(0)
    expect(harness.files.has(PENDING)).toBe(true)
    expect(vault.isUnlocked()).toBe(false)
  })
})
