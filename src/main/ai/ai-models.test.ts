// Список моделей приходит от разных провайдеров в трёх несовместимых формах. Ошибка разбора
// оставляет доступ с пустым списком — и выглядит это как «провайдер ничего не отдал».
import { describe, expect, it } from 'vitest'
import { modelsEndpoint, parseGeminiShape, parseOllamaShape } from './ai-models'
import type { AiAccess } from '../types'

const access = (over: Partial<AiAccess> = {}): AiAccess => ({
  id: 'a',
  kind: 'api',
  provider: 'openai',
  label: 'x',
  account: '',
  accounts: [],
  channels: [],
  verified: true,
  plan: '',
  status: 'active',
  subscriptionId: null,
  hasKey: true,
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

describe('куда идти за списком моделей', () => {
  it('адрес записи важнее умолчания — у роутера он свой', () => {
    const e = modelsEndpoint(access({ provider: 'openai', baseUrl: 'https://cli.neutrino.su/v1' }))
    expect(e?.url).toBe('https://cli.neutrino.su/v1/models')
  })

  it('хвостовой слэш не превращается в двойной', () => {
    const e = modelsEndpoint(access({ baseUrl: 'https://api.example.com/v1/' }))
    expect(e?.url).toBe('https://api.example.com/v1/models')
  })

  it('у Anthropic и Google свои формы ответа', () => {
    expect(modelsEndpoint(access({ provider: 'anthropic' }))?.shape).toBe('openai')
    expect(modelsEndpoint(access({ provider: 'gemini' }))?.shape).toBe('gemini')
    expect(modelsEndpoint(access({ provider: 'ollama', kind: 'local' }))?.shape).toBe('ollama')
  })

  it('незнакомый провайдер без адреса спрашивать негде', () => {
    expect(modelsEndpoint(access({ provider: 'чтототакое', baseUrl: null }))).toBeNull()
  })
})

describe('разбор ответов', () => {
  it('Google отдаёт имена ресурсов — префикс не часть имени модели', () => {
    // В каталоге цен модель зовётся «gemini-2.5-flash», а не «models/gemini-2.5-flash»:
    // с префиксом цена не находится никогда.
    const models = parseGeminiShape({
      models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1_048_576 }]
    })
    expect(models[0]).toEqual({ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextTokens: 1_048_576 })
  })

  it('Ollama отдаёт установленные модели', () => {
    expect(parseOllamaShape({ models: [{ name: 'qwen2.5:14b' }, { model: 'llama3.3' }] }).map((m) => m.id)).toEqual([
      'qwen2.5:14b',
      'llama3.3'
    ])
  })

  it('мусор вместо ответа даёт пустой список, а не падение', () => {
    expect(parseGeminiShape(null)).toEqual([])
    expect(parseOllamaShape({ models: 'нет' })).toEqual([])
  })
})

describe('адрес списка моделей', () => {
  const access = (over: Record<string, unknown>): Parameters<typeof modelsEndpoint>[0] =>
    ({ provider: 'openai', kind: 'subscription', baseUrl: null, channels: [], ...over }) as never

  it('берётся у канала, если на записи его нет', () => {
    // Ключ Codex выписан сторонним роутером и живёт в канале вместе со своим адресом. Без этого
    // список спрашивался у api.openai.com роутерным ключом — 401 и молчаливое «не обновилось».
    const r = modelsEndpoint(
      access({ channels: [{ kind: 'cli', label: 'Codex CLI', hasKey: true, baseUrl: 'https://cli.neutrino.su/v1' }] })
    )
    expect(r?.url).toBe('https://cli.neutrino.su/v1/models')
  })

  it('адрес записи важнее канального', () => {
    const r = modelsEndpoint(
      access({ baseUrl: 'https://a/v1', channels: [{ kind: 'api', label: 'k', hasKey: true, baseUrl: 'https://b/v1' }] })
    )
    expect(r?.url).toBe('https://a/v1/models')
  })

  it('хвостовой слэш срезается у любого источника адреса', () => {
    expect(modelsEndpoint(access({ baseUrl: 'https://a/v1/' }))?.url).toBe('https://a/v1/models')
    expect(
      modelsEndpoint(access({ channels: [{ kind: 'api', label: 'k', hasKey: true, baseUrl: 'https://b/v1/' }] }))?.url
    ).toBe('https://b/v1/models')
  })
})
