// Локальный ИИ-ассистент заполнения форм (REDESIGN-2026-07 §3 «ИИ-заполнение форм»).
// Приватно, без облака: локальная Ollama (дефолт localhost, override через ARGUS_OLLAMA_URL).
// Владелец: локальный Ollama по умолчанию (SPEC р.7); большой узел — castiel-pc по Tailscale.
import type { DeviceInput, DeviceKind, Currency } from './types'
import { CURRENCY_CODES } from './types'

const BASE = (process.env.ARGUS_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')

const KINDS: DeviceKind[] = ['server', 'pc', 'router', 'other']
const CURRENCIES: readonly string[] = CURRENCY_CODES

export interface AssistResult {
  ok: boolean
  fields?: Partial<DeviceInput>
  model?: string
  error?: string
}

/** Первая доступная модель (или дефолт), чтобы не хардкодить тег под конкретную машину. */
async function pickModel(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    const data = (await r.json()) as { models?: Array<{ name?: string }> }
    const names = (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n)
    // Предпочитаем инструкт-модели среднего размера, иначе — первую попавшуюся.
    return names.find((n) => /qwen2\.5|llama3|mistral/i.test(n)) ?? names[0] ?? null
  } catch {
    return null
  }
}

const SYSTEM =
  'Ты извлекаешь поля устройства из произвольного текста (ssh-строка, конфиг, письмо хостера, заметка). ' +
  'Верни СТРОГО JSON с полями (пропусти те, которых нет в тексте): ' +
  'name (строка), provider (хостер/бренд), kind (одно из: server,pc,phone,watch,buds,router,other), ' +
  'role (например master/exit/cascade), ip (хост или IP), port (число), user (ssh-логин), ' +
  'os, country, flag (эмодзи флага), consoleUrl (URL панели), amount (число, стоимость в месяц), ' +
  'currency (ISO-код валюты: USD, EUR, RUB, GBP, CNY, JPY, … — как в тексте). ' +
  'Не выдумывай значения, которых нет в тексте.'

function coerce(raw: unknown): Partial<DeviceInput> {
  const o = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
    return undefined
  }
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const out: Partial<DeviceInput> = {}
  const name = str(o.name)
  if (name) out.name = name
  const provider = str(o.provider)
  if (provider) out.provider = provider
  const kind = str(o.kind)?.toLowerCase()
  if (kind && (KINDS as string[]).includes(kind)) out.kind = kind as DeviceKind
  const role = str(o.role)
  if (role) out.role = role
  const ip = str(o.ip) ?? str(o.host)
  if (ip) out.ip = ip
  const port = num(o.port)
  if (port && port > 0 && port < 65536) out.port = port
  const user = str(o.user)
  if (user) out.user = user.split('@')[0] // модель иногда пишет user@host — берём логин
  const os = str(o.os)
  if (os) out.os = os
  const country = str(o.country)
  if (country) out.country = country
  // Флаг принимаем только если это реальный emoji-флаг (пара regional indicators);
  // маленькие модели часто возвращают битую escape-строку вроде "Ὠ0".
  const flag = str(o.flag)
  const flagMatch = flag?.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)
  if (flagMatch) out.flag = flagMatch[0]
  const consoleUrl = str(o.consoleUrl) ?? str(o.console_url)
  if (consoleUrl) out.consoleUrl = consoleUrl
  const amount = num(o.amount)
  const currencyRaw = str(o.currency)?.toUpperCase()
  const currency = currencyRaw && (CURRENCIES as string[]).includes(currencyRaw) ? (currencyRaw as Currency) : 'USD'
  if (amount && amount > 0) out.cost = { amount, currency, usd: 0 }
  return out
}

/** Извлечь поля устройства из произвольного текста через локальную Ollama. Секретов не парсим. */
export async function parseDevice(text: string): Promise<AssistResult> {
  const clean = (text || '').slice(0, 4000).trim()
  if (!clean) return { ok: false, error: 'Пустой текст' }
  const model = await pickModel()
  if (!model) return { ok: false, error: `Ollama недоступна (${BASE}). Запусти локально или включи castiel-pc.` }
  try {
    const r = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system: SYSTEM,
        prompt: `Текст:\n${clean}`,
        format: 'json',
        stream: false,
        options: { temperature: 0 }
      }),
      // Локальная модель на CPU может быть медленной на холодную; GPU-узел (castiel-pc) быстрее.
      signal: AbortSignal.timeout(90000)
    })
    if (!r.ok) return { ok: false, error: `Ollama HTTP ${r.status}` }
    const data = (await r.json()) as { response?: string }
    let parsed: unknown
    try {
      parsed = JSON.parse(data.response ?? '{}')
    } catch {
      return { ok: false, error: 'Модель вернула не-JSON', model }
    }
    return { ok: true, fields: coerce(parsed), model }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
