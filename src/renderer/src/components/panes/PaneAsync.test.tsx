import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import type { DeviceDTO } from '@/types'

const device = (over: Partial<DeviceDTO> = {}): DeviceDTO => ({
  id: 'device-a', name: 'Test device', provider: '', role: 'exit', kind: 'server',
  ip: '203.0.113.10', port: 22, user: 'test', country: '', flag: '', os: 'Linux',
  status: 'offline', cpu: 0, ram: { used: 0, total: 0 },
  cost: { amount: 0, currency: 'USD', usd: 0 }, consoleUrl: '', authType: 'password',
  hasSecret: true, notes: null, jumpId: null, altOs: [], mac: '02:00:00:00:00:01',
  ...over
})

function stubApi() {
  return {
    forward: {
      list: vi.fn().mockResolvedValue([]),
      open: vi.fn().mockResolvedValue({ ok: true }),
      close: vi.fn()
    },
    ports: { list: vi.fn().mockResolvedValue({ ok: true, ports: [] }) },
    hw: {
      get: vi.fn().mockResolvedValue({ info: { cpuModel: 'Cached CPU' }, collectedAt: 1 }),
      refresh: vi.fn().mockResolvedValue({ ok: true, info: { cpuModel: 'Fresh CPU' } })
    },
    pc: {
      whichOs: vi.fn().mockResolvedValue({ family: 'linux', current: 'Linux' }),
      boot: vi.fn().mockResolvedValue({ ok: true }),
      power: vi.fn().mockResolvedValue({ ok: true, phase: 'accepted' }),
      wake: vi.fn().mockResolvedValue({ ok: true }),
      powerDiag: vi.fn().mockResolvedValue({ text: 'Synthetic diagnosis' })
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function mountForwards(api = stubApi(), strict = false) {
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  const { ForwardsPane } = await import('./ForwardsPane')
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<ForwardsPane device={device()} />, { wrapper: strict ? StrictMode : undefined }) })
  return { api, view, ForwardsPane }
}

async function mountOverview(api = stubApi(), d = device(), refreshOne = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  const { OverviewPane } = await import('./OverviewPane')
  const { useDevices } = await import('@/store/devices')
  useDevices.setState({ devices: [d], refreshOne })
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<OverviewPane device={d} />) })
  return { api, view, OverviewPane, refreshOne }
}

