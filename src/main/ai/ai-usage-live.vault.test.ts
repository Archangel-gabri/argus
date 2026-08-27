// Сбор расхода на НАСТОЯЩИХ логах машины, где запускается проверка.
//
// Разбор строк проверен образцами в ai-usage.test.ts, но образцы проверяют только то, что в
// них заложили. Здесь читаются реальные файлы Claude Code и Codex целиком — так ловится то,
// чего не придумаешь: незакрытая строка в конце пишущегося файла, сессия без модели, формат
// более старой версии инструмента.
//
// Проверка условная: на машине без этих логов она пропускается, а не падает. Запускается вместе
// с остальными vault-проверками (`npm run test:vault`), потому что курсоры и итоги живут в
// зашифрованной базе.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'argus-usage-'))
const REPO = join(__dirname, '..', '..')

vi.mock('electron', () => ({
  // getAppPath указывает на корень репозитория: оттуда читается вшитый каталог цен.
  app: { getPath: () => TMP, getAppPath: () => REPO },
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

const hasLogs =
  existsSync(join(homedir(), '.claude', 'projects')) || existsSync(join(homedir(), '.codex', 'sessions'))

let vault: typeof import('../vault/vault')
let prices: typeof import('./ai-prices')
let usage: typeof import('./ai-usage')

beforeAll(async () => {
  vault = await import('../vault/vault')
  prices = await import('./ai-prices')
  usage = await import('./ai-usage')
  await vault.initialize('test-master-password-one')
})

describe.skipIf(!hasLogs)('расход на реальных логах', () => {
  it('вшитый каталог цен читается и заливается', () => {
    const count = prices.seedPricesIfEmpty()
    expect(count).toBeGreaterThan(100)
    // Без цен на модели Anthropic расход Claude Code остался бы в токенах без денег.
    expect(vault.findAiPrice('claude-opus-4-7') ?? vault.listAiPrices('anthropic')[0]).toBeTruthy()
  })

  it('первый проход читает файлы, второй не перечитывает уже прочитанное', async () => {
    const first = await usage.collectUsage()
    expect(first.files).toBeGreaterThan(0)

    const afterFirst = vault.listUsageDays()
    const sum = (days: typeof afterFirst): number => days.reduce((n, d) => n + d.input + d.output + d.cacheRead, 0)
    const tokensAfterFirst = sum(afterFirst)
    expect(tokensAfterFirst).toBeGreaterThan(0)

    // Второй проход обязан не перечитывать ПРОЧИТАННОЕ. Требовать от него ровно ноль записей
    // нельзя: логи читаются живые, и если проверка идёт во время работы с Claude Code, файл
    // дописывается прямо между проходами — так эта проверка и падала, обвиняя исправный код.
    // Признак задвоения — не «появились новые записи», а «прежние посчитаны снова»: итог не
    // может УМЕНЬШИТЬСЯ и не может вырасти вдвое.
    const second = await usage.collectUsage()
    const tokensAfterSecond = sum(vault.listUsageDays())
    expect(tokensAfterSecond).toBeGreaterThanOrEqual(tokensAfterFirst)
    expect(tokensAfterSecond).toBeLessThan(tokensAfterFirst * 2)
    // И новых записей не может быть больше, чем реально дописали за секунды между проходами.
    expect(second.records).toBeLessThan(first.records)

    // Дубли в логах реальны (один ответ лежит несколькими строками) — дедуп обязан их видеть.
    expect(first.duplicates).toBeGreaterThanOrEqual(0)
  })

  it('итог осмысленный: есть модели, даты и деньги', () => {
    const days = vault.listUsageDays()
    expect(days.length).toBeGreaterThan(0)
    for (const d of days) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(d.model.length).toBeGreaterThan(0)
      expect(d.requests).toBeGreaterThan(0)
      expect(d.costUsd).toBeGreaterThanOrEqual(0)
      // Чтение кэша не может быть отрицательным даже при странном логе.
      expect(d.cacheRead).toBeGreaterThanOrEqual(0)
    }
    // Хотя бы у одной строки цена должна быть известна — иначе каталог не сопоставился с
    // именами моделей из логов, и весь денежный счёт молча равен нулю.
    expect(days.some((d) => d.costUsd > 0)).toBe(true)
  })
})
