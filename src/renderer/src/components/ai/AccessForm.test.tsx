// Форма ИИ-доступа правит часть полей записи, а сохраняет её целиком. Цена ошибки здесь —
// не косметика: подтверждённость аккаунта (`verified`) решает, оставит ли его уборка, которая
// идёт при КАЖДОМ открытии хранилища. Потеряв признак, правка одной заметки приводила к тому,
// что на следующем входе аккаунт исчезал вместе с сохранённым паролем.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AiAccess } from '@/types'

const access = (over: Partial<AiAccess> = {}): AiAccess => ({
  id: 'a1',
  kind: 'subscription',
  provider: 'anthropic',
  label: 'Claude Max',
  account: 'owner@example.com',
  accounts: [
    {
      email: 'owner@example.com',
      verified: true,
      via: 'google',
      lastUsedAt: 1_700_000_000_000,
      loginUrl: 'https://claude.ai',
      hasPassword: true
    }
  ],
  channels: [],
  verified: true,
  plan: 'Max 5x',
  status: 'active',
  subscriptionId: null,
  hasKey: false,
  keyRef: null,
  keyExpiresAt: null,
  baseUrl: null,
  payment: 'card',
  thirdParty: false,
  usedBy: [],
  fallbackId: null,
  limits: { rpm: 10, tpd: 1_000_000, weekTokens: 5_000_000 },
  notes: null,
  createdAt: Date.parse('2026-01-01'),
  ...over
})

const update = vi.fn().mockResolvedValue(true)

vi.mock('@/store/ai', () => ({
  useAi: (selector: (s: unknown) => unknown) =>
    selector({ update, create: vi.fn(), access: [], subs: [] })
}))
vi.mock('@/store/subs', () => ({ useSubs: (selector: (s: unknown) => unknown) => selector({ subs: [] }) }))

describe('сохранение ИИ-доступа', () => {
  beforeEach(() => update.mockClear())

  it('правка заметки не стирает подтверждённость аккаунта и его метаданные', async () => {
    const { AccessForm } = await import('./AccessForm')
    const user = userEvent.setup()
    render(<AccessForm initial={access()} onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: /Сохранить/ }))

    expect(update).toHaveBeenCalled()
    const [, input] = update.mock.calls[0] as [string, { accounts: Array<Record<string, unknown>> }]
    expect(input.accounts[0]).toMatchObject({
      email: 'owner@example.com',
      verified: true,
      via: 'google',
      lastUsedAt: 1_700_000_000_000,
      loginUrl: 'https://claude.ai'
    })
  })

  it('лимиты, которых нет в форме, тоже переживают сохранение', async () => {
    const { AccessForm } = await import('./AccessForm')
    const user = userEvent.setup()
    render(<AccessForm initial={access()} onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: /Сохранить/ }))

    const [, input] = update.mock.calls[0] as [string, { limits: Record<string, unknown> }]
    expect(input.limits).toMatchObject({ tpd: 1_000_000, weekTokens: 5_000_000 })
  })
})

describe('аккаунт, заведённый руками', () => {
  beforeEach(() => update.mockClear())

  it('помечается подтверждённым, иначе уборка сотрёт его на следующем запуске', async () => {
    // Уборка `keepVerified` (src/main/ai-accounts-prune.ts) оставляет только `verified || hasKey`
    // и запускается при каждом открытии хранилища. Ключ аккаунту руками завести негде, значит
    // без этой пометки любая вторая почта провайдера исчезала молча — вместе с паролем.
    const { AccessForm } = await import('./AccessForm')
    const user = userEvent.setup()
    render(<AccessForm initial={access()} onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: /\+ аккаунт/ }))
    const emails = screen.getAllByPlaceholderText(/почта/i)
    await user.type(emails[emails.length - 1], 'second@example.com')
    await user.click(screen.getByRole('button', { name: /Сохранить/ }))

    const [, input] = update.mock.calls[0] as [string, { accounts: Array<Record<string, unknown>> }]
    const added = input.accounts.find((a) => a.email === 'second@example.com')
    expect(added).toBeDefined()
    expect(added?.verified).toBe(true)
  })
})
