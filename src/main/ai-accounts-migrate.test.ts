// Слияние записей в аккаунты трогает то, что владелец уже завёл. Ошибка здесь либо склеит
// чужие доступы в один, либо продублирует каналы при повторном запуске.
import { describe, expect, it } from 'vitest'
import { channelFor, planMerge } from './ai-accounts-migrate'
import type { AiAccess } from './types'

const rec = (over: Partial<AiAccess> = {}): AiAccess => ({
  id: 'id',
  kind: 'api',
  provider: 'openai',
  label: 'запись',
  account: '',
  accounts: [],
  channels: [],
  verified: false,
  plan: '',
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
  limits: {},
  notes: null,
  createdAt: 0,
  ...over
})

describe('во что превращается запись', () => {
  it('CLI-инструмент опознаётся по названию и сохраняет посредника', () => {
    const ch = channelFor(
      rec({ label: 'Codex CLI (через router)', thirdParty: true, baseUrl: 'https://cli.neutrino.su/v1', hasKey: true })
    )
    expect(ch.kind).toBe('cli')
    expect(ch.thirdParty).toBe(true)
    expect(ch.baseUrl).toBe('https://cli.neutrino.su/v1')
  })

  it('запись без ключа и без CLI — это веб', () => {
    expect(channelFor(rec({ kind: 'subscription', label: 'ChatGPT' })).kind).toBe('web')
  })
})

describe('слияние в аккаунты', () => {
  it('записи одного провайдера с одной почтой становятся аккаунтом с каналами', () => {
    // Именно это и просил владелец: Codex — это OpenAI, а не отдельный сервис.
    const plans = planMerge([
      rec({ id: 'web', kind: 'subscription', label: 'ChatGPT', account: 'me@example.com', createdAt: 2 }),
      rec({ id: 'cli', provider: 'codex', label: 'Codex CLI', account: 'me@example.com', hasKey: true, createdAt: 1 })
    ])
    expect(plans).toHaveLength(1)
    expect(plans[0].keepId).toBe('web')
    expect(plans[0].label).toBe('me@example.com')
    expect(plans[0].channels.map((c) => c.label).sort()).toEqual(['ChatGPT', 'Codex CLI'])
    expect(plans[0].dropIds).toEqual(['cli'])
  })

  it('разные почты одного провайдера остаются разными аккаунтами', () => {
    const plans = planMerge([
      rec({ id: 'a', account: 'one@example.com' }),
      rec({ id: 'b', account: 'two@example.com' })
    ])
    expect(plans).toHaveLength(2)
  })

  it('записи без почты не склеиваются между собой', () => {
    // У бесплатного тарифа и локальной модели аккаунта может не быть вовсе; склеивать их по
    // одному лишь провайдеру значит выдумывать связь, которой нет.
    const plans = planMerge([rec({ id: 'a', provider: 'groq' }), rec({ id: 'b', provider: 'groq' })])
    expect(plans).toHaveLength(2)
  })

  it('подписка задаёт лицо аккаунта, даже если заведена позже', () => {
    const plans = planMerge([
      rec({ id: 'key', label: 'Ключ', account: 'me@example.com', createdAt: 1 }),
      rec({ id: 'sub', kind: 'subscription', label: 'Подписка', account: 'me@example.com', createdAt: 9 })
    ])
    expect(plans[0].keepId).toBe('sub')
  })

  it('повторный прогон не дублирует каналы', () => {
    const already = rec({
      id: 'a',
      account: 'me@example.com',
      channels: [{ kind: 'web', label: 'ChatGPT' }]
    })
    expect(planMerge([already])[0].channels).toHaveLength(1)
  })

  it('подтверждение переносится с любой из сливаемых записей', () => {
    const plans = planMerge([
      rec({ id: 'a', account: 'me@example.com', verified: false }),
      rec({ id: 'b', account: 'me@example.com', accounts: [{ email: 'me@example.com', verified: true }] })
    ])
    expect(plans[0].verified).toBe(true)
  })
})
