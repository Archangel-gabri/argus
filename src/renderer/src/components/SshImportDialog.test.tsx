import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

async function mount(fail: 'parse' | 'import' | null = null) {
  const api = {
    sshconfig: {
      parse: vi.fn().mockResolvedValue([{ name: 'Synthetic', host: '192.0.2.1', port: 22, user: 'test' }]),
      import: vi.fn().mockResolvedValue({ added: 1 })
    },
    devices: { list: vi.fn().mockResolvedValue([]), liveness: vi.fn().mockResolvedValue({}) },
    discovery: { tailscale: vi.fn().mockResolvedValue([]) }
  }
  if (fail) api.sshconfig[fail].mockRejectedValue(new Error('synthetic IPC failure'))
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { useUI } = await import('@/store/ui')
  useUI.setState({ sshImport: 'ssh' })
  const { SshImportDialog } = await import('./SshImportDialog')
  await act(async () => { render(<SshImportDialog />) })
  return { ...api, ui: useUI }
}

afterEach(() => vi.restoreAllMocks())

describe('SSH import rejected IPC', () => {
  it('finishes loading and announces discovery error', async () => {
    await mount('parse')
    expect(await screen.findByRole('alert')).toHaveTextContent('synthetic IPC failure')
    expect(screen.queryByText('Читаю ~/.ssh/config…')).toBeNull()
  })

  it('failed import preserves selection, releases busy and never claims added', async () => {
    await mount('import')
    const add = await screen.findByRole('button', { name: 'Добавить' })
    await userEvent.click(add)
    expect(await screen.findByRole('alert')).toHaveTextContent('synthetic IPC failure')
    expect(add).toBeEnabled()
    expect(screen.queryByText(/Добавлено серверов/)).toBeNull()
  })

  it('acknowledged import still reports the actual count', async () => {
    await mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Добавлено серверов: 1')
  })

  it('a prior source import rejection cannot contaminate the new source dialog', async () => {
    const api = await mount()
    let fail!: (cause: Error) => void
    api.sshconfig.import.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    await act(async () => { api.ui.setState({ sshImport: 'tailscale' }) })
    await act(async () => { fail(new Error('stale import failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Добавлено серверов/)).toBeNull()
  })
})
