// Шапка «Парка»: что она сообщает и чем её можно нажать.
//
// Проверяется не вёрстка, а два решения, которые легко откатить по невнимательности:
// (1) отдельной кнопки «Обновить» здесь нет — опрос идёт сам, и кнопка обещала происходящее;
// (2) способ поторопить опрос при этом сохранён и висит на счётчике «N на связи», причём
// торопит он ОБА контура — быструю живость и полные метрики. Без живости нажатие не помогло бы
// как раз выключенной машине: полный опрос её намеренно обходит.
//
// `window.api` читается модулями на уровне файла, поэтому заглушка ставится ДО импорта.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceDTO } from '@/types'

const device = (over: Partial<DeviceDTO> = {}): DeviceDTO => ({
  id: 'dev-1',
  name: 'Tokyo',
  provider: 'Hetzner',
  role: 'exit',
  kind: 'server',
  ip: '203.0.113.10',
  port: 22,
  user: 'root',
  country: 'Japan',
  flag: '🇯🇵',
  os: 'Ubuntu',
  status: 'online',
  cpu: 0,
  ram: { used: 0, total: 0 },
  cost: { amount: 5, currency: 'USD', usd: 5 },
  consoleUrl: '',
  authType: 'password',
  hasSecret: true,
  notes: null,
  jumpId: null,
  altOs: [],
  mac: null,
  ...over
})

function stubApi(): Record<string, Record<string, ReturnType<typeof vi.fn>>> {
  return {
    alerts: { list: vi.fn().mockResolvedValue([]) },
    devices: {
      list: vi.fn().mockResolvedValue([]),
      liveness: vi.fn().mockResolvedValue({})
    },
    ssh: { probe: vi.fn().mockResolvedValue({}) },
    pc: { metrics: vi.fn().mockResolvedValue({ status: 'unknown' }) }
  }
}

async function mount(devices: DeviceDTO[]): Promise<ReturnType<typeof stubApi>> {
  const api = stubApi()
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { DevicesView } = await import('./DevicesView')
  // Стор берём из того же реестра модулей, что и экран: `resetModules` создаёт новый
  // экземпляр, и статический импорт наверху файла указывал бы на другой стор.
  const { useDevices } = await import('@/store/devices')
  useDevices.setState({ devices, loaded: true, error: null })
  await act(async () => {
    render(<DevicesView />)
  })
  return api
}

describe('шапка «Парка»', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('отдельной кнопки «Обновить» нет', async () => {
    // Живость опрашивается раз в 10 с, метрики раз в 30 (App.tsx). Кнопка обещала действие,
    // которое и так происходит, и вдобавок молча не срабатывала, попадая в идущий проход.
    await mount([device()])
    expect(screen.queryByRole('button', { name: /обновить/i })).toBeNull()
  })

  it('счётчик «на связи» торопит и живость, и метрики', async () => {
    const api = await mount([device()])
    await userEvent.click(screen.getByRole('button', { name: /Опросить парк сейчас/ }))
    await vi.waitFor(() => expect(api.devices.liveness).toHaveBeenCalled())
    await vi.waitFor(() => expect(api.ssh.probe).toHaveBeenCalledWith('dev-1'))
  })

  it('о выключенных машинах говорит счётчик, и только когда они есть', async () => {
    await mount([device(), device({ id: 'dev-2', name: 'Osaka', status: 'offline' })])
    expect(screen.getByText(/1 на связи/)).toBeInTheDocument()
    expect(screen.getByText(/1 не отвечает/)).toBeInTheDocument()
  })

  it('на спокойном парке про «не отвечают» не говорит вовсе', async () => {
    await mount([device()])
    expect(screen.queryByText(/не отвеча/)).toBeNull()
  })
})
