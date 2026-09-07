import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('device load follow-up', () => {
  it('awaits and exposes failed liveness instead of losing the nested promise', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { api: { devices: {
      list: vi.fn().mockResolvedValue([]), liveness: vi.fn().mockRejectedValue(new Error('synthetic IPC failure'))
    } } })
    const { useDevices } = await import('./devices')
    await useDevices.getState().load()
    expect(useDevices.getState()).toMatchObject({ loaded: true, devices: [], error: 'Не удалось проверить доступность устройств' })
  })
})
