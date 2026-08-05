#!/usr/bin/env node
// Сборка вшитого каталога логотипов компаний.
//
// Зачем вшивать, а не тянуть по домену на лету. Готовые сервисы «логотип по домену» существуют
// (logo.dev, Brandfetch, Logokit), но платят за них не деньгами: каждый такой запрос сообщает
// чужой компании, каким хостером, банком и биржей пользуется владелец, — то есть весь его
// портфель разом. Ради того, чтобы не отправить наружу лишний IP, в приложении написан целый
// модуль ip-privacy; отдавать тот же список добровольно было бы странно. Плюс Clearbit, на
// котором держались все подобные решения, отключён в декабре 2025 — проверено, домен больше не
// резолвится, и приложение, зависящее от такого сервиса, однажды просто перестаёт рисовать знаки.
//
// Здесь логотипы берутся из наборов под CC0 (simple-icons) и вшиваются в исходники РАЗОБРАННЫМИ
// на контуры — тем же форматом, что уже принят для знаков ИИ-провайдеров (assets/providers/marks.ts).
// Так знак рисуется обычными React-элементами, работает без сети и не заводит в приложении места,
// куда однажды подставят чужую строку.
//
// Запуск: npm run brand:logos

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'src', 'renderer', 'src', 'assets', 'brands', 'catalog.ts')

// Ключ каталога → slug в simple-icons. Ключи — это то, что приложение выводит из своих данных
// (хостер устройства, учреждение счёта, провайдер подписки), см. src/shared/brands.ts.
const BRANDS = {
  // Хостеры и облака
  hetzner: 'hetzner',
  ovh: 'ovh',
  digitalocean: 'digitalocean',
  vultr: 'vultr',
  linode: 'akamai',
  contabo: 'contabo',
  scaleway: 'scaleway',
  cloudflare: 'cloudflare',
  netcup: 'netcup',
  'yandex-cloud': 'yandexcloud',
  'google-cloud': 'googlecloud',
  // Финансы
  paypal: 'paypal',
  okx: 'okx',
  binance: 'binance',
  coinbase: 'coinbase',
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
  tether: 'tether',
  // Подписки и сервисы
  spotify: 'spotify',
  netflix: 'netflix',
  youtube: 'youtube',
  github: 'github',
  telegram: 'telegram',
  notion: 'notion',
  figma: 'figma',
  jetbrains: 'jetbrains',
  namecheap: 'namecheap',
  cloudflare_pages: 'cloudflarepages',
  vk: 'vk',
  boosty: 'boosty',
  steam: 'steam'
}

// Чего в simple-icons НЕТ и не будет — набор снимает знаки по требованию правообладателей.
// Перечислено, чтобы следующий не искал их заново: AWS, Oracle, Bybit, Kraken, OpenAI,
// Amazon, Microsoft. Знаки ИИ-провайдеров (включая OpenAI) уже лежат в assets/providers/marks.ts
// из другого набора; для остальных остаётся монограмма — она сделана так, чтобы ряд не рассыпался.

// Одна форма адреса, без вариантов: `/<slug>` отдаёт SVG с фирменным цветом внутри. Форма
// `/<slug>/_/`, которую предлагают некоторые примеры, отвечает 404 — проверено.
const SOURCE = (slug) => `https://cdn.simpleicons.org/${slug}`

/** Достать из SVG контуры и фирменный цвет. Разбор намеренно строгий: молча принять чужую
 *  разметку и вставить её в приложение — ровно то, чего этот формат и избегает. */
function parse(svg) {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]
  if (!vb) throw new Error('нет viewBox')
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)].map((m) => ({ d: m[1] }))
  if (!paths.length) throw new Error('нет контуров')
  return { vb, paths }
}

const catalog = {}
const failed = []

for (const [key, slug] of Object.entries(BRANDS)) {
  try {
    const res = await fetch(SOURCE(slug))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const svg = await res.text()
    const { vb, paths } = parse(svg)
    // Фирменный цвет лежит в самой иконке: simple-icons красит её без запроса переопределения.
    const tint = /fill="(#[0-9a-fA-F]{3,6})"/.exec(svg)?.[1] ?? '#94a3b8'
    catalog[key] = { vb, tint, paths }
  } catch (e) {
    failed.push(`${key} (${slug}): ${e.message}`)
  }
}

const body = Object.entries(catalog)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, v]) => `  '${key}': ${JSON.stringify(v)}`)
  .join(',\n')

writeFileSync(
  out,
  `// СГЕНЕРИРОВАНО tools/build-brand-catalog.mjs — правки руками потеряются.
//
// Логотипы компаний, вшитые контурами. Источник — simple-icons (CC0-1.0): сами файлы свободны от
// авторских прав, товарные знаки остаются за их владельцами, и здесь они используются по прямому
// назначению — обозначить компанию, о которой идёт речь.
//
// Формат намеренно совпадает с assets/providers/marks.ts: viewBox + контуры + фирменный цвет.
// Собран ${new Date().toISOString().slice(0, 10)}, брендов: ${Object.keys(catalog).length}.
import type { ProviderMark } from '../providers/marks'

export const BRAND_MARKS: Record<string, ProviderMark> = {
${body}
}
`
)

console.log(`каталог: ${Object.keys(catalog).length} брендов → ${out}`)
if (failed.length) console.log(`не собрано (${failed.length}):\n  ${failed.join('\n  ')}`)
