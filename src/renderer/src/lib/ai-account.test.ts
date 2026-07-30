import { describe, expect, it } from 'vitest'
import { aiSummary, providerChangeError } from './ai-account'
import type { AiAccount, AiCheck } from '@/types'

const account = (id: string, provider = 'openrouter', hasKey = true): AiAccount => ({
  id,
  provider,
  label: id,
  plan: '',
  hasKey,
  notes: null
})

describe('честная сводка AI-доступов', () => {
  it('не превращает ещё не проверенные ключи и кредит в нули', () => {
    expect(aiSummary([account('a')], {})).toEqual({ workingKeys: null, totalCredit: null })
  })

  it('считает квоту подтверждённым ключом, но не выдумывает остаток', () => {
    const checks: Record<string, AiCheck> = { a: { status: 'quota' } }
    expect(aiSummary([account('a', 'openai')], checks)).toEqual({ workingKeys: '1/1', totalCredit: null })
  })

  it('показывает OpenRouter-итог только когда известен остаток каждого сохранённого ключа', () => {
    const accounts = [account('a'), account('b')]
    expect(
      aiSummary(accounts, {
        a: { status: 'valid', remaining: 12 },
        b: { status: 'error', detail: 'Сеть: тайм-аут проверки' }
      })
    ).toMatchObject({ totalCredit: null })
    expect(
      aiSummary(accounts, {
        a: { status: 'valid', remaining: 12 },
        b: { status: 'valid', remaining: 3 }
      })
    ).toMatchObject({ totalCredit: 15 })
  })
})

describe('смена провайдера AI-аккаунта', () => {
  it('не позволяет молча отправить сохранённый ключ новому провайдеру', () => {
    expect(providerChangeError('openai', 'anthropic', '')).toBe(
      'При смене провайдера введи ключ для нового сервиса'
    )
  })

  it('не требует повторного ввода при правке того же провайдера', () => {
    expect(providerChangeError('openai', 'openai', '')).toBeNull()
    expect(providerChangeError('openai', 'anthropic', 'new-key')).toBeNull()
  })
})
