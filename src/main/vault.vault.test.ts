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
    expect(files).toContain('argus-vault.db')
    expect(files).toContain('argus-vault.meta.json')
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
    const raw = readFileSync(join(TMP, 'argus-vault.db'))
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

  it('блокировка ВО ВРЕМЯ открытия не отменяется завершившимся unlock', async () => {
    // Регрессия на реальную гонку. Вывод ключа (Argon2id, 64 МиБ, 3 прохода) занимает сотни
    // миллисекунд, и всё это время unlock держит уже открытое соединение, о котором lock ничего
    // не знает: он видит db === null и честно ничего не закрывает. Раньше завершившийся unlock
    // затем присваивал соединение — и приложение оказывалось разблокированным ПОСЛЕ блокировки.
    vault.lock()
    expect(vault.vaultStatus()).toBe('locked')

    const opening = vault.unlock(PASSWORD)
    // Блокируем, пока идёт вывод ключа. Микрозадача гарантированно попадает внутрь await.
    await Promise.resolve()
    vault.lock()

    await expect(opening).rejects.toThrow(/заблокировал/i)
    // Главное утверждение: приложение осталось закрытым.
    expect(vault.vaultStatus()).toBe('locked')

    // И обычное открытие после этого по-прежнему работает.
    await vault.unlock(PASSWORD)
    expect(vault.vaultStatus()).toBe('unlocked')
  })

  it('два одновременных открытия не оставляют лишнее соединение', async () => {
    vault.lock()
    const [a, b] = await Promise.allSettled([vault.unlock(PASSWORD), vault.unlock(PASSWORD)])
    // Оба вызова допустимы; недопустимо только состояние «открыто дважды».
    expect([a.status, b.status]).toContain('fulfilled')
    expect(vault.vaultStatus()).toBe('unlocked')
    // Хранилище работает — значит присвоено живое соединение, а не закрытое.
    expect(() => vault.listDevices()).not.toThrow()
  })

  it('ключ хоста НЕ закрепляется, пока не подтверждён вход', async () => {
    // Регрессия на реальный дефект. Проверка ключа идёт в рукопожатии, то есть раньше, чем мы
    // предъявили пароль или ключ. Раньше checkHostKey тут же вставлял запись — и один коннект
    // по ошибочному адресу навсегда закреплял ЧУЖОЙ ключ, после чего настоящий сервер читался
    // как «ключ изменился»: предупреждение о подмене выдавалось ровно наоборот.
    await vault.unlock(PASSWORD)
    const host = 'example.invalid'

    // Рукопожатие с незнакомым хостом: «новый», но в хранилище пока ничего.
    expect(vault.checkHostKey(host, 22, 'aa:bb')).toBe('new')
    expect(vault.checkHostKey(host, 22, 'совсем-другой')).toBe('new')

    // Вход удался — только теперь закрепляем.
    expect(vault.checkHostKey(host, 22, 'aa:bb', { commit: true })).toBe('new')
    expect(vault.checkHostKey(host, 22, 'aa:bb')).toBe('match')
    // И вот теперь чужой ключ — это подмена, о которой надо кричать.
    expect(vault.checkHostKey(host, 22, 'подменённый')).toBe('changed')

    vault.forgetHostKey(host, 22)
    expect(vault.checkHostKey(host, 22, 'aa:bb')).toBe('new')
  })

  it('отрицательная стоимость устройства не попадает в хранилище', async () => {
    await vault.unlock(PASSWORD)
    expect(() =>
      vault.createDevice(device({ name: 'дешёвый', cost: { amount: -100, currency: 'USD', usd: -100 } }))
    ).toThrow(/отрицательной/)
    expect(vault.listDevices().find((d) => d.name === 'дешёвый')).toBeUndefined()
  })

  it('неполный ввод не роняет main внутренней ошибкой', async () => {
    await vault.unlock(PASSWORD)
    // Раньше здесь было голое input.provider.trim(): наружу уезжало
    // «Cannot read properties of undefined (reading 'trim')» — внутренности в ответе renderer.
    // Теперь отсутствующий провайдер штатно становится 'Custom'.
    const created = vault.createDevice({ name: 'без провайдера' } as never)
    expect(created.provider).toBe('Custom')

    // А вот заведомо неверный тип — понятная ошибка на человеческом языке, не стек.
    expect(() => vault.createDevice({ name: 'кривой', provider: 42 } as never)).toThrow(/Провайдер/)
    expect(() => vault.createDevice({ provider: 'Hetzner' } as never)).toThrow(/Название/)

    vault.deleteDevice(created.id)
  })

  it('подтверждённость аккаунтов переживает цикл блокировки — уборка их не выкашивает', async () => {
    await vault.unlock(PASSWORD)
    // Регрессия: parseAccounts терял verified/via/lastUsedAt/loginUrl при чтении, из-за чего
    // pruneUnverifiedAccounts на следующем анлоке удалял ВСЕ аккаунты и стирал их секреты.
    const access = vault.createAiAccess({
      provider: 'openai',
      accounts: [
        { email: 'owner@example.com', verified: true, via: 'google', lastUsedAt: 1234, loginUrl: 'https://chat.example' },
        { email: 'draft@example.com' }
      ]
    })

    vault.lock()
    await vault.unlock(PASSWORD)

    const reread = vault.listAiAccess().find((a) => a.id === access.id)
    expect(reread?.accounts).toEqual([
      { email: 'owner@example.com', verified: true, via: 'google', lastUsedAt: 1234, loginUrl: 'https://chat.example' },
      { email: 'draft@example.com', verified: undefined, via: undefined, lastUsedAt: undefined, loginUrl: undefined }
    ])

    const { pruneUnverifiedAccounts } = await import('./ai-accounts-prune')
    const pruned = pruneUnverifiedAccounts()
    expect(pruned.removed).toBe(1)
    const after = vault.listAiAccess().find((a) => a.id === access.id)
    expect(after?.accounts.map((a) => a.email)).toEqual(['owner@example.com'])

    vault.deleteAiAccess(access.id)
  })

  it('подписка из прежней версии (без якоря) получает его при первой правке даты', async () => {
    await vault.unlock(PASSWORD)
    // Запись, заведённая до появления колонки renewal_day: даты нет, значит и якоря нет.
    const created = vault.createSubscription({ name: 'Из прошлой версии', amount: 10, currency: 'USD' })
    expect(created.renewalDay).toBeNull()

    // Владелец вписывает дату — приложение обязано запомнить, какого числа списывают.
    const dated = vault.updateSubscription(created.id, {
      name: created.name,
      amount: created.amount,
      currency: created.currency,
      nextRenewal: '2026-01-31'
    })
    expect(dated.renewalDay).toBe(31)

    // Правка, не трогающая дату, якорь не переучивает.
    const renamed = vault.updateSubscription(created.id, {
      name: 'Переименована',
      amount: created.amount,
      currency: created.currency,
      nextRenewal: '2026-01-31'
    })
    expect(renamed.renewalDay).toBe(31)

    // А явная смена даты — переучивает: это единственный случай, когда человек сообщает
    // приложению новое число списания.
    const moved = vault.updateSubscription(created.id, {
      name: 'Переименована',
      amount: created.amount,
      currency: created.currency,
      nextRenewal: '2026-03-15'
    })
    expect(moved.renewalDay).toBe(15)

    vault.deleteSubscription(created.id)
  })

  it('схема переживает повторное открытие: миграция идемпотентна и данные целы', async () => {
    await vault.unlock(PASSWORD)
    const sub = vault.createSubscription({ name: 'Живучая', amount: 42, currency: 'EUR' })
    const account = vault.createFinanceAccount({ name: 'Счёт', kind: 'bank', currency: 'RUB', balance: 100 })

    // Три цикла: migrate() выполняется на каждом открытии, и повторный ALTER не должен ни
    // падать, ни терять данные.
    for (let i = 0; i < 3; i++) {
      vault.lock()
      await vault.unlock(PASSWORD)
    }

    expect(vault.listSubscriptions().find((s) => s.id === sub.id)?.amount).toBe(42)
    expect(vault.listFinanceAccounts().find((a) => a.id === account.id)?.balance).toBe(100)

    vault.deleteSubscription(sub.id)
    vault.deleteFinanceAccount(account.id)
  })

  it('удаление счёта уносит и его ключи биржи', async () => {
    await vault.unlock(PASSWORD)
    const account = vault.createFinanceAccount({ name: 'Биржа', kind: 'exchange', currency: 'USD' })
    vault.setAccountCreds(account.id, { apiKey: '__SECRET_EXCHANGE_KEY__', secret: '__SECRET_EXCHANGE_SECRET__' })
    expect(vault.getAccountCreds(account.id)).not.toBeNull()

    expect(vault.deleteFinanceAccount(account.id)).toBe(true)
    // Ключ, переживший свой счёт, — это секрет, до которого в приложении больше нет ни одной
    // двери: ни посмотреть, ни стереть.
    expect(vault.getAccountCreds(account.id)).toBeNull()
    // Повторное удаление честно отвечает «не найдено», а не «ок».
    expect(vault.deleteFinanceAccount(account.id)).toBe(false)
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