async function click(name: string | RegExp) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ForwardsPane IPC failures', () => {
  it('shows rejected open and releases busy so the user can retry', async () => {
    const api = stubApi()
    api.forward.open.mockRejectedValueOnce(new Error('Synthetic open failure'))
    await mountForwards(api)
    await click(/Postgres/)
    expect(screen.getByText('Synthetic open failure')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Postgres/ })).toBeEnabled()
    await click(/Postgres/)
    expect(api.forward.open).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Synthetic open failure')).not.toBeInTheDocument()
  })

  it('shows initial list and port-scan errors instead of an empty success or endless scan', async () => {
    const api = stubApi()
    api.forward.list.mockRejectedValueOnce(new Error('Synthetic list failure'))
    api.ports.list.mockRejectedValueOnce(new Error('Synthetic ports failure'))
    await mountForwards(api)
    expect(screen.getByText('Synthetic list failure')).toBeInTheDocument()
    expect(screen.getByText('Synthetic ports failure')).toBeInTheDocument()
    expect(screen.queryByText('Сканирую…')).not.toBeInTheDocument()
    await click('Обновить')
    expect(screen.getByText('Портов не найдено.')).toBeInTheDocument()
  })

  it('preserves manual inputs on rejection and clears them only after a successful open', async () => {
    const api = stubApi()
    api.forward.open.mockRejectedValueOnce(new Error('Synthetic manual failure'))
    await mountForwards(api)
    fireEvent.change(screen.getByPlaceholderText('8080'), { target: { value: '8081' } })
    fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '8080' } })
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: ' app.internal ' } })
    await click('Запустить')
    expect(screen.getByText('Synthetic manual failure')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('8080')).toHaveValue('8081')
    expect(screen.getByPlaceholderText('80')).toHaveValue('8080')
    expect(screen.getByRole('button', { name: 'Запустить' })).toBeEnabled()
    await click('Запустить')
    expect(api.forward.open).toHaveBeenLastCalledWith('device-a', 8081, 'app.internal', 8080)
    expect(screen.getByPlaceholderText('8080')).toHaveValue('')
    expect(screen.getByPlaceholderText('80')).toHaveValue('')
    expect(api.forward.list).toHaveBeenCalledTimes(2)
  })

  it('reports an explicit open refusal without clearing manual input', async () => {
    const api = stubApi()
    api.forward.open.mockResolvedValueOnce({ ok: false, error: 'Synthetic refusal' })
    await mountForwards(api)
    fireEvent.change(screen.getByPlaceholderText('8080'), { target: { value: '8081' } })
    fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '8080' } })
    await click('Запустить')
    expect(screen.getByText('Synthetic refusal')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('8080')).toHaveValue('8081')
    expect(screen.getByRole('button', { name: 'Запустить' })).toBeEnabled()
  })

  it('does not let an old device scan overwrite the newly selected device', async () => {
    const api = stubApi()
    const old = deferred<{ ok: boolean; ports: unknown[] }>()
    api.ports.list.mockReturnValueOnce(old.promise)
    const { view, ForwardsPane } = await mountForwards(api)
    await act(async () => { view.rerender(<ForwardsPane device={device({ id: 'device-b' })} />) })
    await act(async () => { old.resolve({ ok: true, ports: [{ port: 1234, proto: 'tcp', bind: 'loopback', addr: '127.0.0.1', process: 'Old device' }] }) })
    expect(screen.queryByText('Old device')).not.toBeInTheDocument()
    expect(api.ports.list).toHaveBeenLastCalledWith('device-b')
  })

  it('cancels the delayed close refresh on unmount', async () => {
    const api = stubApi()
    api.forward.list.mockResolvedValue([{ id: 'tunnel-a', localPort: 8080, remotePort: 80, remoteHost: '127.0.0.1' }])
    const { view } = await mountForwards(api)
    vi.useFakeTimers()
    await click('Остановить')
    expect(api.forward.close).toHaveBeenCalledWith('tunnel-a')
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(api.forward.list).toHaveBeenCalledTimes(1)
  })

  it('refreshes after a close send while mounted and reports a synchronous send failure', async () => {
    const api = stubApi()
    api.forward.list.mockResolvedValue([{ id: 'tunnel-a', localPort: 8080, remotePort: 80, remoteHost: '127.0.0.1' }])
    api.forward.close.mockImplementationOnce(() => { throw new Error('Synthetic close failure') })
    await mountForwards(api)
    vi.useFakeTimers()
    await click('Остановить')
    expect(screen.getByText('Synthetic close failure')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(api.forward.list).toHaveBeenCalledTimes(1)
    await click('Остановить')
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(api.forward.list).toHaveBeenCalledTimes(2)
  })

  it('ignores late open errors and does not refresh the old device after a switch', async () => {
    const api = stubApi()
    const old = deferred<{ ok: boolean }>()
    api.forward.open.mockReturnValueOnce(old.promise)
    const { view, ForwardsPane } = await mountForwards(api)
    await click(/Postgres/)
    await act(async () => { view.rerender(<ForwardsPane device={device({ id: 'device-b' })} />) })
    await act(async () => { old.reject(new Error('Old device failure')) })
    expect(screen.queryByText('Old device failure')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Postgres/ })).toBeEnabled()
    expect(api.forward.list).toHaveBeenCalledTimes(2)
    expect(api.forward.list).toHaveBeenLastCalledWith('device-b')
  })

  it('ignores the obsolete StrictMode setup without discarding the current setup', async () => {
    const api = stubApi()
    const old = deferred<unknown[]>()
    api.forward.list.mockReturnValueOnce(old.promise)
    await mountForwards(api, true)
    expect(api.forward.list).toHaveBeenCalledTimes(2)
    await act(async () => { old.reject(new Error('Obsolete StrictMode failure')) })
    expect(screen.queryByText('Obsolete StrictMode failure')).not.toBeInTheDocument()
    expect(screen.getByText('Нет активных туннелей.')).toBeInTheDocument()
  })
})

