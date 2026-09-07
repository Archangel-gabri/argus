import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { DeviceDTO } from '@/types'

vi.mock('./OverviewPane', () => ({ fmtBps: () => 'synthetic' }))

async function mount(fail: boolean) {
  const api = { metrics: {
    live: vi.fn().mockResolvedValue({ ok: false, state: 'unavailable' }),
    history: fail ? vi.fn().mockRejectedValue(new Error('history unavailable')) : vi.fn().mockResolvedValue([])
  } }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { MetricsPane } = await import('./MetricsPane')
  await act(async () => { render(<MetricsPane device={{ id: 'synthetic' } as DeviceDTO} />) })
}

afterEach(() => vi.restoreAllMocks())

describe('metrics history is not silently absent on IPC failure', () => {
  it('distinguishes rejected history from an empty history', async () => {
    await mount(true)
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить историю метрик')
  })
  it('empty acknowledged history has no error', async () => {
    await mount(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
