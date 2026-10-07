import { beforeEach, describe, expect, it, vi } from 'vitest'

// Оговорка «RDP открыт не только из tailnet» раньше уходила только в console.warn:
// screenStart выбрасывал warnings, и человек не видел, что порт доступен из локальной сети.

const mocks = vi.hoisted(() => ({
  execOnce: vi.fn(),
  resolveConn: vi.fn(),
  whichOs: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) }
}))
vi.mock('guacamole-lite', () => ({ default: class GuacamoleLite {} }))
vi.mock('../remote/ssh', () => ({ execOnce: mocks.execOnce, resolveConn: mocks.resolveConn }))
vi.mock('../devices/pc', () => ({
  whichOs: mocks.whichOs,
  osReachable: () => true,
  unreachableReason: () => 'недоступен'
}))
vi.mock('../windows', () => ({ createScreenWindow: vi.fn() }))
vi.mock('../vault/vault', () => ({
  getScreenPassword: vi.fn(),
  setScreenPassword: vi.fn(),
  listDevices: vi.fn(() => []),
  isUnlocked: vi.fn(() => true)
}))
vi.mock('./agent', () => ({ agentEndpoint: vi.fn(), agentStatus: vi.fn() }))
vi.mock('../remote/session', () => ({ ensureScreenUnlocked: vi.fn() }))
// guacd «жив»: сокет сразу сообщает о соединении, без настоящей сети и Docker.
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  const connect = (): unknown => {
    const s = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
    queueMicrotask(() => s.emit('connect'))
    return s
  }
  return { default: { connect }, connect }
})
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events')
  const createServer = (): unknown =>
    Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, cb: () => void) => queueMicrotask(cb),
      address: () => ({ port: 41234 }),
      close: vi.fn()
    })
  return { default: { createServer }, createServer }
})

import { screenStart } from './screen'

const rdpOutput = (wide: number): string =>
  ['ARGUS_RDP_DENY=0', 'ARGUS_RDP_NLA=1', 'ARGUS_RDP_RULE=1', `ARGUS_RDP_WIDE=${wide}`, 'ARGUS_RDP_DONE'].join('\n')

describe('screenStart: оговорки включения RDP', () => {
  beforeEach(() => {
    mocks.whichOs.mockResolvedValue({ current: 'Windows', family: 'windows' })
    mocks.resolveConn.mockResolvedValue({ host: '100.64.0.7', user: 'vadim' })
  })

  it('отдаёт наружу предупреждение о широких правилах firewall, а не только пишет в консоль', async () => {
    mocks.execOnce.mockResolvedValue({ ok: true, output: rdpOutput(2) })
    const r = await screenStart('pc-wide', { password: 'x' })
    expect(r.ok).toBe(true)
    expect(r.warnings?.join(' ')).toMatch(/2 широких правил/)
  })

  it('не теряет оговорку при повторном открытии, когда включение RDP уже пропускается', async () => {
    mocks.execOnce.mockResolvedValue({ ok: true, output: rdpOutput(1) })
    await screenStart('pc-again', { password: 'x' })
    mocks.execOnce.mockClear()
    const second = await screenStart('pc-again', { password: 'x' })
    expect(mocks.execOnce).not.toHaveBeenCalled()
    expect(second.warnings?.join(' ')).toMatch(/1 широких правил/)
  })

  it('без оговорок поле warnings не появляется', async () => {
    mocks.execOnce.mockResolvedValue({ ok: true, output: rdpOutput(0) })
    const r = await screenStart('pc-clean', { password: 'x' })
    expect(r.ok).toBe(true)
    expect(r.warnings).toBeUndefined()
  })
})
