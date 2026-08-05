#!/usr/bin/env node
// Визуальная лаборатория: поднять приложение с правдоподобными данными, обойти все экраны,
// снять их и НАЙТИ то, что видно глазами, но не видно тестам.
//
// Зачем. Ревью кода не ловит целый класс дефектов: обрезанное название, элемент поверх
// соседнего, английское слово в русском интерфейсе, кнопка, до которой не дотянуться с
// клавиатуры, серый текст на сером фоне. Всё это человек замечает за секунду, а тест —
// никогда, потому что данные-то верные. Этот скрипт смотрит на приложение так же, как смотрит
// человек: измеряет ФАКТИЧЕСКУЮ геометрию отрисованных узлов и сравнивает контрасты.
//
// Данные берутся демонстрационные и всегда одни и те же: настоящее хранилище владельца не
// открывается и не читается вовсе, каталог данных — временный.
//
// Запуск:
//   npm run ui:lab              — снимки + отчёт в sessions/screenshots/<дата>/
//   npm run ui:lab -- --keep    — не закрывать приложение (для ручного осмотра)

import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const day = new Date().toISOString().slice(0, 10)
const out = join(root, '..', '..', 'sessions', 'screenshots', day)
mkdirSync(out, { recursive: true })

const MASTER = 'корова-телефон-январь-пирог'
const keep = process.argv.includes('--keep')

/** Демо-набор: разные валюты, длинные имена, просрочка, дубль траты — то, на чём вёрстка ломается. */
const DEMO = async () => {
  const a = window.api
  await a.devices.create({ name: 'HubVPN · Germany', provider: 'Hetzner', ip: '203.0.113.20', port: 22, user: 'root', os: 'Ubuntu 24.04', country: 'Germany', flag: '🇩🇪', cost: { amount: 10, currency: 'EUR', usd: 10.8 } })
  await a.devices.create({ name: 'FX-Analytics', provider: 'FirstByte', ip: '203.0.113.21', port: 22, user: 'root', os: 'Debian 12', cost: { amount: 12, currency: 'USD', usd: 12 } })
  await a.devices.create({ name: 'ноутбук', provider: 'Custom', kind: 'personal', ip: '100.64.0.5', port: 22, user: 'danya', os: 'Arch Linux' })
  await a.subs.create({ name: 'VPS Германия — мастер-панель HubVPN', provider: 'Hetzner', category: 'Hosting', amount: 10, currency: 'EUR', period: 'mo', nextRenewal: '2026-09-01' })
  await a.subs.create({ name: 'Spotify Premium для семьи', provider: 'Spotify', category: 'Media', amount: 299, currency: 'RUB', period: 'mo', nextRenewal: '2026-08-20' })
  await a.subs.create({ name: 'Netflix', provider: 'Netflix', category: 'Media', amount: 15.5, currency: 'USD', period: 'mo', nextRenewal: '2026-01-01' })
  await a.subs.create({ name: 'Домен argus.dev на три года', provider: 'Namecheap', category: 'Hosting', amount: 12, currency: 'USD', period: 'yr', nextRenewal: '2027-04-26' })
  await a.accounts.create({ kind: 'bank', name: 'Т-Банк', institution: 'Тинькофф', currency: 'RUB', balance: 125000.49 })
  await a.accounts.create({ kind: 'bank', name: 'Сбербанк', institution: 'Сбер', currency: 'RUB', balance: 42000 })
  await a.accounts.create({ kind: 'exchange', name: 'OKX', institution: 'OKX', currency: 'USD', balance: 1500.25 })
  await a.accounts.create({ kind: 'ewallet', name: 'PayPal', institution: 'PayPal', currency: 'EUR', balance: 300 })
  await a.accounts.create({ kind: 'cash', name: 'Наличные', currency: 'RUB', balance: 5000 })
  await a.ai.create({ provider: 'anthropic', label: 'Claude Max 5x', kind: 'subscription', plan: 'Max 5x', account: 'demo@example.com' })
  await a.ai.create({ provider: 'openrouter', label: 'OpenRouter', kind: 'router', apiKey: 'sk-demo-not-real-000' })
  await a.ai.create({ provider: 'groq', label: 'Groq (бесплатный тариф)', kind: 'free-tier', payment: 'free' })
}

/**
 * Осмотр отрисованной страницы.
 *
 * Всё считается по ФАКТИЧЕСКОЙ геометрии в браузере, а не по классам: класс `truncate` в разметке
 * ничего не доказывает — важно, обрезан ли текст на самом деле при этой ширине окна.
 */
