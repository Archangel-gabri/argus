import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) }
}))
vi.mock('guacamole-lite', () => ({ default: class GuacamoleLite {} }))
vi.mock('./ssh', () => ({ execOnce: vi.fn(), resolveConn: vi.fn() }))
vi.mock('./pc', () => ({ whichOs: vi.fn() }))
vi.mock('./windows', () => ({ createScreenWindow: vi.fn() }))
vi.mock('./vault', () => ({
  getScreenPassword: vi.fn(),
  setScreenPassword: vi.fn(),
  listDevices: vi.fn(() => [])
}))
vi.mock('./agent', () => ({ agentEndpoint: vi.fn(), agentStatus: vi.fn() }))
vi.mock('./session', () => ({ ensureScreenUnlocked: vi.fn() }))

import { decideAgentScreenAccess, LINUX_PREFLIGHT, WIN_PREFLIGHT_PS, rememberRdpEnableResult } from './screen'

describe('preflight агента', () => {
  it('ищет ровно те имена, которые устанавливает provisioning', () => {
    expect(LINUX_PREFLIGHT).toContain('$HOME/.argus/argus-agent')
    expect(LINUX_PREFLIGHT).not.toContain('argus-screen-agent')
    expect(WIN_PREFLIGHT_PS).toContain('Argus\\argus-agent.exe')
    expect(WIN_PREFLIGHT_PS).not.toContain('argus-screen-agent.exe')
  })
})

describe('кэш включённого RDP', () => {
  it('запоминает устройство только после доказанного успеха команды', () => {
    const ready = new Set<string>()
    expect(rememberRdpEnableResult(ready, 'pc-1', { ok: false })).toBe(false)
    expect(ready.has('pc-1')).toBe(false)

    expect(rememberRdpEnableResult(ready, 'pc-1', { ok: true })).toBe(true)
    expect(ready.has('pc-1')).toBe(true)
  })
})

describe('допуск агента к физическому экрану', () => {
  it('открывает Linux/Windows агент только после подтверждённого безопасного состояния', () => {
    expect(decideAgentScreenAccess('linux', { state: 'already', sessionId: '2' })).toEqual({ action: 'open' })
    expect(decideAgentScreenAccess('linux', { state: 'unlocked', sessionId: '2' })).toEqual({ action: 'open' })
    expect(
      decideAgentScreenAccess('linux', { state: 'refused', sessionId: '2', detail: 'замок остался' })
    ).toMatchObject({ action: 'reject' })
    expect(decideAgentScreenAccess('linux', { state: 'unsupported', reason: 'LockedHint неизвестен' })).toMatchObject({
      action: 'reject'
    })
  })

  it('отправляет запертую/непроверенную Windows в RDP, а macOS не прогоняет через Linux loginctl', () => {
    expect(
      decideAgentScreenAccess('windows', { state: 'locked-no-unlock', reason: 'не удалось проверить блокировку' })
    ).toEqual({ action: 'fallback', reason: 'не удалось проверить блокировку' })
    expect(decideAgentScreenAccess('darwin', { state: 'unsupported', reason: 'нет loginctl' })).toEqual({ action: 'open' })
  })
})
