import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceDTO } from '@/types'

async function mount(patch: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const api = {
    snippets: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn(), ...patch },
    ssh: { exec: vi.fn().mockResolvedValue({ ok: true, output: 'synthetic success' }) }
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { useUI } = await import('@/store/ui')
  const { useDevices } = await import('@/store/devices')
  useUI.setState({ broadcast: true })
  useDevices.setState({ devices: [
    { id: 'host-1', name: 'Synthetic A', ip: '192.0.2.1', hasSecret: true },
    { id: 'host-2', name: 'Synthetic B', ip: '192.0.2.2', hasSecret: true }
  ] as DeviceDTO[] })
  const { BroadcastPanel } = await import('./BroadcastPanel')
  await act(async () => { render(<BroadcastPanel />) })
  return { ...api, ui: useUI }
}

afterEach(() => vi.restoreAllMocks())

describe('broadcast IPC failures', () => {
  it('keeps per-host success when another host rejects, and enables retry', async () => {
    const api = await mount()
    api.ssh.exec.mockRejectedValueOnce(new Error('synthetic disconnect'))
    await userEvent.type(screen.getByRole('textbox'), 'echo synthetic')
    const run = screen.getByRole('button', { name: 'Выполнить' })
    await userEvent.click(run)
    expect(await screen.findByText(/synthetic disconnect/)).toBeInTheDocument()
    expect(screen.getByText('synthetic success')).toBeInTheDocument()
    expect(run).toBeEnabled()
  })

  it('announces snippets list failure instead of leaving an unhandled rejection', async () => {
    await mount({ list: vi.fn().mockRejectedValue(new Error('list unavailable')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('list unavailable')
  })

  it('announces failed snippet save and does not refresh as if it was saved', async () => {
    const api = await mount({ create: vi.fn().mockRejectedValue(new Error('write failed')) })
    vi.spyOn(window, 'prompt').mockReturnValue('Synthetic')
    await userEvent.type(screen.getByRole('textbox'), 'echo synthetic')
    await userEvent.click(screen.getByRole('button', { name: 'сохранить' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('write failed'))
    expect(api.snippets.list).toHaveBeenCalledTimes(1)
  })

  it('a previous dialog save rejection cannot contaminate a freshly reopened dialog', async () => {
    let fail!: (cause: Error) => void
    const api = await mount({ create: vi.fn().mockImplementation(() => new Promise((_, reject) => { fail = reject })) })
    vi.spyOn(window, 'prompt').mockReturnValue('Synthetic')
    await userEvent.type(screen.getByRole('textbox'), 'echo synthetic')
    await userEvent.click(screen.getByRole('button', { name: 'сохранить' }))
    await act(async () => { api.ui.setState({ broadcast: false }) })
    await act(async () => { api.ui.setState({ broadcast: true }) })
    await act(async () => { fail(new Error('stale write failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
