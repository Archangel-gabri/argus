import type { AiCheck } from './types'

// Validity / quota probes for stored AI keys. Keys stay in main; only the verdict crosses IPC.
// OpenRouter exposes real remaining credit; others are validity-only (status from HTTP code).
const CHECK_TIMEOUT_MS = 10_000

class CheckTimeoutError extends Error {}

async function fetchForCheck(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new CheckTimeoutError('тайм-аут проверки')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function knownFailure(status: number): AiCheck | null {
  if (status === 401 || status === 403) return { status: 'invalid' }
  if (status === 429) return { status: 'quota' }
  return null
}

function unknownHttp(status: number): AiCheck {
  return { status: 'error', detail: `HTTP ${status} — результат неизвестен` }
}

export async function checkAccount(provider: string, apiKey: string): Promise<AiCheck> {
  if (!apiKey) return { status: 'nokey' }
  const p = provider.toLowerCase()
  try {
    if (p.includes('openrouter')) {
      const r = await fetchForCheck('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (!r.ok) return unknownHttp(r.status)
      let payload: unknown
      try {
        payload = await r.json()
      } catch {
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      }
      if (!payload || typeof payload !== 'object' || !('data' in payload))
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      const d = (payload as { data: { limit?: number; usage?: number; limit_remaining?: number } }).data
      if (!d || typeof d !== 'object')
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      const remaining =
        d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null)
      return { status: 'valid', remaining: remaining ?? null, usage: d.usage ?? null }
    }
    if (p.includes('anthropic') || p.includes('claude')) {
      // Список моделей — read-only probe: прежний POST /messages создавал реальный запрос,
      // мог расходовать квоту и становился ложной ошибкой после снятия hardcoded-модели.
      const r = await fetchForCheck('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      })
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    if (p.includes('openai') || p.includes('codex') || p.includes('chatgpt')) {
      const r = await fetchForCheck('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    if (p.includes('gemini') || p.includes('google')) {
      // Ключ в query string попадает в URL сетевой телеметрии и прокси-логов; Google API
      // принимает тот же credential в заголовке, где он не становится частью адреса.
      const r = await fetchForCheck('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey }
      })
      const failure = knownFailure(r.status)
      if (failure || r.status === 400) return failure ?? { status: 'invalid' }
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    return { status: 'error', detail: 'Автопроверка для провайдера недоступна' }
  } catch (e) {
    const detail = e instanceof CheckTimeoutError ? e.message : (e as Error).message || 'неизвестная ошибка'
    return { status: 'error', detail: `Сеть: ${detail}` }
  }
}
