// Слияние записей в аккаунты трогает то, что владелец уже завёл. Ошибка здесь либо склеит
// чужие доступы в один, либо продублирует каналы при повторном запуске.
import { describe, expect, it } from 'vitest'
import { channelFor, planMerge, repairLabel } from './ai-accounts-migrate'
import type { AiAccess } from '../types'

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
    // Имя записи — название сервиса, а не почта: три строки «me@example.com» подряд не
    // различить глазами, а выбирать из них приходится каждый раз.
    expect(plans[0].label).toBe('ChatGPT')
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

describe('починка имени', () => {
  it('запись, переименованная в почту, забирает название у своего канала', () => {
    // Прошлая версия слияния звала записи почтой владельца, и список превращался в столбик
    // одинаковых строк. Настоящее название при этом уцелело — оно уехало в канал.
    const fixed = repairLabel({
      label: 'me@example.com',
      account: 'me@example.com',
      channels: [{ kind: 'web', label: 'ChatGPT' }]
    })
    expect(fixed).toBe('ChatGPT')
  })

  it('нормальное имя не трогается', () => {
    expect(repairLabel({ label: 'Claude Max 5x', account: 'me@example.com', channels: [] })).toBeNull()
  })

  it('без второго названия чинить нечем — почта остаётся', () => {
    expect(
      repairLabel({ label: 'me@example.com', account: 'me@example.com', channels: [{ kind: 'web', label: 'me@example.com' }] })
    ).toBeNull()
  })
})

describe('«other» — это не семья провайдеров', () => {
  it('разные сервисы под «other» не сливаются одной почтой владельца', () => {
    // Под «other» стоит всё, у чего своего провайдера в справочнике нет: Cursor, Brave Search,
    // случайный чат. Общая почта владельца не делает их одним аккаунтом — так ChatInfo.ru
    // однажды стал «каналом» Cursor.
    const plans = planMerge([
      rec({ id: 'cursor', provider: 'other', label: 'Cursor', account: 'me@example.com' }),
      rec({ id: 'chat', provider: 'other', label: 'ChatInfo.ru', account: 'me@example.com' })
    ])
    expect(plans).toHaveLength(2)
    expect(plans.map((p) => p.label).sort()).toEqual(['ChatInfo.ru', 'Cursor'])
  })
})
