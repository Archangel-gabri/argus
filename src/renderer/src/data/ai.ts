export interface AIAccount {
  id: string
  provider: string
  glyph: string
  plan: string
  keyValid: boolean
  creditRemaining?: number // USD, when queryable
  usageMonth?: number // USD this month, when queryable
  source: 'live' | 'manual'
  note?: string
}

// Honest feasibility: OpenRouter exposes credit/usage; others = key-validity check + manual plan.
export const MOCK_AI: AIAccount[] = [
  { id: 'openrouter', provider: 'OpenRouter', glyph: 'OR', plan: 'pay-as-you-go', keyValid: true, creditRemaining: 7.32, usageMonth: 42.1, source: 'live' },
  { id: 'anthropic', provider: 'Anthropic · Claude', glyph: 'A', plan: 'Pro', keyValid: true, source: 'manual', note: 'per-token usage = org-admin only' },
  { id: 'openai', provider: 'OpenAI · Codex/ChatGPT', glyph: 'OA', plan: 'Plus', keyValid: true, source: 'manual', note: 'billing API deprecated' },
  { id: 'gemini', provider: 'Google · Gemini', glyph: 'G', plan: 'Free tier', keyValid: true, source: 'manual', note: 'quota visible in AI Studio only' }
]
