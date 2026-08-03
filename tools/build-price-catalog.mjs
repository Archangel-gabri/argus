#!/usr/bin/env node
// Сборка вшитого каталога цен из таблицы LiteLLM.
//
// Зачем вшивать. Цены нужны, чтобы посчитать расход по локальным логам, и нужны сразу — до
// первого выхода в сеть и независимо от того, работает ли интернет. Полная таблица LiteLLM —
// 1.7 МБ и 2986 моделей, из которых владельцу доступны десятки; здесь она отбирается по
// провайдерам и ужимается до коротких ключей.
//
// Запуск: node tools/build-price-catalog.mjs [путь-к-model_prices_and_context_window.json]
// Без аргумента файл скачивается с GitHub.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Провайдеры, которые реально могут появиться у владельца: прямые API, роутеры, бесплатные
// tier'ы и локальная Ollama. Остальные 100+ (bedrock, azure, vertex, fireworks…) отбрасываются:
// их модели никогда не встретятся в логах, а вес каталога утраивают.
const PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'groq',
  'xai',
  'mistral',
  'ollama',
  'openrouter',
  'perplexity',
  'cerebras',
  'nvidia_nim',
  'moonshot',
  'dashscope',
  'together_ai',
  'nebius',
  'sambanova',
  'minimax'
])

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'resources', 'ai', 'model-prices.json')

async function loadSource(pathArg) {
  if (pathArg) return JSON.parse(readFileSync(pathArg, 'utf8'))
  const r = await fetch(SOURCE)
  if (!r.ok) throw new Error(`LiteLLM отдал HTTP ${r.status}`)
  return await r.json()
}

const raw = await loadSource(process.argv[2])
const models = []

for (const [name, v] of Object.entries(raw)) {
  if (!v || typeof v !== 'object') continue
  const provider = v.litellm_provider
  if (!PROVIDERS.has(provider)) continue
  // Модель без цены входа и выхода в каталоге бесполезна: считать по ней нечего. Исключение —
  // ollama, где ноль это не «неизвестно», а «своё железо, платить некому».
  if (v.input_cost_per_token == null && v.output_cost_per_token == null && provider !== 'ollama') continue

  const entry = { p: provider, m: name }
  const put = (key, value) => {
    if (value != null) entry[key] = value
  }
  put('in', v.input_cost_per_token)
  put('out', v.output_cost_per_token)
  put('cw', v.cache_creation_input_token_cost)
  // Часовой кэш дороже пятиминутного, и у Claude Code он реально включается. Одна ставка на
  // оба вида кэша занижала бы счёт там, где сессия живёт дольше часа.
  put('cw1h', v.cache_creation_input_token_cost_above_1hr)
  put('cr', v.cache_read_input_token_cost)
  put('ctx', v.max_input_tokens)
  put('mo', v.max_output_tokens)
  put('mode', v.mode)
  if (v.supports_vision) entry.v = 1
  if (v.supports_function_calling) entry.t = 1
  if (v.supports_prompt_caching) entry.c = 1
  put('dep', v.deprecation_date)
  models.push(entry)
}

models.sort((a, b) => (a.p === b.p ? a.m.localeCompare(b.m) : a.p.localeCompare(b.p)))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify({ source: 'litellm', builtAt: new Date().toISOString().slice(0, 10), models }, null, 0)
)

const byProvider = {}
for (const m of models) byProvider[m.p] = (byProvider[m.p] ?? 0) + 1
console.log(`каталог: ${models.length} моделей → ${out}`)
console.log(
  Object.entries(byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}=${n}`)
    .join(' ')
)
