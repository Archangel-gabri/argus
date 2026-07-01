import type { AiCheck } from './types'

// Validity / quota probes for stored AI keys. Keys stay in main; only the verdict crosses IPC.
// OpenRouter exposes real remaining credit; others are validity-only (status from HTTP code).
export async function checkAccount(provider: string, apiKey: string): Promise<AiCheck> {
  if (!apiKey) return { status: 'nokey' }
  const p = provider.toLowerCase()
  try {
    if (p.includes('openrouter')) {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` } })
      if (r.status === 401) return { status: 'invalid' }
      if (!r.ok) return { status: 'error', detail: `HTTP ${r.status}` }
      const j = (await r.json()) as { data?: { limit?: number; usage?: number; limit_remaining?: number } }
      const d = j.data ?? {}
      const remaining =
        d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null)
      return { status: 'valid', remaining: remaining ?? null, usage: d.usage ?? null }
    }
    if (p.includes('anthropic') || p.includes('claude')) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      })
      if (r.status === 401 || r.status === 403) return { status: 'invalid' }
      if (r.status === 429) return { status: 'quota' }
      if (r.ok || r.status === 400) return { status: 'valid' } // 400 = malformed but key accepted
      return { status: 'error', detail: `HTTP ${r.status}` }
    }
    if (p.includes('openai') || p.includes('codex') || p.includes('chatgpt')) {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } })
      if (r.status === 401) return { status: 'invalid' }
      if (r.status === 429) return { status: 'quota' }
      if (r.ok) return { status: 'valid' }
      return { status: 'error', detail: `HTTP ${r.status}` }
    }
    if (p.includes('gemini') || p.includes('google')) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      )
      if (r.status === 400 || r.status === 403) return { status: 'invalid' }
      if (r.ok) return { status: 'valid' }
      return { status: 'error', detail: `HTTP ${r.status}` }
    }
    return { status: 'error', detail: 'провайдер без авто-проверки' }
  } catch (e) {
    return { status: 'error', detail: (e as Error).message }
  }
}
