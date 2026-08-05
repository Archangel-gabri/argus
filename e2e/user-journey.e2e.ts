// Путь чистого пользователя: пустое приложение → мастер-пароль → своё устройство → подписка →
// счёт → перезапуск. Ровно то, что делает человек в первый вечер.
//
// Зачем это отдельно от юнитов. Юниты проверяют функции, а здесь проверяются СТЫКИ: форма →
// мост → main → SQLCipher → обратно на экран. Именно там живут отказы, которые видит владелец
// («завёл, а оно не появилось», «сохранил, а вернулось прежнее»), и ни один модульный тест их
// не ловит, потому что каждый участок по отдельности исправен.
//
// Почему проверки идут через `window.api`, а не кликами. Клик проверяет вёрстку заодно с
// логикой, и падает от неё же: половина находок первого захода оказалась хрупкостью селекторов,
// а не дефектами приложения. Мост — это настоящая граница пользователя с данными, и путь через
// него от формы отличается только тем, кто заполняет поля.
//
// Приложение поднимается со СВОИМ каталогом данных: настоящее хранилище владельца не трогается.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Мост объявлен глобально в декларациях preload — тянем их, чтобы `window.api` в
// `page.evaluate` был типизирован тем же контрактом, что видит настоящий renderer.
import '../src/preload/index.d'

let app: ElectronApplication
let page: Page
let userData = ''

// Намеренно длинный словарный пароль: гейт zxcvbn пропускает по времени взлома, а не по составу.
const MASTER = 'корова-телефон-январь-пирог'

const launch = async (): Promise<void> => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'argus-journey-'))
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (userData) rmSync(userData, { recursive: true, force: true })
})

test('первый запуск предлагает создать хранилище, а не войти в него', async () => {
  const status = await page.evaluate(async () => (await window.api.vault.state()).status)
  expect(status).toBe('uninitialized')
  await expect(page.getByRole('button', { name: 'Создать' })).toBeVisible()
  // Кнопка заперта, пока не выполнены все условия: стойкость, совпадение, согласие.
  await expect(page.getByRole('button', { name: 'Создать' })).toBeDisabled()
})

test('слабый пароль не пропускается, и человеку видно почему', async () => {
  await page.getByLabel('Новый мастер-пароль').fill('123456')
  await page.getByLabel('Мастер-пароль ещё раз').fill('123456')
  await page.getByRole('checkbox').check()
  await expect(page.getByText(/очень слабый|слабый/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Создать' })).toBeDisabled()
})

test('стойкий пароль создаёт хранилище и открывает приложение', async () => {
  await page.getByLabel('Новый мастер-пароль').fill(MASTER)
  await page.getByLabel('Мастер-пароль ещё раз').fill(MASTER)
  await expect(page.getByRole('button', { name: 'Создать' })).toBeEnabled()
  await page.getByRole('button', { name: 'Создать' }).click()

  // Признак входа — появление навигации, а не исчезновение формы: форма пропала бы и от ошибки.
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 })
  const status = await page.evaluate(async () => (await window.api.vault.state()).status)
  expect(status).toBe('unlocked')
})

test('заведённое устройство появляется в списке', async () => {
  const created = await page.evaluate(() =>
    window.api.devices.create({
      name: 'proba-node',
      provider: 'Custom',
      ip: '203.0.113.10',
      port: 22,
      user: 'root'
    })
  )
  expect(created.ok).toBe(true)
  const names = await page.evaluate(async () => (await window.api.devices.list()).map((d) => d.name))
  expect(names).toContain('proba-node')
})

test('подписка и счёт заводятся и считаются в своей валюте', async () => {
  const sub = await page.evaluate(() =>
    window.api.subs.create({ name: 'Проба', amount: 100, currency: 'EUR', period: 'mo' })
  )
  expect(sub?.id).toBeTruthy()

  const account = await page.evaluate(() =>
    window.api.accounts.create({ kind: 'bank', name: 'Проб-банк', currency: 'RUB', balance: 1000 })
  )
  expect(account?.id).toBeTruthy()

  const [subs, accounts] = await page.evaluate(async () => [
    await window.api.subs.list(),
    await window.api.accounts.list()
  ])
  expect(subs.find((s) => s.name === 'Проба')?.currency).toBe('EUR')
  expect(accounts.find((a) => a.name === 'Проб-банк')?.balance).toBe(1000)
})

test('секреты через мост наружу не выходят', async () => {
  // Ключевой инвариант приложения: пароль устройства уходит в main и обратно не возвращается.
  await page.evaluate(() =>
    window.api.devices.create({
      name: 'с-секретом',
      provider: 'Custom',
      ip: '203.0.113.11',
      port: 22,
      user: 'root',
      authType: 'password',
      password: 'ОЧЕНЬ_СЕКРЕТНЫЙ_ПАРОЛЬ'
    })
  )
  const dump = await page.evaluate(async () => JSON.stringify(await window.api.devices.list()))
  expect(dump).not.toContain('ОЧЕНЬ_СЕКРЕТНЫЙ_ПАРОЛЬ')
  // Но приложение обязано ЗНАТЬ, что секрет есть, — иначе непонятно, можно ли подключаться.
  const withSecret = await page.evaluate(async () =>
    (await window.api.devices.list()).find((d) => d.name === 'с-секретом')
  )
  expect(withSecret?.hasSecret).toBe(true)
})

test('заведённое переживает перезапуск и требует пароль', async () => {
  await app.close()
  await launch()

  const status = await page.evaluate(async () => (await window.api.vault.state()).status)
  expect(status).toBe('locked')
  // До ввода пароля данные недоступны — не «пустой список», а именно закрытое хранилище.
  expect(await page.evaluate(async () => (await window.api.devices.list()).length)).toBe(0)

  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Мастер-пароль', { exact: true }).fill(MASTER)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 })

  const names = await page.evaluate(async () => (await window.api.devices.list()).map((d) => d.name))
  expect(names).toContain('proba-node')
  const subs = await page.evaluate(() => window.api.subs.list())
  expect(subs.some((s) => s.name === 'Проба')).toBe(true)
})

test('чужой пароль не открывает хранилище', async () => {
  await app.close()
  await launch()

  const bad = await page.evaluate(() => window.api.vault.unlock('совершенно-другой-пароль-1'))
  expect(bad.ok).toBe(false)
  expect(bad.state.status).toBe('locked')
  expect(await page.evaluate(async () => (await window.api.devices.list()).length)).toBe(0)
})
