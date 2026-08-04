// Квоты бесплатных тарифов.
//
// У бесплатного доступа тоже есть предел — просто считается он не деньгами, а кредитами или
// запросами, и лежит в отдельном месте у каждого сервиса. Firecrawl отдаёт остаток кредитов и
// границы расчётного периода, Tavily — план и израсходованное из лимита. Это ровно то, чего не
// хватало: у платных доступов был баланс, а у бесплатных не было ничего.
//
// Сервисы, которые квоту не публикуют (Gemini, Exa, ChatGPT), сюда не попадают: их объявленные
// лимиты — справочные, и они хранятся в самой записи, а не выдумываются здесь.

import type { AiAccess } from './types'

const TIMEOUT_MS = 15_000

export interface QuotaInfo {
  /** Сколько израсходовано за текущий период. */
  used: number
  /** Предел периода. null — сервис его не назвал. */
  limit: number | null
  /** В чём считается: кредиты, запросы. */
  unit: string
  /** Название тарифа у провайдера, если он его сообщил. */
  plan?: string
  /** Когда период закончится и счётчик обнулится (мс). */
  periodEnd?: number | null
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers, signal: controller.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Firecrawl: остаток кредитов и границы расчётного периода. */
export function parseFirecrawl(data: unknown): QuotaInfo | null {
  const d = (data as { data?: { remainingCredits?: number; planCredits?: number; billingPeriodEnd?: string } })?.data
  if (!d || typeof d.planCredits !== 'number') return null
  const remaining = typeof d.remainingCredits === 'number' ? d.remainingCredits : 0
  return {
    // Сервис отдаёт ОСТАТОК, а показываем мы израсходованное: так одинаково читаются и деньги,
    // и кредиты, и токены — «сколько ушло из сколько».
    used: Math.max(0, d.planCredits - remaining),
    limit: d.planCredits,
    unit: 'кредитов',
    periodEnd: d.billingPeriodEnd ? Date.parse(d.billingPeriodEnd) || null : null
  }
}

/** Tavily: план аккаунта и израсходованное из лимита плана. */
export function parseTavily(data: unknown): QuotaInfo | null {
  const acc = (data as { account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } })?.account
  if (!acc || typeof acc.plan_usage !== 'number') return null
  return {
    used: acc.plan_usage,
    limit: typeof acc.plan_limit === 'number' ? acc.plan_limit : null,
    unit: 'кредитов',
    plan: acc.current_plan
  }
}

/**
 * Спросить квоту у провайдера.
 *
 * null означает «сервис квоту не публикует» — это не ошибка и не повод показывать ноль.
 */
export async function fetchQuota(access: AiAccess, apiKey: string | null): Promise<QuotaInfo | null> {
  if (!apiKey) return null
  const p = access.provider.toLowerCase()

  if (p === 'firecrawl') {
    const data = await getJson('https://api.firecrawl.dev/v2/team/credit-usage', {
      Authorization: `Bearer ${apiKey}`
    })
    return parseFirecrawl(data)
  }

  if (p === 'tavily') {
    const data = await getJson('https://api.tavily.com/usage', { Authorization: `Bearer ${apiKey}` })
    return parseTavily(data)
  }

  return null
}
