#!/usr/bin/env node
// Путь чистого пользователя — КЛИКАМИ, а не через мост.
//
// e2e-проверки ходят через `window.api`: так они проверяют логику, не спотыкаясь о вёрстку.
// Но владелец спрашивает про другое — «может ли ЧЕЛОВЕК завести всё сам». Ответ на это даёт
// только клик: кнопки может не быть, она может быть за наведением, поле может быть недоступно,
// форма может не сохраняться. Ни одну из этих поломок мост не заметит, потому что он их обходит.
//
// Скрипт ничего не чинит и ничего не утверждает про качество — он отвечает на один вопрос по
// каждому шагу: дошёл или нет, и если нет, то на чём споткнулся.
//
//   npm run build && node tools/user-walk.mjs

import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASSWORD = 'Пример-Пароля-2026-Длинный'
const steps = []

const step = async (name, fn) => {
  try {
    await fn()
    steps.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const why = String(e.message).split('\n')[0].slice(0, 150)
    steps.push({ name, ok: false, why })
    console.log(`  ✖ ${name}\n      ${why}`)
  }
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'argus-walk-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'production' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.setViewportSize({ width: 1480, height: 940 })

console.log('\nПуть чистого пользователя (клики, без обхода через мост)\n')

await step('завести хранилище паролем', async () => {
  const pwd = page.locator('input[type="password"]').first()
  await pwd.waitFor({ timeout: 15000 })
  const all = page.locator('input[type="password"]')
  const count = await all.count()
  for (let i = 0; i < count; i++) await all.nth(i).fill(PASSWORD)
  const consent = page.locator('input[type="checkbox"]')
  if (await consent.count()) await consent.first().check()
  await page.getByRole('button', { name: /создать|продолжить|войти|готово/i }).first().click()
  // Признак входа — навигация раздела, а не любой `aside`: их на экране два (боковая панель
  // и правый рейл), и строгий режим Playwright на этом справедливо спотыкается.
  await page.getByRole('button', { name: /^Парк/ }).first().waitFor({ timeout: 20000 })
})

const go = async (name) => {
  await page.getByRole('button', { name }).first().click()
  await page.waitForTimeout(600)
}

await step('открыть Парк и завести устройство руками', async () => {
  await go(/^Парк/)
  await page.getByRole('button', { name: /Добавить устройство/i }).click()
  await page.getByLabel('Имя', { exact: true }).waitFor({ timeout: 8000 })
  await page.getByLabel('Имя', { exact: true }).fill('Мой сервер')
  await page.getByLabel('Адрес', { exact: true }).fill('198.51.100.10')
  await page.getByLabel('Порт', { exact: true }).fill('22')
  await page.getByLabel('Пользователь SSH', { exact: true }).fill('root')
  await page.getByRole('button', { name: /^(Сохранить|Добавить|Готово|Создать)$/i }).first().click()
  await page.getByText('Мой сервер').first().waitFor({ timeout: 10000 })
})

await step('открыть Подписки и завести подписку руками', async () => {
  await go(/^Подписки/)
  await page.getByRole('button', { name: /Подписка/i }).first().click()
  await page.waitForTimeout(300)
  await page.getByPlaceholder(/название|Netflix|Spotify/i).first().fill('Моя подписка')
  const amount = page.getByPlaceholder(/сумма|0/i).first()
  await amount.fill('499')
  await page.getByRole('button', { name: /Сохранить|Добавить|Готово/i }).first().click()
  await page.getByText('Моя подписка').first().waitFor({ timeout: 8000 })
})

await step('открыть Финансы и завести счёт руками', async () => {
  await go(/^Финансы/)
  await page.getByRole('button', { name: /Счёт/i }).first().click()
  await page.waitForTimeout(300)
  await page.getByLabel(/Название счёта/i).fill('Мой банк')
  await page.getByLabel(/Учреждение/i).fill('Сбербанк')
  await page.getByRole('button', { name: /Сохранить|Добавить|Готово/i }).first().click()
  await page.getByText('Мой банк').first().waitFor({ timeout: 8000 })
})

await step('внести остаток по счёту руками', async () => {
  // Правка остатка живёт на своей кнопке и появляется по наведению на строку.
  const row = page.getByText('Мой банк').first()
  await row.hover()
  await page.getByRole('button', { name: /Изменить остаток Мой банк/i }).click()
  await page.getByLabel(/Остаток на счёте Мой банк/i).fill('12345')
  await page.getByRole('button', { name: /Сохранить остаток/i }).click()
  await page.getByText(/12\s?345/).first().waitFor({ timeout: 8000 })
})

await step('исправить название и валюту счёта', async () => {
  // Раньше у счёта правился только остаток: опечатку в названии и ошибочную валюту исправить
  // было нечем, оставалось удалить и завести заново — а удаление счёта биржи стирает ключи.
  const row = page.getByText('Мой банк').first()
  await row.hover()
  await page.getByRole('button', { name: /Изменить счёт Мой банк/i }).click()
  const name = page.getByLabel(/Название счёта/i)
  await name.fill('Мой банк (исправлено)')
  await page.getByLabel(/^Валюта$/).selectOption('USD')
  await page.getByRole('button', { name: /^(Сохранить|Добавить|Готово)$/i }).first().click()
  await page.getByText('Мой банк (исправлено)').first().waitFor({ timeout: 8000 })
})

await step('открыть ИИ и завести доступ руками', async () => {
  await go(/^ИИ/)
  await page.getByRole('button', { name: /Доступ/i }).first().click()
  await page.waitForTimeout(300)
  const name = page.getByLabel(/Название|Как называешь/i).first()
  await name.fill('Мой доступ')
  await page.getByRole('button', { name: /Сохранить|Добавить|Готово/i }).first().click()
  await page.getByText('Мой доступ').first().waitFor({ timeout: 8000 })
})

await step('задать потолки лимитов у ИИ-доступа', async () => {
  // Полосы «Сегодня» и «Последние 7 дней» экран рисует, а знаменатель к ним задать было негде:
  // три поля жили только в файле засева.
  await go(/^ИИ/)
  await page.getByText('Мой доступ').first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Изменить доступ/i }).first().click()
  // Нестрогое совпадение: у полей с подсказкой вычисленное имя включает и её кнопку.
  await page.getByLabel(/Токенов в сутки/).fill('1000000')
  await page.getByLabel(/Токенов в неделю/).fill('5000000')
  await page.getByRole('button', { name: /^Сохранить$/ }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Изменить доступ/i }).first().click()
  const back = await page.getByLabel(/Токенов в сутки/).inputValue()
  if (back !== '1000000') throw new Error(`потолок не сохранился: в поле «${back}»`)
  // Форму закрываем: следующий шаг начинает с карточки, а не с открытой формы.
  await page.getByRole('button', { name: /Закрыть форму доступа/i }).first().click()
  await page.waitForTimeout(400)
})

