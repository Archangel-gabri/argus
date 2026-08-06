// Вход в кабинет банка — единственный способ обновить остаток российского счёта: API у них нет.
// Кнопка была привязана к признаку «остаток уже читается из сессии», то есть появлялась только
// у того, кто уже вошёл. Счёт, заведённый руками, этого признака не имеет никогда.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AccountList } from './AccountList'
import type { FinanceAccount } from '@/types'

vi.mock('@/store/accounts', () => ({
  useAccounts: (selector: (s: unknown) => unknown) =>
    selector({
      update: vi.fn(),
      remove: vi.fn(),
      setCreds: vi.fn(),
      bankLogin: vi.fn(),
      bankSessions: {},
      checkBankSessions: vi.fn()
    })
}))

const account = (over: Partial<FinanceAccount> = {}): FinanceAccount =>
  ({
    id: 'a1',
    kind: 'bank',
    name: 'Т-Банк',
    institution: 'Т-Банк',
    currency: 'RUB',
    balance: null,
    source: 'manual',
    updatedAt: Date.now(),
    hasCreds: false,
    ...over
  }) as FinanceAccount

describe('строка счёта', () => {
  it('даёт войти в кабинет банку, заведённому руками', () => {
    render(<AccountList accounts={[account()]} />)
    expect(screen.getByRole('button', { name: /Войти в Т-Банк/i })).toBeInTheDocument()
  })

  it('не предлагает вход тому, у кого кабинета нет', () => {
    // У биржи вход не через кабинет, а по ключу — предлагать ей «войти» значит врать.
    render(<AccountList accounts={[account({ kind: 'exchange', name: 'Bybit', institution: 'Bybit' })]} />)
    expect(screen.queryByRole('button', { name: /Войти/i })).toBeNull()
  })
})