const INSPECT = () => {
  const problems = []
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const text = (el) => (el.textContent || '').trim().slice(0, 60)

  // 1. Обрезанный текст: содержимое шире, чем место под него.
  for (const el of document.querySelectorAll('span, div, td, th, li, button, a, h1, h2, h3, p')) {
    if (!visible(el) || el.children.length > 0) continue
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      problems.push({ kind: 'обрезан текст', text: text(el), width: el.clientWidth, needs: el.scrollWidth })
    }
  }

  // 2. Английские слова в интерфейсе: интерфейс русский, и латиница в подписи почти всегда
  //    означает недоделку. Названия компаний и коды валют — законное исключение.
  const ALLOWED = /^(argus|hubvpn|vps|ssh|sftp|rdp|api|cpu|ram|gpu|ip|id|usd|eur|rub|gbp|cny|jpy|chf|cad|aud|inr|brl|krw|try|pln|uah|kzt|aed|sek|nok|sgd|pkr|btc|eth|ton|usdt|ok|dk|net|max|pro|plus|free|claude|openai|openrouter|groq|spotify|netflix|github|paypal|okx|bybit|binance|hetzner|ovh|firstbyte|namecheap|linux|windows|macos|ubuntu|debian|arch|wayland|x11|nvenc|vaapi|wol|dns|tls|ssl|url|json|csv|pdf|nvidia|intel|amd|tinkoff|sber)$/i
  for (const el of document.querySelectorAll('span, div, button, label, h1, h2, h3, p, li, th, td')) {
    if (!visible(el) || el.children.length > 0) continue
    const t = (el.textContent || '').trim()
    if (!t || t.length > 40) continue
    const words = t.split(/[\s·—,.:()/]+/).filter(Boolean)
    const latin = words.filter((w) => /^[A-Za-z][A-Za-z-]*$/.test(w) && !ALLOWED.test(w))
    if (latin.length && !/[А-Яа-я]/.test(t)) problems.push({ kind: 'английский текст', text: t, words: latin })
  }

  // 3. Контраст текста к фону. Порог AA для обычного текста — 4.5:1; крупный (18pt+ или
  //    14pt жирный) допускает 3:1.
  const lum = (c) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  // Цвет с альфой: `rgba(245,158,11,0.15)` — это НЕ янтарный фон, это янтарная плёнка поверх
  // тёмного. Пока альфа игнорировалась, каждый цветной бейдж («Онлайн», «просрочено») выглядел
  // как текст на фоне того же цвета и попадал в отчёт с контрастом 1.0. Инструмент, который
  // врёт, хуже отсутствующего: по нему начинают «чинить» исправное.
  // Цвет спрашиваем У БРАУЗЕРА, а не разбираем строку сами.
  //
  // Tailwind v4 отдаёт полупрозрачные цвета в `oklab(0.23 0.002 0.006 / 0.6)`. Наивный разбор
  // «вытащить все числа» принимал координаты oklab за каналы RGB — получался почти чёрный цвет
  // с правдоподобной альфой, и каждый цветной бейдж оказывался «текстом на фоне того же
  // цвета». Canvas умеет привести любую форму записи к rgba, и это единственный способ не
  // пересобирать половину CSS-спецификации вручную.
  const probe = document.createElement('canvas').getContext('2d')
  const rgba = (css) => {
    if (!css || css === 'transparent') return null
    probe.fillStyle = '#000'
    probe.fillStyle = css
    const v = probe.fillStyle
    if (v.startsWith('#')) {
      const hex = v.length === 4 ? v.slice(1).split('').map((c) => c + c).join('') : v.slice(1)
      return { rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)), a: 1 }
    }
    const n = (v.match(/-?\d+(\.\d+)?/g) || []).map(Number)
    if (n.length < 3) return null
    return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 }
  }
  const bgOf = (el) => {
    // Идём вверх и НАКЛАДЫВАЕМ слои: полупрозрачный фон складывается с тем, что под ним.
    const layers = []
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const c = rgba(getComputedStyle(node).backgroundColor)
      if (!c || c.a === 0) continue
      layers.push(c)
      if (c.a === 1) break
    }
    let base = [18, 17, 16] // фон приложения, если ни один слой не оказался непрозрачным
    for (let i = layers.length - 1; i >= 0; i--) {
      const { rgb, a } = layers[i]
      base = rgb.map((c, k) => c * a + base[k] * (1 - a))
    }
    return base
  }
  for (const el of document.querySelectorAll('span, div, button, label, p, li, td, th, a')) {
    if (!visible(el) || el.children.length > 0) continue
    const t = text(el)
    if (!t) continue
    const cs = getComputedStyle(el)
    // Элементы со СВОИМ цветным фоном (бейджи, кнопки) пропускаем.
    //
    // Их фон почти всегда полупрозрачный, а Tailwind v4 записывает такие цвета в `oklab(… / a)`.
    // Canvas, которым мы нормализуем цвет, альфу у этой формы теряет — фон получается ярким, и
    // цветной бейдж выглядит «текстом на фоне того же цвета» с контрастом 1.03. Считать их
    // приблизительно нельзя: инструмент, который врёт, заставляет чинить исправное. Здесь ищем
    // ровно тот случай, ради которого детектор и написан, — приглушённый текст на общем фоне.
    // Пропускаем всё, где в цепочке фонов встретился полупрозрачный `oklab`/`oklch`: Canvas
    // теряет у этой формы альфу, и посчитанный контраст будет выдумкой. Так записаны все
    // цветные бейджи Tailwind v4 — их проверяет глаз на снимке, а детектор берёт на себя то,
    // что глаз пропускает: приглушённый текст на общем фоне.
    let unreliable = rgba(cs.backgroundColor)?.a > 0
    for (let n = el; n && !unreliable && n !== document.documentElement; n = n.parentElement) {
      const raw = getComputedStyle(n).backgroundColor
      if (/okla?b|oklch/.test(raw) && raw.includes('/')) unreliable = true
      if (rgba(raw)?.a === 1) break
    }
    if (unreliable) continue
    const fgc = rgba(cs.color)
    if (!fgc) continue
    const bg = bgOf(el)
    const fg = fgc.rgb.map((c, i) => c * fgc.a + bg[i] * (1 - fgc.a))
    const size = parseFloat(cs.fontSize)
    const big = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
    const l1 = lum(fg) + 0.05
    const l2 = lum(bg) + 0.05
    const ratio = l1 > l2 ? l1 / l2 : l2 / l1
    const need = big ? 3 : 4.5
    if (ratio < need) problems.push({ kind: 'низкий контраст', text: t, ratio: Number(ratio.toFixed(2)), need })
  }

  // 4. Кликабельное меньше 24×24: попасть мышью трудно, а требование доступности прямое.
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 24) {
      problems.push({ kind: 'мелкая кнопка', text: el.getAttribute('aria-label') || text(el), size: `${Math.round(r.width)}×${Math.round(r.height)}` })
    }
  }

  // 5. Кнопка без доступного имени: для программы чтения с экрана её просто нет.
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (!visible(el)) continue
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim()
    if (!name) problems.push({ kind: 'кнопка без имени', html: el.outerHTML.slice(0, 80) })
  }

  return problems
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'argus-uilab-'))}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.setViewportSize({ width: 1480, height: 940 })

