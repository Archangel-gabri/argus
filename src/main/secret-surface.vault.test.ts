// Матрица утечки секретов: класс секрета × приёмник × сток.
//
// Наивная проверка «сигнальная строка не встречается ни в одном ответе IPC» здесь НЕ работает:
// `screenClaim` намеренно отдаёт сессионный токен окну-владельцу, и такой тест падал бы на
// корректном поведении, а исключение токена из проверки открыло бы дыру. Поэтому для каждой
// клетки записано, разрешено ли значение в этом стоке, и проверяются обе стороны.
//
// Идёт в проекте `vault`, потому что нужен настоящий зашифрованный файл: половина смысла — в
// том, что секрет ЛЕЖИТ в хранилище и доступен внутри main, но не пересекает границу наружу.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceInput } from './types'

const TMP = mkdtempSync(join(tmpdir(), 'argus-secrets-'))
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

/** Сигнальные значения: если такое всплывёт наружу, спутать его не с чем. */
const SECRETS = {
  devicePassword: '__SECRET_DEVICE_PASSWORD__',
  privateKey: '__SECRET_PRIVATE_KEY__',
  passphrase: '__SECRET_PASSPHRASE__',
  screenPassword: '__SECRET_SCREEN_PASSWORD__',
  agentToken: '__SECRET_AGENT_TOKEN__',
  aiKey: '__SECRET_AI_KEY__'
} as const

const contains = (haystack: unknown, needle: string): boolean =>
  JSON.stringify(haystack ?? null).includes(needle)

describe('поверхность секретов', () => {
  let vault: typeof import('./vault')
  let deviceId = ''

  beforeAll(async () => {
    vault = await import('./vault')
    await vault.initialize(PASSWORD)
    const d = vault.createDevice({
      name: 'секретоносец',
      provider: 'Custom',
      kind: 'server',
      ip: '203.0.113.10',
      port: 22,
      user: 'root',
      authType: 'key',
      password: SECRETS.devicePassword,
      privateKey: SECRETS.privateKey,
      passphrase: SECRETS.passphrase
    } satisfies DeviceInput)
    deviceId = d.id
    vault.setScreenPassword(deviceId, SECRETS.screenPassword)
    vault.setAgentToken(deviceId, SECRETS.agentToken)
    vault.createAiAccess({ provider: 'openrouter', label: 'тест', apiKey: SECRETS.aiKey })
  })

  describe('НЕ должно пересекать границу main → renderer', () => {
    it('список устройств не несёт ни одного секрета устройства', () => {
      const list = vault.listDevices()
      for (const [name, value] of Object.entries(SECRETS)) {
        // Пароль экрана и токен агента к устройству относятся, но в DTO им тоже не место.
        if (name === 'aiKey') continue
        expect(contains(list, value), `в списке устройств нашёлся ${name}`).toBe(false)
      }
    })

    it('устройство сообщает ФАКТ наличия секрета, но не сам секрет', () => {
      const d = vault.listDevices().find((x) => x.id === deviceId)
      // Интерфейсу нужно знать, можно ли подключаться, — и только это.
      expect(d?.hasSecret).toBe(true)
      expect(contains(d, SECRETS.privateKey)).toBe(false)
    })

    it('список ИИ-доступов не несёт ключ', () => {
      const accounts = vault.listAiAccess()
      expect(accounts.length).toBeGreaterThan(0)
      expect(contains(accounts, SECRETS.aiKey)).toBe(false)
    })

    it('снимки метрик секретов не содержат', () => {
      vault.recordSnapshot(deviceId, { cpu: 10, ramUsed: 1, ramTotal: 2, status: 'online' })
      expect(contains(vault.getSnapshots(deviceId), SECRETS.devicePassword)).toBe(false)
    })
  })

  describe('ДОЛЖНО быть доступно внутри main — иначе подключаться нечем', () => {
    it('соединение устройства несёт ключ и парольную фразу', () => {
      const conn = vault.getDeviceConn(deviceId)
      expect(conn?.privateKey).toBe(SECRETS.privateKey)
      expect(conn?.passphrase).toBe(SECRETS.passphrase)
    })

    it('пароль экрана и токен агента читаются адресно', () => {
      expect(vault.getScreenPassword(deviceId)).toBe(SECRETS.screenPassword)
      expect(vault.getAgentToken(deviceId)).toBe(SECRETS.agentToken)
    })

    it('ключ ИИ достаётся только явным вызовом', () => {
      const account = vault.listAiAccess()[0]
      expect(vault.getAiKey(account.id)).toBe(SECRETS.aiKey)
    })
  })

  describe('сток «диск»', () => {
    it('файл базы зашифрован — ни одного секрета в его байтах', () => {
      vault.lock()
      const raw = readFileSync(join(TMP, 'argus-vault.db'))
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(raw.includes(Buffer.from(value)), `${name} лежит на диске открытым текстом`).toBe(false)
      }
      // И это не потому, что база пустая: заголовок SQLite тоже зашифрован.
      expect(raw.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0')
      expect(raw.byteLength).toBeGreaterThan(1000)
    })

    it('файл соли не содержит ни пароля, ни секретов', () => {
      const meta = readFileSync(join(TMP, 'argus-vault.meta.json'), 'utf8')
      expect(meta).not.toContain(PASSWORD)
      for (const value of Object.values(SECRETS)) expect(meta).not.toContain(value)
    })
  })

  describe('сток «блокировка»', () => {
    it('после блокировки секреты недоступны и внутри main', async () => {
      vault.lock()
      // Не «пустой ответ», а именно отказ: закрытое хранилище не должно молча отдавать null,
      // иначе вызывающий код примет отсутствие данных за отсутствие устройства.
      expect(() => vault.getDeviceConn(deviceId)).toThrow()
      await vault.unlock(PASSWORD)
      expect(vault.getDeviceConn(deviceId)?.privateKey).toBe(SECRETS.privateKey)
    })
  })
})
