import { describe, expect, it, vi } from 'vitest'
import { runLockdown, type LockdownActions } from './lockdown-policy'

describe('блокировка Argus', () => {
  it('отзывает каждый живой доступ до закрытия vault', () => {
    const order: string[] = []
    const action = (name: string) => vi.fn(() => order.push(name))
    const actions: LockdownActions = {
      revokePending: action('revoke'),
      closeScreens: action('screen'),
      closeSsh: action('ssh'),
      closeSftp: action('sftp'),
      closeForwards: action('forward'),
      clearAgentPins: action('pins'),
      clearAlerts: action('alerts'),
      clearInFlight: action('inflight'),
      clearReachMemory: action('reach'),
      lockVault: action('vault')
    }

    runLockdown(actions)

    expect(order).toEqual(['revoke', 'screen', 'ssh', 'sftp', 'forward', 'pins', 'alerts', 'inflight', 'reach', 'vault'])
    for (const fn of Object.values(actions)) expect(fn).toHaveBeenCalledOnce()
  })

  it.each([
    'revokePending', 'closeScreens', 'closeSsh', 'closeSftp', 'closeForwards',
    'clearAgentPins', 'clearAlerts', 'clearInFlight', 'clearReachMemory'
  ] as const)(
    'не оставляет остальные доступы открытыми, если %s уже сломан',
    (broken) => {
      const called: string[] = []
      const action = (name: string) => vi.fn(() => called.push(name))
      const actions: LockdownActions = {
        revokePending: action('revoke'),
        closeScreens: action('screen'),
        closeSsh: action('ssh'),
        closeSftp: action('sftp'),
        closeForwards: action('forward'),
        clearAgentPins: action('pins'),
        clearAlerts: action('alerts'),
        clearInFlight: action('inflight'),
        clearReachMemory: action('reach'),
        lockVault: action('vault')
      }
      actions[broken] = vi.fn(() => {
        throw new Error('уже закрыт')
      })

      expect(() => runLockdown(actions)).not.toThrow()
      expect(actions.lockVault).toHaveBeenCalledOnce()
      expect(Object.values(actions).every((fn) => vi.mocked(fn).mock.calls.length === 1)).toBe(true)
    }
  )
})
