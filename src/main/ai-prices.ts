// Каталог моделей и цен: вшитый снапшот + живое обновление у тех, кто цены отдаёт.
//
// Вшитый каталог (resources/ai/model-prices.json, собирается tools/build-price-catalog.mjs из
// таблицы LiteLLM) нужен, чтобы посчитать расход по локальным логам сразу — до первого выхода
// в сеть и вообще без интернета. Живое обновление есть только у OpenRouter: остальные
// провайдеры цены по API не публикуют, и выдумывать их за них нельзя.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AiPrice } from './types'
import * as vault from './vault'

/** Запись вшитого каталога: короткие ключи, отсутствующее поле = «неизвестно». */
interface CatalogEntry {
  p: string
  m: string
  in?: number
  out?: number
  cw?: number
  cw1h?: number
  cr?: number
  ctx?: number
  mo?: number
  mode?: string
  v?: number
  t?: number
  c?: number
  dep?: string
}

interface CatalogFile {
  source: string
  builtAt: string
  models: CatalogEntry[]
}

const FETCH_TIMEOUT_MS = 15_000

function catalogPath(): string {
  // В собранном приложении каталог лежит распакованным рядом с бинарником, в разработке — в репозитории.
  const packed = join(process.resourcesPath || '', 'ai', 'model-prices.json')
  if (existsSync(packed)) return packed
  return join(app.getAppPath(), 'resources', 'ai', 'model-prices.json')
}

export function readCatalog(path = catalogPath()): AiPrice[] {
  if (!existsSync(path)) return []
  let parsed: CatalogFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as CatalogFile
  } catch {
    // Битый каталог не должен ронять запуск: без цен приложение показывает токены без денег.
    return []
  }
  if (!Array.isArray(parsed.models)) return []
  const at = Date.parse(parsed.builtAt || '') || Date.now()
  return parsed.models.map((e) => ({
    provider: e.p,
    model: e.m,
    input: e.in ?? null,
    output: e.out ?? null,
    cacheWrite: e.cw ?? null,
    cacheWrite1h: e.cw1h ?? null,
    cacheRead: e.cr ?? null,
    contextTokens: e.ctx ?? null,
    maxOutputTokens: e.mo ?? null,
    mode: e.mode ?? null,
    supportsVision: e.v === 1,
    supportsTools: e.t === 1,
    supportsCaching: e.c === 1,
    deprecatedAt: e.dep ?? null,
    source: 'catalog' as const,
    fetchedAt: at
  }))
}

/**
 * Залить вшитый каталог в базу, если её ещё нечем наполнить.
 *
 * Обновление живых цен (source='openrouter') и ручные правки каталог НЕ затирает: запись идёт
 * только когда таблица пуста. Иначе каждый запуск откатывал бы свежие цены к снапшоту сборки.
 */
export function seedPricesIfEmpty(): number {
  if (!vault.isUnlocked()) return 0
  if (vault.aiPriceCount() > 0) return 0
  const prices = readCatalog()
  if (!prices.length) return 0
  return vault.upsertAiPrices(prices)
}

/** Перезалить вшитый каталог поверх (кнопка «обновить каталог»). Ручные цены не трогает. */
export function reseedPrices(): number {
  if (!vault.isUnlocked()) return 0
  const prices = readCatalog()
  if (!prices.length) return 0
  const manual = new Set(
    vault
      .listAiPrices()
      .filter((p) => p.source === 'manual')
      .map((p) => `${p.provider}/${p.model}`)
  )
  const fresh = prices.filter((p) => !manual.has(`${p.provider}/${p.model}`))
  return vault.upsertAiPrices(fresh)
}

interface OpenRouterModel {
  id?: string
  name?: string
  context_length?: number
  architecture?: { input_modalities?: string[] }
  top_provider?: { max_completion_tokens?: number | null }
  supported_parameters?: string[]
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_write?: string
    input_cache_read?: string
  }
}

/** Цены OpenRouter приходят строками («0.0000015»). Пустая строка и «-1» = цены нет. */
function num(v: string | undefined): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Живые цены OpenRouter. Ключ не нужен — список моделей открыт; но если он есть, шлём,
 * чтобы попасть под лимиты аккаунта, а не общие.
 */
export async function refreshOpenRouterPrices(apiKey?: string | null): Promise<{ ok: boolean; count: number; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    })
    if (!r.ok) return { ok: false, count: 0, error: `HTTP ${r.status}` }
    const payload = (await r.json()) as { data?: OpenRouterModel[] }
    const list = Array.isArray(payload.data) ? payload.data : []
    if (!list.length) return { ok: false, count: 0, error: 'пустой список моделей' }
    const now = Date.now()
    const prices: AiPrice[] = []
    for (const m of list) {
      if (!m.id) continue
      const params = m.supported_parameters ?? []
      prices.push({
        provider: 'openrouter',
        model: m.id,
        input: num(m.pricing?.prompt),
        output: num(m.pricing?.completion),
        cacheWrite: num(m.pricing?.input_cache_write),
        // У OpenRouter один вид кэша — часового отдельной ценой нет.
        cacheWrite1h: null,
        cacheRead: num(m.pricing?.input_cache_read),
        contextTokens: m.context_length ?? null,
        maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
        mode: 'chat',
        supportsVision: (m.architecture?.input_modalities ?? []).includes('image'),
        supportsTools: params.includes('tools') || params.includes('tool_choice'),
        supportsCaching: num(m.pricing?.input_cache_read) != null,
        deprecatedAt: null,
        source: 'openrouter',
        fetchedAt: now
      })
    }
    return { ok: true, count: vault.upsertAiPrices(prices) }
  } catch (e) {
    const aborted = controller.signal.aborted
    return { ok: false, count: 0, error: aborted ? 'тайм-аут' : (e as Error).message || 'сеть недоступна' }
  } finally {
    clearTimeout(timer)
  }
}
