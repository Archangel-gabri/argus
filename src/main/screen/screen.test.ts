import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) }
}))
vi.mock('guacamole-lite', () => ({ default: class GuacamoleLite {} }))
vi.mock('../remote/ssh', () => ({ execOnce: vi.fn(), resolveConn: vi.fn() }))
vi.mock('../devices/pc', () => ({ whichOs: vi.fn() }))
vi.mock('../windows', () => ({ createScreenWindow: vi.fn() }))
vi.mock('../vault/vault', () => ({
  getScreenPassword: vi.fn(),
  setScreenPassword: vi.fn(),
  listDevices: vi.fn(() => [])
}))
vi.mock('./agent', () => ({ agentEndpoint: vi.fn(), agentStatus: vi.fn() }))
vi.mock('../remote/session', () => ({ ensureScreenUnlocked: vi.fn() }))

import {
  decideAgentScreenAccess,
  LINUX_PREFLIGHT,
  WIN_PREFLIGHT_PS,
  rememberRdpEnableResult,
  interpretRdpEnable
} from './screen'

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

// ── Включение RDP: вердикт по факту, а не по коду возврата ────────────────────────────────────
// Регрессия на реальный дефект: скрипт шёл с $ErrorActionPreference='SilentlyContinue' и
// заканчивался безусловным 'ok', поэтому отказ по правам рапортовался как успех. Отдельно —
// обещание «только tailnet»: узкое правило лишь добавлялось, встроенные широкие не выключались.
describe('interpretRdpEnable', () => {
  const done = (deny: string, nla: string, rule: string, wide: string): string =>
    `ARGUS_RDP_DENY=${deny}\nARGUS_RDP_NLA=${nla}\nARGUS_RDP_RULE=${rule}\nARGUS_RDP_WIDE=${wide}\nARGUS_RDP_DONE`

  it('всё применилось — успех и честное «только tailnet»', () => {
    const v = interpretRdpEnable(done('0', '1', '1', '0'), true)
    expect(v.ok).toBe(true)
    expect(v.tailnetOnly).toBe(true)
    expect(v.warnings).toEqual([])
  })

  it('RDP остался выключенным — провал, даже если команда «отработала»', () => {
    const v = interpretRdpEnable(done('1', '1', '1', '0'), true)
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/прав администратора/)
  })

  it('широкие правила на 3389 — успех, но НЕ tailnet-only, и об этом сказано', () => {
    const v = interpretRdpEnable(done('0', '1', '1', '2'), true)
    expect(v.ok).toBe(true)
    expect(v.tailnetOnly).toBe(false)
    expect(v.warnings.join(' ')).toMatch(/2 широких правил/)
  })

  it('нет своего правила firewall — доступ ограничен не нами', () => {
    const v = interpretRdpEnable(done('0', '1', '0', '0'), true)
    expect(v.tailnetOnly).toBe(false)
    expect(v.warnings.join(' ')).toMatch(/не создано/)
  })

  it('выключенный NLA не блокирует, но и не замалчивается', () => {
    const v = interpretRdpEnable(done('0', '0', '1', '0'), true)
    expect(v.ok).toBe(true)
    expect(v.warnings.join(' ')).toMatch(/NLA/)
  })

  it('нет маркера завершения — успехом не считается', () => {
    expect(interpretRdpEnable('', true).ok).toBe(false)
    expect(interpretRdpEnable('ok', true).ok).toBe(false)
  })

  it('перехваченная ошибка скрипта попадает в текст', () => {
    const v = interpretRdpEnable('ARGUS_RDP_ERR=Requested registry access is not allowed', false)
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/registry access/)
  })
})

// ── Незакреплённый пароль не переживает блокировку ─────────────────────────────────────────────
// Пароль, набранный с галочкой «запомнить», но не подтверждённый рабочим столом, лежит в памяти
// ОТКРЫТЫМ ТЕКСТОМ и ждёт подтверждения. Смысл границы блокировки — уронить секреты ДО закрытия
// базы; без явной очистки он переживал и блокировку, и удаление устройства, оставаясь в куче
// main-процесса до конца его жизни — а значит, в дампе и в странице подкачки.
describe('границы жизни неподтверждённого пароля экрана', () => {
  it('closeAllScreens очищает отложенные пароли', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./screen.ts', import.meta.url), 'utf8')
    )
    const body = src.slice(src.indexOf('export function closeAllScreens'))
    expect(body).toContain('pendingPasswords.clear()')
  })

  it('closeDeviceScreens забывает пароль именно этого устройства', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./screen.ts', import.meta.url), 'utf8')
    )
    const start = src.indexOf('export function closeDeviceScreens')
    const body = src.slice(start, src.indexOf('export function closeAllScreens', start))
    expect(body).toContain('pendingPasswords.delete(deviceId)')
  })
})
