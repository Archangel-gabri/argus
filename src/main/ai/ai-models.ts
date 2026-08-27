// Живой список моделей у каждого доступа.
//
// Каталог цен (resources/ai/model-prices.json) знает, сколько стоит модель, но не знает, какие
// модели доступны ИМЕННО ЭТОМУ ключу: у роутера свой набор, у бесплатного тарифа урезанный, а
// новая модель появляется у провайдера раньше, чем в любом каталоге. Поэтому список спрашивается
// у самого провайдера — почти все отдают его одним GET по тому же ключу, которым потом работают.
//
// Ответ провайдера — это ПЕРЕЧЕНЬ, а не прайс-лист: цены среди них отдаёт только OpenRouter.
// Остальные модели сопоставляются с каталогом по имени, и если цены нет, так и показывается.

import { keyEndpointBase } from './ai'
import type { AiAccess } from '../types'

const TIMEOUT_MS = 15_000

export interface FetchedModel {
  id: string
  /** Человеческое имя, если провайдер его прислал. */
  name?: string
  contextTokens?: number | null
}

export interface FetchModelsResult {
  ok: boolean
  models: FetchedModel[]
  error?: string
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers, signal: controller.signal })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
    return { ok: true, data: await r.json() }
  } catch (e) {
    return { ok: false, error: controller.signal.aborted ? 'тайм-аут' : (e as Error).message || 'сеть недоступна' }
  } finally {
    clearTimeout(timer)
  }
}

/** Ответ в формате OpenAI: `{ data: [{ id }] }`. Его отдают почти все, кроме Google и Ollama. */
function parseOpenAiShape(data: unknown): FetchedModel[] {
  const list = (data as { data?: Array<{ id?: string; context_length?: number }> })?.data
  if (!Array.isArray(list)) return []
  return list
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => ({ id: m.id as string, contextTokens: m.context_length ?? null }))
}

/** Google отдаёт `models[]` с именами вида `models/gemini-2.5-flash`. */
export function parseGeminiShape(data: unknown): FetchedModel[] {
  const list = (data as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number }> })?.models
  if (!Array.isArray(list)) return []
  return list
    .filter((m) => typeof m?.name === 'string' && m.name)
    .map((m) => ({
      // Префикс `models/` — часть адреса ресурса, а не имя модели; в каталоге цен его нет.
      id: (m.name as string).replace(/^models\//, ''),
      name: m.displayName,
      contextTokens: m.inputTokenLimit ?? null
    }))
}

/** Ollama отдаёт установленные модели в `models[].name`. */
export function parseOllamaShape(data: unknown): FetchedModel[] {
  const list = (data as { models?: Array<{ name?: string; model?: string }> })?.models
  if (!Array.isArray(list)) return []
  return list
    .map((m) => m.name || m.model)
    .filter((v): v is string => Boolean(v))
    .map((id) => ({ id }))
}

/**
 * Куда идти за списком моделей.
 *
 * Адрес берётся у записи, а если его там нет — у канала, где лежит ключ. Это тот же урок, что с
 * проверкой ключа: у аккаунта OpenAI ключ выписан сторонним роутером и живёт в канале вместе со
 * своим адресом. Спрашивать список у api.openai.com роутерным ключом значит получать 401 и молча
 * не обновлять модели никогда.
 */
export function modelsEndpoint(access: AiAccess): { url: string; headers: Record<string, string>; shape: 'openai' | 'gemini' | 'ollama' } | null {
  const base = (access.baseUrl ?? keyEndpointBase(access))?.replace(/\/+$/, '')
  const p = access.provider.toLowerCase()

  if (p === 'ollama' || access.kind === 'local')
    return { url: `${base || 'http://127.0.0.1:11434'}/api/tags`, headers: {}, shape: 'ollama' }

  if (p.includes('anthropic') || p.includes('claude'))
    return {
      url: `${base || 'https://api.anthropic.com/v1'}/models`,
      headers: { 'anthropic-version': '2023-06-01' },
      shape: 'openai'
    }

  if (p.includes('gemini') || p.includes('google'))
    return {
      url: `${base || 'https://generativelanguage.googleapis.com/v1beta'}/models`,
      headers: {},
      shape: 'gemini'
    }

  const openAiCompatible: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    codex: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    nvidia_nim: 'https://integrate.api.nvidia.com/v1',
    modelscope: 'https://api-inference.modelscope.cn/v1',
    xai: 'https://api.x.ai/v1'
  }
  const fallback = openAiCompatible[p]
  if (base || fallback) return { url: `${base || fallback}/models`, headers: {}, shape: 'openai' }
  return null
}

/**
 * Спросить у провайдера, какие модели ему доступны.
 *
 * Ключ передаётся так, как хочет конкретный провайдер: Anthropic ждёт `x-api-key`, Google —
 * `x-goog-api-key`, остальные — обычный Bearer. Локальной Ollama ключ не нужен вовсе.
 */
export async function fetchModels(access: AiAccess, apiKey: string | null): Promise<FetchModelsResult> {
  const endpoint = modelsEndpoint(access)
  if (!endpoint) return { ok: false, models: [], error: 'Провайдер не отдаёт список моделей' }

  const headers: Record<string, string> = { accept: 'application/json', ...endpoint.headers }
  if (apiKey) {
    const p = access.provider.toLowerCase()
    if (p.includes('anthropic') || p.includes('claude')) headers['x-api-key'] = apiKey
    else if (p.includes('gemini') || p.includes('google')) headers['x-goog-api-key'] = apiKey
    else headers.Authorization = `Bearer ${apiKey}`
  } else if (endpoint.shape !== 'ollama' && access.kind !== 'local' && access.kind !== 'free-tier') {
    return { ok: false, models: [], error: 'Ключ не сохранён — спросить список не у кого' }
  }

  const r = await getJson(endpoint.url, headers)
  if (!r.ok) return { ok: false, models: [], error: r.error }

  const models =
    endpoint.shape === 'gemini'
      ? parseGeminiShape(r.data)
      : endpoint.shape === 'ollama'
        ? parseOllamaShape(r.data)
        : parseOpenAiShape(r.data)

  if (!models.length) return { ok: false, models: [], error: 'Провайдер вернул пустой список' }
  return { ok: true, models }
}
