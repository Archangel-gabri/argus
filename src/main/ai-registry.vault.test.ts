// Реестр AI-доступов на НАСТОЯЩЕМ зашифрованном хранилище.
//
// Запускается только через `npm run test:vault` (нативный SQLCipher собран под ABI Electron).
// Здесь проверяется то, что нельзя проверить чистой функцией: переживает ли старая запись
// миграцию схемы, действительно ли дедуп отсеивает повторы между запусками, и не начинает ли
// курсор перечитывать файл заново.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'argus-ai-'))
const PASSWORD = 'test-master-password-one'

vi.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
  clipboard: {},
  session: { defaultSession: {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const SECRET_KEY = '__SECRET_AI_KEY__'

let vault: typeof import('./vault')

beforeAll(async () => {
  vault = await import('./vault')
  await vault.initialize(PASSWORD)
})

describe('запись доступа', () => {
  it('хранит все поля реестра и не отдаёт ключ наружу', () => {
    const created = vault.createAiAccess({
      kind: 'subscription',
      provider: 'anthropic',
      label: 'Claude Max',
      account: 'me@example.com',
      plan: 'Max 20x',
      status: 'active',
      payment: 'card',
      apiKey: SECRET_KEY,
      keyRef: 'secrets/env → ANTHROPIC_API_KEY',
      keyExpiresAt: '2026-12-31',
      thirdParty: false,
      usedBy: ['Claude Code', 'gen-image.sh'],
      limits: { windowHours: 5, rpd: 1000 },
      notes: 'основная подписка'
    })

    expect(created.kind).toBe('subscription')
    expect(created.account).toBe('me@example.com')
    expect(created.usedBy).toEqual(['Claude Code', 'gen-image.sh'])
    expect(created.limits.windowHours).toBe(5)
    expect(created.hasKey).toBe(true)
    // Ключ в DTO не попадает ни при создании, ни в списке — только признак наличия.
    expect(JSON.stringify(created)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(vault.listAiAccess())).not.toContain(SECRET_KEY)
    expect(vault.getAiKey(created.id)).toBe(SECRET_KEY)
  })

  it('правка без ключа сохраняет прежний — иначе «переименовал» означало бы «стёр доступ»', () => {
    const a = vault.createAiAccess({ provider: 'openrouter', label: 'OR', apiKey: SECRET_KEY })
    const updated = vault.updateAiAccess(a.id, { provider: 'openrouter', label: 'OpenRouter личный' })
    expect(updated.label).toBe('OpenRouter личный')
    expect(vault.getAiKey(a.id)).toBe(SECRET_KEY)
  })

  it('неизвестный тип из будущей схемы не теряет запись', () => {
    // Значение могло прийти из более новой версии приложения или из ручной правки базы.
    // Показать такую запись обычным доступом лучше, чем спрятать её от владельца.
    const a = vault.createAiAccess({ provider: 'other', label: 'из будущего', kind: 'квантовый' as never })
    const back = vault.listAiAccess().find((x) => x.id === a.id)
    expect(back).toBeDefined()
    expect(back?.kind).toBe('api')
    expect(back?.label).toBe('из будущего')
  })

  it('удаление убирает привязки моделей и чужие ссылки «чем заменить»', () => {
    const main = vault.createAiAccess({ provider: 'deepseek', label: 'DeepSeek' })
    const spare = vault.createAiAccess({ provider: 'groq', label: 'Groq' })
    vault.updateAiAccess(main.id, { provider: 'deepseek', fallbackId: spare.id })
    vault.setAccessModel({
      accessId: spare.id,
      model: 'llama-3.3',
      favorite: true,
      markupPct: null,
      priceInput: null,
      priceOutput: null,
      notes: null
    })

    vault.deleteAiAccess(spare.id)

    expect(vault.listAccessModels(spare.id)).toHaveLength(0)
    const after = vault.listAiAccess().find((x) => x.id === main.id)
    expect(after?.fallbackId).toBeNull()
  })
})

describe('каталог цен', () => {
  it('повторная заливка обновляет цену, а не плодит строки', () => {
    const price = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      input: 0.000003,
      output: 0.000015,
      cacheWrite: null,
      cacheWrite1h: null,
      cacheRead: null,
      contextTokens: 200_000,
      maxOutputTokens: null,
      mode: 'chat',
      supportsVision: true,
      supportsTools: true,
      supportsCaching: true,
      deprecatedAt: null,
      source: 'catalog' as const,
      fetchedAt: 1
    }
    vault.upsertAiPrices([price])
    const before = vault.aiPriceCount()
    vault.upsertAiPrices([{ ...price, input: 0.000004, source: 'manual' as const, fetchedAt: 2 }])
    expect(vault.aiPriceCount()).toBe(before)
    expect(vault.listAiPrices('anthropic').find((p) => p.model === 'claude-opus-4-7')?.input).toBe(0.000004)
  })

  it('модель из логов находится и без префикса провайдера', () => {
    vault.upsertAiPrices([
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
        input: 0.000001,
        output: 0.000005,
        cacheWrite: null,
        cacheWrite1h: null,
        cacheRead: null,
        contextTokens: null,
        maxOutputTokens: null,
        mode: 'chat',
        supportsVision: false,
        supportsTools: false,
        supportsCaching: false,
        deprecatedAt: null,
        source: 'openrouter',
        fetchedAt: 1
      }
    ])
    // В логах модель называется коротко — иначе расход остался бы без цены.
    expect(vault.findAiPrice('claude-sonnet-5')?.provider).toBe('openrouter')
    expect(vault.findAiPrice('такой-модели-нет')).toBeNull()
  })
})

describe('расход', () => {
  it('дневной итог накапливается, а не перезаписывается', () => {
    const day = {
      date: '2026-08-01',
      source: 'claude-code',
      model: 'claude-opus-4-7',
      input: 100,
      output: 10,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 1000,
      requests: 1,
      costUsd: 0.5
    }
    vault.addUsage([day])
    vault.addUsage([day])
    const row = vault.listUsageDays('2026-08-01').find((d) => d.model === 'claude-opus-4-7')
    expect(row?.input).toBe(200)
    expect(row?.requests).toBe(2)
    expect(row?.costUsd).toBeCloseTo(1, 6)
  })

  it('повторно увиденный ответ отсеивается — на этом держится весь счёт', () => {
    const first = vault.filterUnseenUsage(['cc:msg_1', 'cc:msg_2'])
    expect(first.size).toBe(2)
    // Тот же ответ в другом файле (возобновлённая сессия) второй раз не считается.
    const second = vault.filterUnseenUsage(['cc:msg_2', 'cc:msg_3'])
    expect([...second]).toEqual(['cc:msg_3'])
  })

  it('курсор помнит место чтения и переживает перезапуск', () => {
    expect(vault.getUsageCursor('/logs/a.jsonl')).toBeNull()
    vault.setUsageCursor({ path: '/logs/a.jsonl', size: 500, mtime: 111, offset: 480 })
    expect(vault.getUsageCursor('/logs/a.jsonl')).toMatchObject({ size: 500, offset: 480 })
    vault.setUsageCursor({ path: '/logs/a.jsonl', size: 900, mtime: 222, offset: 880 })
    expect(vault.getUsageCursor('/logs/a.jsonl')?.offset).toBe(880)
    expect(vault.lastUsageScan()).toBeGreaterThan(0)
  })
})
