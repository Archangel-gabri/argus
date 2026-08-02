// Интеграция с НАСТОЯЩИМ зашифрованным хранилищем: реальный файл SQLCipher во временном каталоге.
//
// Запускается ТОЛЬКО отдельной командой `npm run test:vault` под `ELECTRON_RUN_AS_NODE=1 electron`:
// нативный модуль `better-sqlite3-multiple-ciphers` собран под ABI Electron и под системным node
// падает с ERR_DLOPEN_FAILED. Обычный `npm test` этот файл не берёт (суффикс `.vault.test.ts`).
//
// Шов дешёвый: `vault.ts` вычисляет путь через `app.getPath('userData')` ЛЕНИВО, поэтому
// подмены модуля `electron` достаточно — переписывать рабочий код ради тестов не пришлось.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceInput } from './types'

const TMP = mkdtempSync(join(tmpdir(), 'argus-vault-'))
// Намеренно низкоэнтропийные словарные строки: сканер секретов в pre-commit обязан отличать
// фикстуру от настоящего пароля, и проще дать ему очевидно ненастоящее, чем учить исключениям.
const PASSWORD = 'test-master-password-one'
const NEXT_PASSWORD = 'test-master-password-two'

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

// Сигнальные значения вместо правдоподобных: если такая строка вылезет наружу, это видно сразу
// и ни с чем не спутаешь.
const SECRET_PASSWORD = '__SECRET_DEVICE_PASSWORD__'
const SECRET_KEY = '__SECRET_PRIVATE_KEY__'

const device = (over: Partial<DeviceInput> = {}): DeviceInput => ({
  name: 'probe-host',
  provider: 'Custom',
  kind: 'server',
  ip: '10.0.0.9',
  port: 22,
  user: 'root',
  authType: 'password',
  password: SECRET_PASSWORD,
  ...over
})

describe('хранилище на реальном SQLCipher-файле', () => {
  let vault: typeof import('./vault')

  beforeAll(async () => {
    vault = await import('./vault')
  })

  it('до инициализации сообщает uninitialized', () => {
    expect(vault.vaultStatus()).toBe('uninitialized')
  })

  it('инициализация создаёт и базу, и файл соли', async () => {
    await vault.initialize(PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
    const files = readdirSync(TMP)
    expect(files).toContain('nexus-vault.db')
    expect(files).toContain('nexus-vault.meta.json')
  })

  it('открывается своим паролем после блокировки', async () => {
    vault.lock()
    expect(vault.vaultStatus()).toBe('locked')
    await vault.unlock(PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
  })

  it('чужим паролем не открывается и остаётся закрытым', async () => {
    vault.lock()
    await expect(vault.unlock('wrong-password-entirely')).rejects.toThrow()
    expect(vault.vaultStatus()).toBe('locked')
  })

  it('файл базы на диске зашифрован — сигнальных строк в нём нет', async () => {
    await vault.unlock(PASSWORD)
    vault.createDevice(device({ name: 'encrypted-check' }))
    vault.lock()
    const raw = readFileSync(join(TMP, 'nexus-vault.db'))
    // Проверяем именно байты файла: без шифрования секрет лежал бы в нём открытым текстом.
    expect(raw.includes(Buffer.from(SECRET_PASSWORD))).toBe(false)
    expect(raw.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0')
  })

  it('устройство переживает цикл блокировки, но секрет не попадает в DTO', async () => {
    await vault.unlock(PASSWORD)
    const created = vault.createDevice(device({ name: 'roundtrip', privateKey: SECRET_KEY, authType: 'key' }))
    vault.lock()
    await vault.unlock(PASSWORD)

    const found = vault.listDevices().find((d) => d.name === 'roundtrip')
    expect(found).toBeTruthy()
    // Главный инвариант: за границу main секреты не выходят ни в каком виде.
    const dto = JSON.stringify(found)
    expect(dto).not.toContain(SECRET_KEY)
    expect(dto).not.toContain(SECRET_PASSWORD)
    // ...но внутри main они доступны — иначе подключаться было бы нечем.
    expect(vault.getDeviceConn(created.id)?.privateKey).toBe(SECRET_KEY)
  })

  it('удаление устройства не оставляет висячих ссылок jump_id', async () => {
    const bastion = vault.createDevice(device({ name: 'bastion' }))
    const behind = vault.createDevice(device({ name: 'behind', jumpId: bastion.id }))
    expect(vault.listDevices().find((d) => d.id === behind.id)?.jumpId).toBe(bastion.id)

    vault.deleteDevice(bastion.id)
    // Устройство за бастионом обязано выжить, но ссылка — обнулиться, иначе оно навсегда
    // пытается ходить через несуществующий хост.
    const orphan = vault.listDevices().find((d) => d.id === behind.id)
    expect(orphan).toBeTruthy()
    expect(orphan?.jumpId ?? null).toBeNull()
  })

  it('смена мастер-пароля перешифровывает базу: старый больше не подходит', async () => {
    await vault.changePassword(PASSWORD, NEXT_PASSWORD)
    vault.lock()
    await expect(vault.unlock(PASSWORD)).rejects.toThrow()
    expect(vault.vaultStatus()).toBe('locked')
    await vault.unlock(NEXT_PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
    // Возвращаем обратно, чтобы порядок файлов в проекте не влиял на результат.
    await vault.changePassword(NEXT_PASSWORD, PASSWORD)
  })
})
