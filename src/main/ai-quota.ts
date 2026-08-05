// Квоты: что провайдер сам говорит о расходе аккаунта.
//
// До этого модуля в реестре было два числа, и оба — наши: расход, посчитанный по локальным логам,
// и оценка потолка по наблюдаемому максимуму. Оба описывают ОДНУ машину. Владелец пользуется теми
// же аккаунтами с телефона и второго ноутбука, поэтому вопрос «сколько я на самом деле сжёг из
// лимита» из локальных логов не решается — только у провайдера.
//
// Провайдеры отвечают на него тремя разными способами, и все три здесь:
//   • подписки (Anthropic, Cursor) — за сессией веб-панели, куку берём в браузере владельца;
//   • ключевые сервисы (OpenRouter, Firecrawl, Tavily) — обычным запросом с API-ключом;
//   • остальные (ChatGPT, Gemini, Exa) квоту не публикуют вовсе — и тогда её здесь нет.
//
// Пустой ответ — это «сервис не говорит», а не «ноль». Разница принципиальная: ноль в полосе
// выглядит как «всё цело», хотя на деле мы просто не знаем.

import { cookieHeader, readCookies } from './browser-cookies'
import type { AiAccess } from './types'

const TIMEOUT_MS = 20_000

/** Браузерный агент. Панели подписок отвечают только на запросы, похожие на браузерные. */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** Один период или счёт, как его назвал провайдер. Без accessId и времени — их проставит вызвавший. */
export interface QuotaSlice {
  scope: string
  label: string
  ratio: number | null
  used: number | null
  limit: number | null
  unit: string
  resetsAt?: number | null
  plan?: string | null
  model?: string | null
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function ms(iso: unknown): number | null {
  return typeof iso === 'string' ? Date.parse(iso) || null : null
}

// --- Разборщики ответов (чистые: их видно в тестах без сети) -----------------------------------

interface AnthropicLimit {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } | null } | null
}

/**
 * Anthropic: проценты пятичасового окна и недели — ровно то, что показывает claude.ai.
 *
 * Потолка в токенах здесь нет и не будет: Anthropic его не публикует. Поэтому у среза есть доля,
 * но нет знаменателя — и это честнее, чем подставить выдуманный.
 */
export function parseAnthropicUsage(data: unknown): QuotaSlice[] {
  const d = data as { limits?: AnthropicLimit[]; five_hour?: { utilization?: number; resets_at?: string } }
  if (!d || (!Array.isArray(d.limits) && !d.five_hour)) return []

  const LABEL: Record<string, string> = {
    session: 'Текущая сессия',
    weekly_all: 'Неделя',
    weekly_opus: 'Неделя · Opus',
    weekly_scoped: 'Неделя'
  }

  const out: QuotaSlice[] = []
  for (const l of d.limits ?? []) {
    if (typeof l.percent !== 'number' || !l.kind) continue
    const model = l.scope?.model?.display_name ?? null
    out.push({
      scope: l.kind === 'session' ? 'session' : model ? 'week-model' : 'week',
      label: model ? `Неделя · ${model}` : (LABEL[l.kind] ?? l.kind),
      ratio: l.percent / 100,
      used: null,
      limit: null,
      unit: '%',
      resetsAt: ms(l.resets_at),
      model
    })
  }
  return out
}

/**
 * Cursor: тариф и включённый расход расчётного периода.
 *
 * На бесплатном тарифе `limit` равен нулю — это не «нет данных», а «включённого расхода нет
 * вовсе». Доля в таком случае не считается: делить на ноль нечего, а тариф и дату сказать можно.
 */
export function parseCursorUsage(data: unknown): QuotaSlice[] {
  const d = data as {
    membershipType?: string
    billingCycleEnd?: string
    individualUsage?: { plan?: { used?: number; limit?: number } }
  }
  if (!d || typeof d.membershipType !== 'string') return []

  const plan = d.individualUsage?.plan
  const limit = typeof plan?.limit === 'number' ? plan.limit : null
  const used = typeof plan?.used === 'number' ? plan.used : 0
  return [
    {
      scope: 'period',
      label: 'Включено в тариф',
      ratio: limit && limit > 0 ? used / limit : null,
      used,
      limit,
      unit: '$',
      resetsAt: ms(d.billingCycleEnd),
      plan: d.membershipType
    }
  ]
}

/** OpenRouter: сколько денег внесено и сколько из них истрачено. */
export function parseOpenRouterCredits(data: unknown): QuotaSlice[] {
  const d = (data as { data?: { total_credits?: number; total_usage?: number } })?.data
  if (!d || typeof d.total_credits !== 'number') return []
  const used = typeof d.total_usage === 'number' ? d.total_usage : 0
  return [
    {
      scope: 'balance',
      label: 'Счёт',
      ratio: d.total_credits > 0 ? used / d.total_credits : null,
      used,
      limit: d.total_credits,
      unit: '$'
    }
  ]
}

