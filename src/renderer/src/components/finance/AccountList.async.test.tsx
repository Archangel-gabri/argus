import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FinanceAccount } from '@/types'

const mocks = vi.hoisted(() => ({ setCreds: vi.fn(), update: vi.fn() }))
vi.mock('@/store/accounts', () => ({ useAccounts: (selector: (state: unknown) => unknown) => selector({
  ...mocks, remove: vi.fn(), bankLogin: vi.fn(), bankSessions: {}, balanceIssues: {}, checkBankSessions: vi.fn()
}) }))
import { AccountList } from './AccountList'
const account = { id: 'synthetic', name: 'Synthetic broker', institution: 'Synthetic', kind: 'broker', currency: 'USD',
  balance: null, source: 'manual', hasCreds: false } as FinanceAccount

afterEach(() => vi.resetAllMocks())

describe('account save failure', () => {
  it('credential rejection keeps the form open, releases busy and hides sensitive exception details', async () => {
    mocks.setCreds.mockRejectedValue(new Error('synthetic-sensitive-error'))
    render(<AccountList accounts={[account]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Ключи Synthetic broker' }))
    await userEvent.type(screen.getByLabelText('Токен'), 'synthetic-token')
    await userEvent.click(screen.getByRole('button', { name: /Сохранить/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить ключи')
    expect(screen.getByRole('button', { name: /Сохранить/ })).toBeEnabled()
    expect(document.body.textContent).not.toContain('synthetic-sensitive-error')
  })
})
