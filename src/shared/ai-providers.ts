// Кто есть кто среди провайдеров: семьи, домены входа и способы входа через чужой аккаунт.
//
// Одна запись реестра — это доступ, а не компания. У владельца доступ к OpenAI идёт тремя
// путями сразу: подписка ChatGPT, Codex CLI через сторонний роутер и ключ API. Аккаунты у них
// общие — это одни и те же почты, — поэтому список аккаунтов собирается по СЕМЬЕ провайдера,
// а не по отдельной записи.
//
// Второй факт, без которого поиск паролей находит пустоту: в большинство сервисов владелец
// входит через Google. В браузере тогда сохранён пароль от accounts.google.com, а на домене
// провайдера записи нет вовсе.

/** Каноническое имя семьи: все алиасы приводятся к одному ключу. */
export const PROVIDER_FAMILY: Record<string, string> = {
  openai: 'openai',
  chatgpt: 'openai',
  codex: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  gemini: 'google',
  google: 'google',
  'google ai studio': 'google',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  github: 'github',
  copilot: 'github',
  cursor: 'cursor',
  mistral: 'mistral',
  groq: 'groq',
  cerebras: 'cerebras',
  perplexity: 'perplexity',
  modelscope: 'modelscope',
  nvidia_nim: 'nvidia',
  nvidia: 'nvidia',
  ollama: 'ollama',
  tavily: 'tavily',
  exa: 'exa',
  firecrawl: 'firecrawl',
  xai: 'xai',
  grok: 'xai',
  huggingface: 'huggingface'
}

/** Семья провайдера. Незнакомое имя остаётся само собой — так новый провайдер не смешивается с чужими. */
export function providerFamily(provider: string): string {
  const key = provider.trim().toLowerCase()
  return PROVIDER_FAMILY[key] ?? key
}

/** Домены, на которых у семьи бывают сохранённые пароли. */
export const FAMILY_DOMAINS: Record<string, string[]> = {
  openai: ['openai.com', 'chatgpt.com'],
  anthropic: ['claude.ai', 'anthropic.com'],
  google: ['google.com', 'aistudio.google.com'],
  deepseek: ['deepseek.com'],
  openrouter: ['openrouter.ai'],
  github: ['github.com'],
  cursor: ['cursor.sh', 'cursor.com'],
  mistral: ['mistral.ai'],
  groq: ['groq.com'],
  cerebras: ['cerebras.ai'],
  perplexity: ['perplexity.ai'],
  modelscope: ['modelscope.cn'],
  nvidia: ['nvidia.com'],
  tavily: ['tavily.com'],
  exa: ['exa.ai'],
  firecrawl: ['firecrawl.dev'],
  huggingface: ['huggingface.co'],
  xai: ['x.ai', 'grok.com']
}

/**
 * Домены поставщиков входа.
 *
 * Пароль от accounts.google.com — это не пароль от OpenAI, поэтому такие записи попадают в
 * список отдельно и с пометкой: они «возможный вход», а не подтверждённый аккаунт сервиса.
 */
export const IDENTITY_DOMAINS: Record<string, string> = {
  'accounts.google.com': 'Google',
  'google.com': 'Google',
  'myaccount.google.com': 'Google',
  'github.com': 'GitHub',
  'appleid.apple.com': 'Apple',
  'login.live.com': 'Microsoft',
  'account.microsoft.com': 'Microsoft'
}

/** Домены, на которых семья реально принимает вход через чужой аккаунт. */
export const FAMILY_IDENTITY: Record<string, string[]> = {
  openai: ['Google', 'Microsoft', 'Apple'],
  anthropic: ['Google'],
  google: ['Google'],
  cursor: ['Google', 'GitHub'],
  openrouter: ['Google', 'GitHub'],
  deepseek: ['Google'],
  huggingface: ['Google', 'GitHub'],
  perplexity: ['Google', 'Apple'],
  modelscope: ['GitHub']
}

/** Хост записи без схемы и пути. */
export function hostOf(originUrl: string): string {
  return originUrl.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
}

/** Точное совпадение домена или его поддомена. Подстрока сделала бы «notopenai.com» своим. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export type LoginKind = 'direct' | 'identity'

/**
 * Как сохранённая запись относится к семье.
 *
 * `direct` — пароль от самого сервиса. `identity` — пароль от поставщика входа, которым в этот
 * сервис можно войти. null — запись к семье отношения не имеет.
 */
export function classifyLogin(
  originUrl: string,
  family: string,
  extraDomains: string[] = []
): { kind: LoginKind; via?: string } | null {
  const host = hostOf(originUrl)
  const own = [...(FAMILY_DOMAINS[family] ?? []), ...extraDomains]
  if (own.some((d) => hostMatches(host, d))) return { kind: 'direct' }

  const allowed = FAMILY_IDENTITY[family] ?? []
  for (const [domain, name] of Object.entries(IDENTITY_DOMAINS)) {
    if (!allowed.includes(name)) continue
    if (hostMatches(host, domain)) return { kind: 'identity', via: name }
  }
  return null
}
