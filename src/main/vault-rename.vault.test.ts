// Переименование файла хранилища со старого имени приложения на новое.
//
// Цена ошибки максимальная: у владельца в этом файле ВСЕ его данные — серверы, счета, ключи.
// Ошибка здесь выглядит для него как «приложение забыло всё и предлагает создать хранилище
// заново». Поэтому миграция проверяется на настоящих файлах, а не рассуждением.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''
vi.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const load = async (): Promise<typeof import('./vault')> => {
  vi.resetModules()
  return import('./vault')
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'argus-rename-'))
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe('имя файла хранилища', () => {
  it('старая пара файлов переезжает на новое имя вместе с содержимым', async () => {
    writeFileSync(join(TMP, 'nexus-vault.db'), 'данные владельца')
    writeFileSync(join(TMP, 'nexus-vault.meta.json'), '{"соль":"важная"}')

    const vault = await load()
    // Любое обращение к путям запускает миграцию — здесь это проверка «заведено ли хранилище».
    expect(vault.isInitialized()).toBe(true)

    expect(existsSync(join(TMP, 'argus-vault.db'))).toBe(true)
    expect(readFileSync(join(TMP, 'argus-vault.db'), 'utf8')).toBe('данные владельца')
    expect(readFileSync(join(TMP, 'argus-vault.meta.json'), 'utf8')).toBe('{"соль":"важная"}')
    expect(existsSync(join(TMP, 'nexus-vault.db'))).toBe(false)
  })

  it('чужой файл под новым именем не затирается', async () => {
    // Новое имя уже занято — значит миграция прошла раньше, а старый файл рядом это бэкап.
    // Затереть его данными из бэкапа значит откатить владельца назад во времени.
    writeFileSync(join(TMP, 'nexus-vault.db'), 'старый бэкап')
    writeFileSync(join(TMP, 'nexus-vault.meta.json'), '{"старая":"соль"}')
    writeFileSync(join(TMP, 'argus-vault.db'), 'настоящие данные')
    writeFileSync(join(TMP, 'argus-vault.meta.json'), '{"настоящая":"соль"}')

    const vault = await load()
    expect(vault.isInitialized()).toBe(true)

    expect(readFileSync(join(TMP, 'argus-vault.db'), 'utf8')).toBe('настоящие данные')
    expect(existsSync(join(TMP, 'nexus-vault.db'))).toBe(true)
  })

  it('половина пары не мигрирует: это не хранилище', async () => {
    // База без метаданных бесполезна — соли нет, расшифровать нечем. Трогать такое незачем.
    writeFileSync(join(TMP, 'nexus-vault.db'), 'осколок')

    const vault = await load()
    expect(vault.isInitialized()).toBe(false)
    expect(existsSync(join(TMP, 'nexus-vault.db'))).toBe(true)
    expect(existsSync(join(TMP, 'argus-vault.db'))).toBe(false)
  })

  it('на чистой машине заводится сразу под новым именем', async () => {
    const vault = await load()
    expect(vault.isInitialized()).toBe(false)
    expect(existsSync(join(TMP, 'nexus-vault.db'))).toBe(false)
  })
})
