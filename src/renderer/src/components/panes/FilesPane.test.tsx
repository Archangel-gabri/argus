import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import type { DeviceDTO } from '@/types'

const device = { id: 'synthetic-host' } as DeviceDTO
async function mount(patch: Record<string, ReturnType<typeof vi.fn>> = {}, strict = false) {
  const api = { sftp: {
    open: vi.fn().mockResolvedValue({ ok: true, sessionId: 's1' }),
    list: vi.fn().mockResolvedValue({ ok: true, path: '/synthetic', entries: [{ name: 'fixture.txt', type: 'f', size: 5 }] }),
    close: vi.fn(),
    upload: vi.fn().mockResolvedValue({ ok: true, name: 'fixture.txt' }),
    download: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...patch
  } }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { FilesPane } = await import('./FilesPane')
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(strict ? <StrictMode><FilesPane device={device} /></StrictMode> : <FilesPane device={device} />) })
  return { api, view, FilesPane }
}

afterEach(() => vi.restoreAllMocks())

describe('SFTP pane rejected IPC and session lifetime', () => {
  it('open rejection ends loading and offers reconnect', async () => {
    await mount({ open: vi.fn().mockRejectedValue(new Error('open failed')) })
    expect(await screen.findByText('open failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Подключиться заново' })).toBeEnabled()
    expect(screen.queryByText('Загрузка…')).toBeNull()
  })

  it('list rejection is shown and reload can recover', async () => {
    const { api } = await mount({ list: vi.fn().mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue({ ok: true, path: '/', entries: [] }) })
    expect(await screen.findByText('list failed')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('Обновить'))
    expect(await screen.findByText('Пусто.')).toBeInTheDocument()
    expect(api.sftp.list).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['upload', 'Загрузить'], ['download', 'Скачать'], ['remove', 'Удалить']
  ] as const)('%s rejection reports error and releases busy', async (operation, label) => {
    await mount({ [operation]: vi.fn().mockRejectedValue(new Error('transfer failed')) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const target = operation === 'upload' ? screen.getByRole('button', { name: label }) : screen.getByTitle(label)
    await userEvent.click(target)
    expect(await screen.findByText(/transfer failed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeEnabled()
  })

  it('closes a reconnected session on unmount, not just the original one', async () => {
    const { api, view } = await mount({
      open: vi.fn().mockResolvedValueOnce({ ok: true, sessionId: 's1' }).mockResolvedValue({ ok: true, sessionId: 's2' }),
      list: vi.fn().mockResolvedValueOnce({ ok: false, error: 'session closed' }).mockResolvedValue({ ok: true, path: '/', entries: [] })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Подключиться заново' }))
    await screen.findByText('Пусто.')
    view.unmount()
    expect(api.sftp.close).toHaveBeenCalledWith('s2')
  })

  it('a late open response closes its own session after unmount', async () => {
    let finish!: (r: { ok: boolean; sessionId: string }) => void
    const { api, view } = await mount({ open: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve })) })
    view.unmount()
    await act(async () => { finish({ ok: true, sessionId: 'late' }) })
    await waitFor(() => expect(api.sftp.close).toHaveBeenCalledWith('late'))
    expect(api.sftp.list).not.toHaveBeenCalled()
  })

  it('StrictMode effect replay keeps the new session and closes the obsolete open response', async () => {
    let finish!: (r: { ok: boolean; sessionId: string }) => void
    const { api, view } = await mount({ open: vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ ok: true, sessionId: 'active' }) }, true)
    await act(async () => { finish({ ok: true, sessionId: 'obsolete' }) })
    expect(api.sftp.close).toHaveBeenCalledWith('obsolete')
    expect(api.sftp.close).not.toHaveBeenCalledWith('active')
    expect(screen.getByText('fixture.txt')).toBeInTheDocument()
    view.unmount()
    expect(api.sftp.close).toHaveBeenCalledWith('active')
  })

  it('switching device discards the old transfer result and releases new-pane busy state', async () => {
    let fail!: (cause: Error) => void
    const { api, view, FilesPane } = await mount({ download: vi.fn()
      .mockImplementation(() => new Promise((_, reject) => { fail = reject })) })
    await userEvent.click(screen.getByTitle('Скачать'))
    api.sftp.open.mockResolvedValue({ ok: true, sessionId: 'new-device-session' })
    await act(async () => { view.rerender(<FilesPane device={{ id: 'new-device' } as DeviceDTO} />) })
    await act(async () => { fail(new Error('obsolete transfer failure')) })
    expect(screen.queryByText('obsolete transfer failure')).toBeNull()
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeEnabled()
    expect(api.sftp.close).toHaveBeenCalledWith('s1')
  })
})
