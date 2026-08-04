import { describe, expect, it } from 'vitest'
import { parseEnvFile } from './ai-seed'

// Файл ключей владельца пишется руками: там встречаются и export, и кавычки, и комментарии.
// Ошибка разбора здесь тихо оставляет доступ без ключа — с виду всё завелось, а проверка
// показывает «нет ключа».
describe('разбор env-файла с ключами', () => {
  it('берёт пары ключ-значение и не спотыкается о комментарии и пустые строки', () => {
    const env = parseEnvFile('# ключи\n\nTAVILY_API_KEY=tvly-123\n\n# конец\nEXA_API_KEY=exa-456\n')
    expect(env).toEqual({ TAVILY_API_KEY: 'tvly-123', EXA_API_KEY: 'exa-456' })
  })

  it('снимает export и кавычки, но не трогает содержимое значения', () => {
    const env = parseEnvFile(`export A="value-with-dash"\nB='single'\nC=no-quotes\n`)
    expect(env).toEqual({ A: 'value-with-dash', B: 'single', C: 'no-quotes' })
  })

  it('значение со знаком равенства внутри остаётся целым', () => {
    // База64 и URL с параметрами — обычное дело для ключей; резать по первому «=» обязательно.
    expect(parseEnvFile('K=abc=def==')).toEqual({ K: 'abc=def==' })
  })

  it('строки без имени переменной игнорируются', () => {
    expect(parseEnvFile('=пусто\nпросто текст\n')).toEqual({})
  })
})

import { pickMissing, seedLabel } from './ai-seed'

// Дозасев по имени, а не «только на пустой таблице»: у владельца в реестре уже могли лежать
// записи с прошлых версий, и один такой доступ не должен закрывать дорогу остальным.
describe('что досеивать в реестр', () => {
  const item = (label?: string, provider = 'openai'): { label?: string; provider: string } => ({ label, provider })

  it('пропускает то, что уже заведено, независимо от регистра и пробелов', () => {
    const missing = pickMissing(['OpenRouter', '  claude max 5x '], [item('openrouter'), item('Claude Max 5x'), item('Groq')])
    expect(missing.map((m) => m.label)).toEqual(['Groq'])
  })

  it('запись без метки узнаётся по имени провайдера', () => {
    expect(seedLabel(item(undefined, 'anthropic'))).toBe('anthropic')
    expect(pickMissing(['anthropic'], [item(undefined, 'anthropic')])).toHaveLength(0)
  })

  it('дубль внутри самого файла заводится один раз', () => {
    // Иначе повтор в файле молча создаст две одинаковые записи, и человек будет искать,
    // откуда взялась вторая.
    expect(pickMissing([], [item('Groq'), item('groq')])).toHaveLength(1)
  })

  it('пустой реестр принимает всё', () => {
    expect(pickMissing([], [item('A'), item('B')])).toHaveLength(2)
  })
})

import { fillGaps } from './ai-seed'
import type { AiAccess } from './types'

const saved = (over: Partial<AiAccess> = {}): AiAccess => ({
  id: 'a1',
  kind: 'subscription',
  provider: 'openai',
  label: 'ChatGPT',
  account: '',
  accounts: [],
  channels: [],
  verified: true,
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

// Дозасев по именам решал половину задачи: когда в файл добавляли новые поля, запись, созданная
// прошлой версией, оставалась прежней — и владелец не видел ни списка аккаунтов, ни лимитов.
describe('дополнение уже заведённой записи', () => {
  it('добавляет то, чего в записи нет', () => {
    const patch = fillGaps(saved(), {
      provider: 'openai',
      accounts: [{ email: 'me@example.com', plan: 'free' }],
      limits: { windowHours: 5 },
      usedBy: ['Codex CLI']
    })
    expect(patch?.accounts).toHaveLength(1)
    expect(patch?.limits?.windowHours).toBe(5)
    expect(patch?.usedBy).toEqual(['Codex CLI'])
  })

  it('НЕ трогает то, что владелец уже заполнил', () => {
    const patch = fillGaps(
      saved({ accounts: [{ email: 'свой@example.com' }], account: 'свой', usedBy: ['своё'] }),
      { provider: 'openai', accounts: [{ email: 'из-файла@example.com' }], account: 'из файла', usedBy: ['из файла'] }
    )
    expect(patch).toBeNull()
  })

  it('лимиты сливаются по одному полю — свой потолок не теряется', () => {
    // Иначе появление длительности окна в файле стёрло бы вручную выставленный потолок.
    const patch = fillGaps(saved({ limits: { windowTokens: 900_000 } }), {
      provider: 'openai',
      limits: { windowHours: 5, windowTokens: 123 }
    })
    expect(patch?.limits).toEqual({ windowTokens: 900_000, windowHours: 5 })
  })

  it('нечего дополнять — правки нет', () => {
    expect(fillGaps(saved(), { provider: 'openai' })).toBeNull()
  })
})

describe('проверенные факты из файла', () => {
  it('перезаписывают прежнюю догадку', () => {
    // Иначе однажды записанное «тариф не подтверждён» остаётся навсегда: поле не пустое, а
    // значит дополнению не подлежит, и результату живой проверки некуда деться.
    const patch = fillGaps(saved({ plan: 'тариф не подтверждён' }), {
      provider: 'openai',
      plan: 'Free',
      verified: true,
      notes: 'вошёл 04.08.2026'
    })
    expect(patch?.plan).toBe('Free')
    expect(patch?.notes).toBe('вошёл 04.08.2026')
  })

  it('непроверенные данные чужого поля не трогают', () => {
    expect(fillGaps(saved({ plan: 'мой тариф' }), { provider: 'openai', plan: 'из файла' })).toBeNull()
  })
})

describe('выбывшие записи', () => {
  it('убираются по имени, а прочие не трогаются', () => {
    // Засев только добавляет и дополняет, поэтому однажды заведённая запись жила бы вечно.
    // Удаление должно быть явным и поимённым — иначе можно снести заведённое руками.
    const retire = new Set(['groq', 'cerebras'])
    const registry = ['Claude Max 5x', 'Groq', 'Cerebras', 'Мой личный доступ']
    const removed = registry.filter((label) => retire.has(label.trim().toLowerCase()))
    const kept = registry.filter((label) => !retire.has(label.trim().toLowerCase()))
    expect(removed).toEqual(['Groq', 'Cerebras'])
    expect(kept).toEqual(['Claude Max 5x', 'Мой личный доступ'])
  })
})

describe('метка, ставшая каналом', () => {
  it('не заводится заново', () => {
    // После слияния «Codex CLI» — не запись, а канал аккаунта OpenAI. Если засев смотрит только
    // на label, он заведёт запись снова, слияние сольёт её обратно и удалит — и так каждый
    // запуск, с дрожащими идентификаторами и датами создания.
    const existing = [{ label: 'ChatGPT (основной аккаунт)', channels: [{ label: 'Codex CLI' }] }]
    const labels = existing.flatMap((a) => [a.label, ...a.channels.map((c) => c.label)])
    const missing = pickMissing(labels, [
      { label: 'Codex CLI', provider: 'openai' },
      { label: 'Новый сервис', provider: 'other' }
    ])
    expect(missing.map((m) => m.label)).toEqual(['Новый сервис'])
  })
})
