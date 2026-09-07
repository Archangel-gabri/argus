import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({ checkStrength: vi.fn(), policy: vi.fn(), initialize: vi.fn() }))
vi.mock('@/lib/password-strength', () => ({
  checkStrength: mocks.checkStrength, masterPasswordPolicyError: mocks.policy,
  MIN_PASSWORD_SCORE: 3, formatCrackTime: () => 'synthetic'
}))
vi.mock('@/store/vault', () => ({ useVault: () => ({
  status: 'uninitialized', error: null, busy: false, keyringBackend: 'kwallet',
  initialize: mocks.initialize, unlock: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined)
}) }))
import { LockScreen } from './LockScreen'

afterEach(() => vi.resetAllMocks())

describe('master password checker unavailable', () => {
  it('failed lazy dictionary load is visible and keeps setup blocked', async () => {
    mocks.checkStrength.mockRejectedValue(new Error('dictionary unavailable'))
    render(<LockScreen />)
    fireEvent.change(screen.getByLabelText('Новый мастер-пароль'), { target: { value: 'synthetic-password' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось проверить надёжность пароля')
    expect(screen.getByRole('button', { name: 'Создать' })).toBeDisabled()
  })

  it('failed authoritative submit check never calls initialize or leaks exception details', async () => {
    mocks.checkStrength.mockResolvedValue({ score: 4, crackTimes: { offlineSlowHashingXPerSecond: { seconds: 1000 } } })
    mocks.policy.mockRejectedValue(new Error('synthetic-sensitive-error'))
    render(<LockScreen />)
    fireEvent.change(screen.getByLabelText('Новый мастер-пароль'), { target: { value: 'synthetic-password' } })
    fireEvent.change(screen.getByLabelText('Мастер-пароль ещё раз'), { target: { value: 'synthetic-password' } })
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось проверить пароль или открыть хранилище')
    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('synthetic-sensitive-error')
  })
})
