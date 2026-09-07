import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceDTO, DeviceInput } from '@/types'

afterEach(() => vi.unstubAllGlobals())

describe('device load follow-up', () => {
  it('awaits and exposes failed liveness instead of losing the nested promise', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { api: { devices: {
      list: vi.fn().mockResolvedValue([]), liveness: vi.fn().mockRejectedValue(new Error('synthetic IPC failure'))
    } } })
    const { activateSession } = await import('./session-lifetime')
    activateSession()
    const { useDevices } = await import('./devices')
    await useDevices.getState().load()
    expect(useDevices.getState()).toMatchObject({ loaded: true, devices: [], error: 'Не удалось проверить доступность устройств' })
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const device: DeviceDTO = {
  id: 'synthetic', name: 'Synthetic', provider: '', role: 'exit', kind: 'server',
  ip: '192.0.2.1', port: 22, user: 'test', country: '', flag: '', os: 'Linux',
  hasSecret: true, altOs: [], status: 'online', cpu: 1, ram: { used: 1, total: 2 },
  cost: { amount: 0, currency: 'USD', usd: 0 }, consoleUrl: '', authType: 'password',
  notes: null, jumpId: null, mac: ''
}

async function deviceWorld() {
  vi.resetModules()
  const api = {
    devices: { list: vi.fn().mockResolvedValue([]), liveness: vi.fn().mockResolvedValue({}),
      create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    ssh: { probe: vi.fn().mockResolvedValue({ status: 'online', cpu: 2 }) },
    pc: { metrics: vi.fn().mockResolvedValue({ status: 'online', cpu: 2, family: 'windows', current: 'Windows' }) }
  }
  const confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('window', { api, confirm })
  const lifetime = await import('./session-lifetime')
  lifetime.activateSession()
  const module = await import('./devices')
  module.useDevices.setState({ devices: [device], loaded: true })
  return { api, confirm, lifetime, ...module }
}

describe('device requests cannot outlive the renderer session', () => {
  it.each(['create', 'update', 'remove'] as const)('ignores an old %s result instead of modifying a new session', async (operation) => {
    const { api, lifetime, useDevices } = await deviceWorld()
    const reply = deferred<unknown>()
    api.devices[operation].mockReturnValueOnce(reply.promise)
    const input = { name: 'synthetic' } as DeviceInput
    const pending = operation === 'create' ? useDevices.getState().create(input)
      : operation === 'update' ? useDevices.getState().update(device.id, input) : useDevices.getState().remove(device.id)
    lifetime.invalidateSession()
    useDevices.setState({ devices: [device] })
    lifetime.activateSession()
    reply.resolve({ ok: true, device: { ...device, name: 'obsolete' } })
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(useDevices.getState().devices).toEqual([device])
  })

  it.each(['create', 'update', 'remove'] as const)('consumes obsolete %s rejection but preserves active rejection', async (operation) => {
    const { api, lifetime, useDevices } = await deviceWorld()
    const reply = deferred<unknown>()
    api.devices[operation].mockReturnValueOnce(reply.promise).mockRejectedValueOnce(new Error('active failure'))
    const input = { name: 'synthetic' } as DeviceInput
    const run = () => operation === 'create' ? useDevices.getState().create(input)
      : operation === 'update' ? useDevices.getState().update(device.id, input) : useDevices.getState().remove(device.id)
    const pending = run()
    lifetime.invalidateSession()
    reply.reject(new Error('obsolete failure'))
    await expect(pending).resolves.toMatchObject({ ok: false })
    lifetime.activateSession()
    await expect(run()).rejects.toThrow('active failure')
  })

  it('does not prompt or send force-delete after an obsolete canForce result', async () => {
    const { api, confirm, lifetime, useDevices } = await deviceWorld()
    const reply = deferred<unknown>()
    api.devices.remove.mockReturnValueOnce(reply.promise)
    const pending = useDevices.getState().remove(device.id)
    lifetime.invalidateSession()
    reply.resolve({ ok: false, canForce: true, error: 'synthetic unreachable' })
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.devices.remove).toHaveBeenCalledOnce()
  })

  it.each(['refreshLiveness', 'refreshMetrics', 'refreshOsStatus', 'refreshOne'] as const)(
    '%s consumes stale rejection without changing newer metrics', async (operation) => {
      const { api, lifetime, useDevices } = await deviceWorld()
      if (operation === 'refreshOsStatus') useDevices.setState({ devices: [{ ...device, os: 'Windows' }] })
      const reply = deferred<unknown>()
      api.devices.liveness.mockReturnValueOnce(reply.promise)
      api.ssh.probe.mockReturnValueOnce(reply.promise)
      api.pc.metrics.mockReturnValueOnce(reply.promise)
      const pending = operation === 'refreshOne' ? useDevices.getState().refreshOne(device.id) : useDevices.getState()[operation]()
      lifetime.invalidateSession()
      useDevices.setState({ devices: [{ ...device, cpu: 10 }] })
      lifetime.activateSession()
      reply.reject(new Error('obsolete probe failure'))
      await expect(pending).resolves.toBeUndefined()
      expect(useDevices.getState().devices[0].cpu).toBe(10)
    }
  )

  it('old Linux probe completion cannot change newer data or start an OS follow-up', async () => {
    const { api, lifetime, useDevices } = await deviceWorld()
    const reply = deferred<unknown>()
    api.ssh.probe.mockReturnValueOnce(reply.promise)
    const pending = useDevices.getState().refreshMetrics()
    lifetime.invalidateSession()
    useDevices.setState({ devices: [{ ...device, os: 'Windows', cpu: 10 }] })
    lifetime.activateSession()
    reply.resolve({ status: 'online', cpu: 99 })
    await pending
    expect(useDevices.getState().devices[0].cpu).toBe(10)
    expect(api.pc.metrics).not.toHaveBeenCalled()
  })

  it.each(['refreshMetrics', 'refreshOsStatus', 'refreshOne'] as const)(
    '%s discards obsolete Windows success while preserving current-session polling', async (operation) => {
      const { api, lifetime, useDevices, resetDevices } = await deviceWorld()
      const currentDevice = { ...device, os: 'Windows', cpu: 10 }
      useDevices.setState({ devices: [currentDevice] })
      const reply = deferred<unknown>()
      api.pc.metrics.mockReturnValueOnce(reply.promise)
      const run = () => operation === 'refreshOne' ? useDevices.getState().refreshOne(device.id) : useDevices.getState()[operation]()
      const pending = run()
      await vi.waitFor(() => expect(api.pc.metrics).toHaveBeenCalledOnce())
      lifetime.invalidateSession()
      resetDevices()
      lifetime.activateSession()
      useDevices.setState({ devices: [currentDevice] })
      reply.resolve({ status: 'offline', cpu: 99, ramUsed: 99, ramTotal: 100, current: 'obsolete' })
      await pending
      expect(useDevices.getState().devices).toEqual([currentDevice])
      await run()
      expect(api.pc.metrics).toHaveBeenCalledTimes(2)
      expect(useDevices.getState().devices[0]).toMatchObject({ cpu: 2, status: 'online', runningOs: 'Windows' })
    }
  )

  it('obsolete successful liveness cannot change the new session or its miss counter', async () => {
    const { api, lifetime, useDevices, resetDevices } = await deviceWorld()
    const reply = deferred<unknown>()
    api.devices.liveness.mockReturnValueOnce(reply.promise).mockResolvedValue({ synthetic: { status: 'offline' } })
    const pending = useDevices.getState().refreshLiveness()
    lifetime.invalidateSession()
    resetDevices()
    lifetime.activateSession()
    useDevices.setState({ devices: [device] })
    reply.resolve({ synthetic: { status: 'offline' } })
    await pending
    expect(useDevices.getState().devices).toEqual([device])
    await useDevices.getState().refreshLiveness()
    await useDevices.getState().refreshLiveness()
    expect(useDevices.getState().devices[0].status).toBe('unknown')
    await useDevices.getState().refreshLiveness()
    expect(useDevices.getState().devices[0].status).toBe('offline')
  })

  it('reset clears the previous session miss streak without requiring another list load', async () => {
    const { api, lifetime, useDevices, resetDevices } = await deviceWorld()
    api.devices.liveness.mockResolvedValue({ synthetic: { status: 'offline' } })
    await useDevices.getState().refreshLiveness()
    await useDevices.getState().refreshLiveness()
    expect(useDevices.getState().devices[0].status).toBe('unknown')
    lifetime.invalidateSession()
    resetDevices()
    lifetime.activateSession()
    useDevices.setState({ devices: [device] })
    await useDevices.getState().refreshLiveness()
    expect(useDevices.getState().devices[0].status).toBe('unknown')
  })

  it('reset releases old in-flight metrics, but old finally cannot release the new poll', async () => {
    const { api, lifetime, useDevices, resetDevices } = await deviceWorld()
    const old = deferred<unknown>(), current = deferred<unknown>()
    api.ssh.probe.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const a = useDevices.getState().refreshMetrics()
    lifetime.invalidateSession()
    resetDevices()
    lifetime.activateSession()
    useDevices.setState({ devices: [device] })
    const b = useDevices.getState().refreshMetrics()
    expect(api.ssh.probe).toHaveBeenCalledTimes(2)
    old.resolve({ status: 'online', cpu: 99 })
    await a
    await useDevices.getState().refreshMetrics()
    expect(api.ssh.probe).toHaveBeenCalledTimes(2)
    current.resolve({ status: 'online', cpu: 2 })
    await b
    expect(useDevices.getState().devices[0].cpu).toBe(2)
  })
})
