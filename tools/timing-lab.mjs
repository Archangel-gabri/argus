#!/usr/bin/env node
// Сколько ждёт человек. Мандат требует замерить время открытия экранов, а не «оценить».
//
// Меряем то, что чувствуется: от клика по разделу до появления его содержимого. Это не бенчмарк
// движка — числа зависят от машины; ценность в сравнении экранов между собой и в отлове того,
// что открывается заметно дольше остальных.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASSWORD = 'Пример-Пароля-2026-Длинный'
const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'argus-timing-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'production' }
})
const page = await app.firstWindow()

const t0 = Date.now()
await page.waitForLoadState('domcontentloaded')
await page.locator('input[type="password"]').first().waitFor({ timeout: 20000 })
console.log(`первый экран (до поля пароля)      ${Date.now() - t0} мс`)

await page.setViewportSize({ width: 1480, height: 940 })
const all = page.locator('input[type="password"]')
for (let i = 0; i < (await all.count()); i++) await all.nth(i).fill(PASSWORD)
const cb = page.locator('input[type="checkbox"]')
if (await cb.count()) await cb.first().check()

const tUnlock = Date.now()
await page.getByRole('button', { name: /создать/i }).first().click()
await page.getByRole('button', { name: /^Парк/ }).first().waitFor({ timeout: 30000 })
console.log(`создание хранилища и вход          ${Date.now() - tUnlock} мс`)

const screens = [
  [/^Финансы/, 'Счета'],
  [/^Подписки/, 'Все подписки'],
  [/^ИИ/, /Доступ/],
  [/^Настройки/, /Мастер-пароль|Настройки/],
  [/^Парк/, /устройств/]
]
for (const [nav, marker] of screens) {
  const t = Date.now()
  await page.getByRole('button', { name: nav }).first().click()
  await (typeof marker === 'string' ? page.getByText(marker) : page.getByText(marker)).first().waitFor({ timeout: 20000 })
  const ms = Date.now() - t
  const name = String(nav).replace(/[/^]/g, '')
  console.log(`${(name + '                     ').slice(0, 34)} ${ms} мс${ms > 400 ? '   ← дольше остальных' : ''}`)
}

await app.close()