const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)))
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)))

// Онбординг проходим ЧЕРЕЗ ИНТЕРФЕЙС: это тоже экран, и он тоже должен выдержать осмотр.
await page.screenshot({ path: join(out, 'lab-0-онбординг.png') })
const onboarding = await page.evaluate(INSPECT)

await page.getByLabel('Новый мастер-пароль').fill(MASTER)
await page.getByLabel('Мастер-пароль ещё раз').fill(MASTER)
await page.getByRole('checkbox').check()
await page.getByRole('button', { name: 'Создать' }).click()
await page.waitForSelector('nav', { timeout: 30_000 })
await page.evaluate(DEMO)
await page.waitForTimeout(2500)

const report = { сформирован: new Date().toISOString(), экраны: {}, ошибкиКонсоли: consoleErrors }
report.экраны['онбординг'] = onboarding

for (const label of ['Парк', 'Финансы', 'Подписки', 'ИИ', 'Настройки']) {
  const button = page.locator('nav button').filter({ hasText: new RegExp(`^${label}`) })
  if (!(await button.count())) {
    report.экраны[label] = [{ kind: 'экран не открылся', text: 'пункт меню не найден' }]
    continue
  }
  await button.first().click()
  await page.waitForTimeout(1800)
  await page.screenshot({ path: join(out, `lab-${label}.png`) })
  report.экраны[label] = await page.evaluate(INSPECT)
}

const total = Object.values(report.экраны).reduce((n, list) => n + list.length, 0)
writeFileSync(join(out, 'ui-lab.json'), JSON.stringify(report, null, 2))

console.log(`снимки и отчёт: ${out}`)
for (const [screen, list] of Object.entries(report.экраны)) {
  if (!list.length) continue
  console.log(`\n${screen}: ${list.length}`)
  const byKind = {}
  for (const p of list) (byKind[p.kind] ??= []).push(p)
  for (const [kind, items] of Object.entries(byKind)) {
    console.log(`  ${kind} (${items.length}):`)
    for (const i of items.slice(0, 6)) console.log(`    · ${JSON.stringify(i).slice(0, 150)}`)
    if (items.length > 6) console.log(`    … ещё ${items.length - 6}`)
  }
}
console.log(`\nвсего замечаний: ${total}${consoleErrors.length ? `, ошибок в консоли: ${consoleErrors.length}` : ''}`)

if (!keep) await app.close()