describe('OverviewPane IPC failures', () => {
  it.each([false, true])('recovers rejected power and diagnosis (dual boot=%s)', async (dualBoot) => {
    const api = stubApi()
    api.pc.power.mockRejectedValueOnce(new Error('Synthetic power failure'))
    api.pc.powerDiag.mockRejectedValueOnce(new Error('Synthetic diagnosis failure'))
    const d = device(dualBoot ? { altOs: [{ os: 'Windows' }] as DeviceDTO['altOs'] } : {})
    await mountOverview(api, d)
    await click('Ребут')
    expect(screen.getByText(/Synthetic power failure/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ребут' })).toBeEnabled()
    await click('Диагностика')
    expect(screen.getByText(/Synthetic diagnosis failure/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Диагностика' })).toBeEnabled()
    await click('Ребут')
    expect(screen.getByText('✓ команда отправлена')).toBeInTheDocument()
  })

  it('keeps an unknown OS retryable after a rejected initial poll', async () => {
    const api = stubApi()
    api.pc.whichOs.mockRejectedValueOnce(new Error('Synthetic OS failure'))
    await mountOverview(api, device({ altOs: [{ os: 'Windows' }] as DeviceDTO['altOs'] }))
    expect(screen.getByText('не ответила — пробую ещё')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Включить' })).toBeEnabled()
    await click('не ответила — пробую ещё')
    expect(screen.getByText('Сейчас: Linux')).toBeInTheDocument()
  })

  it('recovers from boot rejection without claiming a reboot succeeded', async () => {
    const api = stubApi()
    api.pc.boot.mockRejectedValueOnce(new Error('Synthetic boot failure'))
    await mountOverview(api, device({ altOs: [{ os: 'Windows' }] as DeviceDTO['altOs'] }))
    await click('Windows')
    expect(screen.getByText(/Synthetic boot failure/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Windows' })).toBeEnabled()
    await click('Windows')
    expect(api.pc.boot).toHaveBeenLastCalledWith('device-a', 'Windows')
    expect(screen.getByText(/команда отправлена, ПК перезагружается/)).toBeInTheDocument()
  })

  it.each([false, true])('recovers from wake rejection (dual boot=%s)', async (dualBoot) => {
    const api = stubApi()
    api.pc.whichOs.mockResolvedValue({ family: 'unknown', current: '' })
    api.pc.wake.mockRejectedValueOnce(new Error('Synthetic wake failure'))
    await mountOverview(api, device(dualBoot ? { altOs: [{ os: 'Windows' }] as DeviceDTO['altOs'] } : {}))
    await click('Включить')
    expect(screen.getByText(/Synthetic wake failure/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Включить' })).toBeEnabled()
    await click('Включить')
    expect(screen.getByText(/magic-пакет отправлен/)).toBeInTheDocument()
  })

  it('does not send power commands after a cancelled confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { api } = await mountOverview()
    await click('Выключить')
    expect(api.pc.power).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Выключить' })).toBeEnabled()
  })

  it('does not show an old power reply or busy state in the next device', async () => {
    const api = stubApi()
    const old = deferred<unknown>()
    api.pc.power.mockReturnValueOnce(old.promise)
    const { view, OverviewPane } = await mountOverview(api)
    await click('Ребут')
    expect(screen.getByRole('button', { name: 'Ребут' })).toBeDisabled()
    await act(async () => { view.rerender(<OverviewPane device={device({ id: 'device-b' })} />) })
    expect(screen.getByRole('button', { name: 'Ребут' })).toBeEnabled()
    await act(async () => { old.reject(new Error('Old power failure')) })
    expect(screen.queryByText(/Old power failure/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Диагностика' })).not.toBeInTheDocument()
  })

  it('shows rejected cache and refresh requests and releases hardware loading', async () => {
    const api = stubApi()
    api.hw.get.mockRejectedValueOnce(new Error('Synthetic cache failure'))
    api.hw.refresh.mockRejectedValueOnce(new Error('Synthetic hardware failure'))
    await mountOverview(api)
    expect(screen.getByText('Synthetic cache failure')).toBeInTheDocument()
    await click('собрать')
    expect(screen.getByText('Synthetic hardware failure')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'собрать' })).toBeEnabled()
    await click('собрать')
    expect(screen.getByText('Fresh CPU')).toBeInTheDocument()
  })

  it('keeps cached hardware visible but surfaces a failed refresh', async () => {
    const api = stubApi()
    api.hw.refresh.mockRejectedValueOnce(new Error('Synthetic refresh failure'))
    await mountOverview(api)
    expect(screen.getByText('Cached CPU')).toBeInTheDocument()
    await click(/собрано/)
    expect(screen.getByText('Synthetic refresh failure')).toBeInTheDocument()
    expect(screen.getByText('Cached CPU')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /собрано/ })).toBeEnabled()
  })

  it('does not start automatic hardware collection after an obsolete cache lookup', async () => {
    const api = stubApi()
    const old = deferred<null>()
    api.hw.get.mockReturnValueOnce(old.promise)
    const { view, OverviewPane } = await mountOverview(api)
    await act(async () => { view.rerender(<OverviewPane device={device({ id: 'device-b' })} />) })
    await act(async () => { old.resolve(null) })
    expect(api.hw.refresh).not.toHaveBeenCalled()
    expect(screen.getByText('Cached CPU')).toBeInTheDocument()
  })

  it('stops OS polling on unmount and consumes a late rejected reply', async () => {
    const api = stubApi()
    const old = deferred<{ family: string; current: string }>()
    api.pc.whichOs.mockReturnValueOnce(old.promise)
    const { view } = await mountOverview(api, device({ altOs: [{ os: 'Windows' }] as DeviceDTO['altOs'] }))
    vi.useFakeTimers()
    view.unmount()
    await act(async () => {
      old.reject(new Error('Late OS failure'))
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(api.pc.whichOs).toHaveBeenCalledTimes(1)
  })

  it('exposes metric poll errors, retries on the interval, and stops on unmount', async () => {
    vi.useFakeTimers()
    const refreshOne = vi.fn().mockRejectedValueOnce(new Error('Synthetic metrics failure')).mockResolvedValue(undefined)
    const { view } = await mountOverview(stubApi(), device(), refreshOne)
    expect(screen.getByText(/Synthetic metrics failure/)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(refreshOne).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Synthetic metrics failure/)).not.toBeInTheDocument()
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(refreshOne).toHaveBeenCalledTimes(2)
  })
})
