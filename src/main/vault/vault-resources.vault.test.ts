// Ресурсы хранилища: то, что копится за часы работы и всплывает не там, где возникло.
//
// Утечка дескрипторов — самый неприятный вид отказа: она ничего не ломает сразу, а потом
// приложение начинает падать на SSH, на диалогах выбора файла и на самом хранилище, и ни одна
// из этих ошибок не указывает на причину.
//
// Считаем дескрипторы через /proc/self/fd — способ линуксовый, но рабочее место здесь Linux,
// а надёжной кроссплатформенной замены нет. На другой системе проверка честно пропускается.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'argus-fd-'))
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

const FD_DIR = '/proc/self/fd'
const canCountFds = existsSync(FD_DIR)
const openFds = (): number => readdirSync(FD_DIR).length

describe('хранилище не копит открытые дескрипторы', () => {
  let vault: typeof import('./vault')

  beforeAll(async () => {
    vault = await import('./vault')
    await vault.initialize(PASSWORD)
    vault.lock()
  })

  it.runIf(canCountFds)('тридцать неверных паролей не оставляют тридцать открытых файлов', async () => {
    // Прогреваем: первая попытка может подтянуть ленивые ресурсы, и их не надо считать утечкой.
    await expect(vault.unlock('заведомо-неверный-0')).rejects.toThrow()

    const before = openFds()
    for (let i = 1; i <= 30; i++) {
      await expect(vault.unlock(`заведомо-неверный-${i}`)).rejects.toThrow()
    }
    const leaked = openFds() - before

    // Неверный ключ обнаруживается на прагме — то есть уже ПОСЛЕ того, как заведён дескриптор
    // файла. Пока соединение не закрывалось внутри openEncrypted, здесь было ровно 30.
    expect(leaked, `утекло дескрипторов: ${leaked}`).toBeLessThanOrEqual(2)
  })

  it.runIf(canCountFds)('успешные открытия и блокировки тоже не копят дескрипторы', async () => {
    await vault.unlock(PASSWORD)
    vault.lock()

    const before = openFds()
    for (let i = 0; i < 15; i++) {
      await vault.unlock(PASSWORD)
      vault.lock()
    }
    const leaked = openFds() - before
    // Каждый цикл открывает базу и закрывает её; рост означал бы, что lock не закрывает файл.
    expect(leaked, `утекло дескрипторов: ${leaked}`).toBeLessThanOrEqual(2)
  })

  it('после неудачных попыток хранилище по-прежнему открывается своим паролем', async () => {
    vault.lock()
    for (let i = 0; i < 5; i++) {
      await expect(vault.unlock('снова-неверный')).rejects.toThrow()
    }
    await vault.unlock(PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
  })
})