/** Firecrawl: кредиты и токены расчётного периода — два разных счётчика, оба свои. */
export function parseFirecrawl(credits: unknown, tokens: unknown): QuotaSlice[] {
  const out: QuotaSlice[] = []
  const pairs: Array<[unknown, string, string, string]> = [
    [credits, 'period', 'Кредиты', 'кредитов'],
    [tokens, 'tokens', 'Токены', 'токенов']
  ]
  for (const [raw, scope, label, unit] of pairs) {
    const d = (
      raw as {
        data?: {
          remainingCredits?: number
          planCredits?: number
          remainingTokens?: number
          planTokens?: number
          billingPeriodEnd?: string
        }
      }
    )?.data
    if (!d) continue
    const limit = d.planCredits ?? d.planTokens
    const remaining = d.remainingCredits ?? d.remainingTokens
    if (typeof limit !== 'number') continue
    // Без остатка срез не строим вовсе. Подстановка нуля дала бы «израсходовано всё» — полосу
    // в край и красный цвет там, где сервис просто не назвал цифру. Это та же ошибка, что ноль
    // вместо неизвестного, только вывернутая наизнанку.
    if (typeof remaining !== 'number') continue
    // Сервис отдаёт ОСТАТОК, а показываем мы израсходованное: так одинаково читаются и деньги,
    // и кредиты, и токены — «сколько ушло из скольких».
    const used = Math.max(0, limit - remaining)
    out.push({
      scope,
      label,
      ratio: limit > 0 ? used / limit : null,
      used,
      limit,
      unit,
      resetsAt: ms(d.billingPeriodEnd)
    })
  }
  return out
}

/** Tavily: план аккаунта и израсходованное из лимита плана (а не из лимита одного ключа). */
export function parseTavily(data: unknown): QuotaSlice[] {
  const acc = (data as { account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } })?.account
  if (!acc || typeof acc.plan_usage !== 'number') return []
  const limit = typeof acc.plan_limit === 'number' ? acc.plan_limit : null
  return [
    {
      scope: 'period',
      label: 'Кредиты',
      ratio: limit && limit > 0 ? acc.plan_usage / limit : null,
      used: acc.plan_usage,
      limit,
      unit: 'кредитов',
      plan: acc.current_plan ?? null
    }
  ]
}

// --- Кто чем спрашивается -----------------------------------------------------------------------

/** Как у этого доступа добывается квота. null — сервис её не публикует. */
export type QuotaKind = 'anthropic' | 'cursor' | 'openrouter' | 'firecrawl' | 'tavily'

/**
 * Опознать способ.
 *
 * По провайдеру, а где его не хватает — по названию: Cursor заведён как `other`, потому что своей
 * семьёй провайдеров он не является, а квоту отдаёт вполне конкретную.
 */
export function quotaKindOf(access: Pick<AiAccess, 'provider' | 'label'>): QuotaKind | null {
  const p = access.provider.toLowerCase()
  if (p === 'anthropic') return 'anthropic'
  if (p === 'openrouter') return 'openrouter'
  if (p === 'firecrawl') return 'firecrawl'
  if (p === 'tavily') return 'tavily'
  if (/cursor/i.test(access.label)) return 'cursor'
  return null
}

/** Квота спрашивается кукой браузера, а не ключом: у подписок ключа не бывает. */
export function needsBrowser(kind: QuotaKind): boolean {
  return kind === 'anthropic' || kind === 'cursor'
}

export interface QuotaResult {
  slices: QuotaSlice[]
  /** Чем добыли — это разное качество доступа, и владельцу его видно. */
  via: 'key' | 'browser'
  /** Почему пусто, если пусто. */
  problem?: 'no-key' | 'no-session' | 'refused'
}

/**
 * Спросить квоту у провайдера.
 *
 * Пустой список означает «сервис квоту не публикует» либо «доступа к ней сейчас нет» — это не
 * ошибка и не повод показывать ноль.
 */
export async function fetchQuota(
  access: AiAccess,
  apiKey: string | null,
  cookies: (domain: string, names: string[]) => Record<string, string> = readCookies
): Promise<QuotaResult> {
  const kind = quotaKindOf(access)
  if (!kind) return { slices: [], via: 'key' }

  if (kind === 'anthropic') {
    // Организация лежит в самой куке — отдельный запрос за ней не нужен.
    const jar = cookies('claude.ai', ['sessionKey', 'lastActiveOrg'])
    const org = (jar.lastActiveOrg ?? '').replace(/"/g, '')
    if (!jar.sessionKey || !org) return { slices: [], via: 'browser', problem: 'no-session' }
    const data = await getJson(`https://claude.ai/api/organizations/${org}/usage`, {
      cookie: cookieHeader(jar),
      'user-agent': UA
    })
    const slices = parseAnthropicUsage(data)
    return { slices, via: 'browser', problem: slices.length ? undefined : 'refused' }
  }

  if (kind === 'cursor') {
    const jar = cookies('cursor.com', ['WorkosCursorSessionToken'])
    if (!jar.WorkosCursorSessionToken) return { slices: [], via: 'browser', problem: 'no-session' }
    const data = await getJson('https://cursor.com/api/usage-summary', {
      cookie: cookieHeader(jar),
      'user-agent': UA
    })
    const slices = parseCursorUsage(data)
    return { slices, via: 'browser', problem: slices.length ? undefined : 'refused' }
  }

  if (!apiKey) return { slices: [], via: 'key', problem: 'no-key' }
  const auth = { Authorization: `Bearer ${apiKey}` }

  if (kind === 'openrouter') {
    const slices = parseOpenRouterCredits(await getJson('https://openrouter.ai/api/v1/credits', auth))
    return { slices, via: 'key', problem: slices.length ? undefined : 'refused' }
  }

  if (kind === 'firecrawl') {
    const [credits, tokens] = await Promise.all([
      getJson('https://api.firecrawl.dev/v2/team/credit-usage', auth),
      getJson('https://api.firecrawl.dev/v2/team/token-usage', auth)
    ])
    const slices = parseFirecrawl(credits, tokens)
    return { slices, via: 'key', problem: slices.length ? undefined : 'refused' }
  }

  const slices = parseTavily(await getJson('https://api.tavily.com/usage', auth))
  return { slices, via: 'key', problem: slices.length ? undefined : 'refused' }
}