await step('завести канал у ИИ-доступа', async () => {
  // Канал — то, ЧЕМ владелец пользуется на аккаунте (браузер, терминал, ключ для скрипта).
  // Модель его знала, экран показывал, а завести руками было нельзя вообще.
  await page.getByRole('button', { name: /Изменить доступ/i }).first().click()
  await page.getByRole('button', { name: /\+ канал/ }).click()
  await page.getByLabel(/Название канала 1/).fill('Мой терминал')
  await page.getByRole('button', { name: /^Сохранить$/ }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Изменить доступ/i }).first().click()
  const saved = await page.getByLabel(/Название канала 1/).inputValue()
  if (saved !== 'Мой терминал') throw new Error(`канал не сохранился: в поле «${saved}»`)
  await page.getByRole('button', { name: /Отмена|Закрыть форму доступа/i }).first().click()
})

await step('удалить заведённую подписку', async () => {
  await go(/^Подписки/)
  // Удаление спрашивает подтверждение системным окном — на него надо ответить заранее,
  // иначе клик виснет и выглядит как поломка интерфейса.
  page.on('dialog', (d) => void d.accept())
  const row = page.getByText('Моя подписка').first()
  await row.hover()
  const del = page.getByRole('button', { name: 'Удалить подписку Моя подписка' })
  await del.waitFor({ timeout: 5000 })
  await del.click()
  await page.waitForTimeout(1500)
  const left = await page.getByText('Моя подписка').count()
  if (left > 0) throw new Error(`строка осталась на экране после удаления (найдено ${left})`)
})

const failed = steps.filter((s) => !s.ok)
console.log(`\nпройдено ${steps.length - failed.length} из ${steps.length}`)
if (failed.length) {
  console.log('\nгде путь пользователя обрывается:')
  for (const f of failed) console.log(`  · ${f.name}: ${f.why}`)
}

await page.screenshot({ path: '/tmp/argus-audit/walk-final.png' })
await app.close()
process.exit(failed.length ? 1 : 0)
