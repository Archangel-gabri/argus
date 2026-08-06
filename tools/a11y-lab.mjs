#!/usr/bin/env node
// Проверка доступности настоящим движком, а не моими догадками.
//
// В ui-lab проверки написаны руками — они ловят обрезанный текст и мелкие кнопки, но про
// доступность знают ровно то, что я в них вложил. axe-core — отраслевой движок правил (тот же,
// что стоит за проверками в Chrome DevTools): он знает про роли, контрастность, порядок
// заголовков, подписи полей и ещё сотню правил, которые я бы выдумывал неделю и неверно.
//
// Файл движка лежит рядом (tools/vendor/axe.min.js, 568 КБ, MPL-2.0) и в зависимости проекта НЕ
// добавлен: он нужен только при ревью и не должен попадать в сборку приложения.
//
//   npm run build && node tools/a11y-lab.mjs

import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AXE = readFileSync(new URL('./vendor/axe.min.js', import.meta.url), 'utf8')
const PASSWORD = 'Пример-Пароля-2026-Длинный'

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'argus-a11y-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'production' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.setViewportSize({ width: 1480, height: 940 })
await page.waitForTimeout(1200)

const scan = async (label) => {
  await page.evaluate(AXE)
  const r = await page.evaluate(async () =>
    // Берём правила уровня AA: они про то, можно ли пользоваться, а не про вкус.
    // eslint-disable-next-line no-undef
    axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
  )
  const rows = r.violations.map((v) => ({
    правило: v.id,
    тяжесть: v.impact,
    сколько: v.nodes.length,
    что: v.help,
    пример: v.nodes[0]?.html?.replace(/\s+/g, ' ').slice(0, 90)
  }))
  console.log(`\n${label}: нарушений ${rows.length}`)
  for (const x of rows) {
    console.log(`  [${x.тяжесть}] ${x.правило} ×${x.сколько} — ${x.что}`)
    console.log(`      ${x.пример}`)
  }
  return rows.reduce((n, x) => n + x.сколько, 0)
}

let total = await scan('Экран входа')

const all = page.locator('input[type="password"]')
for (let i = 0; i < (await all.count()); i++) await all.nth(i).fill(PASSWORD)
const cb = page.locator('input[type="checkbox"]')
if (await cb.count()) await cb.first().check()
await page.getByRole('button', { name: /создать/i }).first().click()
await page.getByRole('button', { name: /^Парк/ }).first().waitFor({ timeout: 20000 })

for (const name of [/^Парк/, /^Финансы/, /^Подписки/, /^ИИ/, /^Настройки/]) {
  await page.getByRole('button', { name }).first().click()
  await page.waitForTimeout(900)
  total += await scan(String(name).replace(/[/^]/g, ''))
}

console.log(`\nвсего нарушений: ${total}`)
await app.close()
