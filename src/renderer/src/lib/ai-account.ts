import type { AiAccess, AiCheck, AiKind, AiPrice, AiUsageDay, Subscription } from '@/types'
import { costOf, perMillion, type Rates, type TokenUsage } from '../../../shared/ai-pricing'

export interface AiSummary {
  /** null = ещё нет достаточных данных, строка = подтверждённые / проверенные ключи. */
  workingKeys: string | null
  /** null = общий остаток неизвестен хотя бы для одного сохранённого OpenRouter-ключа. */
  totalCredit: number | null
}

export function aiSummary(access: AiAccess[], checks: Record<string, AiCheck>): AiSummary {
  const checked = access.filter((a) => {
    if (!a.hasKey) return false
    const status = checks[a.id]?.status
    return status === 'valid' || status === 'invalid' || status === 'quota'
  })
  const working = checked.filter((a) => {
    const status = checks[a.id]?.status
    return status === 'valid' || status === 'quota'
  }).length

  const creditAccounts = access.filter((a) => a.hasKey && a.provider.toLowerCase().includes('openrouter'))
  const knownCredit = creditAccounts.map((a) => checks[a.id]?.remaining)
  const totalCredit =
    knownCredit.length > 0 && knownCredit.every((value): value is number => typeof value === 'number')
      ? knownCredit.reduce((sum, value) => sum + value, 0)
      : null

  return {
    workingKeys: checked.length > 0 ? `${working}/${checked.length}` : null,
    totalCredit
  }
}

export function providerChangeError(current: string, next: string, newKey: string): string | null {
  if (current !== next && !newKey.trim()) return 'При смене провайдера введи ключ для нового сервиса'
  return null
}

// --- Группировка реестра ---------------------------------------------------------------------

export const KIND_ORDER: AiKind[] = ['subscription', 'api', 'router', 'free-tier', 'local', 'cli-agent']

/** Заголовок группы в списке — множественное число. */
export const KIND_LABEL: Record<AiKind, string> = {
  subscription: 'Подписки',
  api: 'API-ключи',
  router: 'Роутеры и реселлеры',
  'free-tier': 'Бесплатные тарифы',
  local: 'Локальные',
  'cli-agent': 'CLI-агенты'
}

/** Название типа для ОДНОЙ записи. «anthropic · подписки» читается как ошибка, и это она и есть. */
export const KIND_ONE: Record<AiKind, string> = {
  subscription: 'подписка',
  api: 'API-ключ',
  router: 'роутер',
  'free-tier': 'бесплатный тариф',
  local: 'локальный',
  'cli-agent': 'CLI-агент'
}

export const STATUS_LABEL: Record<AiAccess['status'], string> = {
  active: 'активен',
  paused: 'на паузе',
  expired: 'истёк',
  planned: 'не оформлен'
}

export const PAYMENT_LABEL: Record<AiAccess['payment'], string> = {
  card: 'карта',
  crypto: 'крипто',
  reseller: 'реселлер',
  free: 'бесплатно'
}

/** Разложить реестр по типам в фиксированном порядке. Пустые группы не возвращаются. */
export function groupByKind(access: AiAccess[]): Array<{ kind: AiKind; items: AiAccess[] }> {
  return KIND_ORDER.map((kind) => ({ kind, items: access.filter((a) => a.kind === kind) })).filter(
    (g) => g.items.length > 0
  )
}

// --- Расход ------------------------------------------------------------------------------------

/** Сколько дней назад была дата (по календарным суткам). */
export function daysAgoDate(days: number, now = Date.now()): string {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface UsageTotals {
  usage: TokenUsage
  costUsd: number
  requests: number
  /** Сколько дней с ненулевым расходом попало в период. */
  activeDays: number
}

export function totalsFor(days: AiUsageDay[], opts?: { since?: string; source?: string; model?: string }): UsageTotals {
  const dates = new Set<string>()
  const out: UsageTotals = {
    usage: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
    costUsd: 0,
    requests: 0,
    activeDays: 0
  }
  for (const d of days) {
    if (opts?.since && d.date < opts.since) continue
    if (opts?.source && d.source !== opts.source) continue
    if (opts?.model && d.model !== opts.model) continue
    out.usage.input += d.input
    out.usage.output += d.output
    out.usage.cacheWrite += d.cacheWrite
    out.usage.cacheWrite1h += d.cacheWrite1h
    out.usage.cacheRead += d.cacheRead
    out.costUsd += d.costUsd
    out.requests += d.requests
    dates.add(d.date)
  }
  out.activeDays = dates.size
  return out
}

/** Ряд «доллары по дням» для спарклайна: без пропусков, чтобы линия не врала про плотность. */
export function dailySeries(days: AiUsageDay[], span: number, now = Date.now()): number[] {
  const byDate = new Map<string, number>()
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.costUsd)
  const out: number[] = []
  for (let i = span - 1; i >= 0; i--) out.push(byDate.get(daysAgoDate(i, now)) ?? 0)
  return out
}

/** Расход по моделям за период, от дорогих к дешёвым. */
export function byModel(
  days: AiUsageDay[],
  since?: string
): Array<{ model: string; source: string; costUsd: number; tokens: number; requests: number }> {
  const acc = new Map<string, { model: string; source: string; costUsd: number; tokens: number; requests: number }>()
  for (const d of days) {
    if (since && d.date < since) continue
    const key = `${d.source}|${d.model}`
    const row = acc.get(key) ?? { model: d.model, source: d.source, costUsd: 0, tokens: 0, requests: 0 }
    row.costUsd += d.costUsd
    row.tokens += d.input + d.output + d.cacheWrite + d.cacheWrite1h + d.cacheRead
    row.requests += d.requests
    acc.set(key, row)
  }
  return [...acc.values()].sort((a, b) => b.costUsd - a.costUsd)
}

/**
 * Месячная стоимость подписки в долларах.
 *
 * Годовая делится на 12: сравнивать «$200 в месяц» с «$2000 в год» иначе бессмысленно.
 * Курс валют здесь не считается — за него отвечает финансовый модуль, а тут важно не соврать
 * порядком величины, поэтому не-долларовые суммы возвращаются как есть с пометкой у вызывающего.
 */
export function monthlyCost(sub: Subscription | undefined): number | null {
  if (!sub) return null
  return sub.period === 'yr' ? sub.amount / 12 : sub.amount
}

/**
 * Приблизительные курсы к доллару — те же, что в хранилище.
 *
 * Нужны в одном месте: расход по логам считается в долларах (цены провайдеров долларовые), а
 * подписка может быть в евро. Делить одно на другое без перевода — получить красивое число,
 * которое ничего не значит.
 */
const FX_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  RUB: 0.0126,
  GBP: 1.27,
  CNY: 0.14,
  CHF: 1.11,
  PLN: 0.25,
  KZT: 0.0021,
  TRY: 0.029
}

/** Сумма в долларах. Неизвестная валюта — null: соврать курсом хуже, чем не показать. */
export function toUsd(amount: number, currency: string): number | null {
  const rate = FX_TO_USD[currency]
  return rate == null ? null : amount * rate
}

/**
 * Окупаемость подписки: во сколько раз эквивалент по API-ценам больше абонентской платы.
 *
 * Возвращает null, если считать не из чего. Это ВАЖНО: «×0» и «не знаю» — разные ответы,
 * а подписка без единого запроса в логах чаще означает, что логи ещё не прочитаны.
 */
export function subscriptionRoi(equivalentUsd: number, monthlyUsd: number | null): number | null {
  if (!monthlyUsd || monthlyUsd <= 0) return null
  if (equivalentUsd <= 0) return null
  return equivalentUsd / monthlyUsd
}

// --- Ключи -------------------------------------------------------------------------------------

/** Через сколько дней истекает ключ. null — даты нет или она не разбирается. */
export function daysUntilExpiry(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const day = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const target = new Date(t)
  target.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - startOfToday.getTime()) / day)
}

/** Записи, требующие внимания: ключ умер, скоро истечёт или бесплатный доступ так и не взят. */
/** Ниже этого остатка доступ считается почти исчерпанным — тот же порог, что у сторожа. */
export const LOW_CREDIT_USD = 5

export function needsAttention(
  access: AiAccess[],
  checks: Record<string, AiCheck>,
  now = Date.now()
): AiAccess[] {
  return access.filter((a) => {
    if (a.status === 'expired') return true
    const days = daysUntilExpiry(a.keyExpiresAt, now)
    if (days !== null && days <= 14) return true
    const check = checks[a.id]
    // Кончающийся баланс — то же «требует внимания»: без него экран показывал ноль проблем,
    // пока строка рядом честно горела предупреждением об остатке в двадцать центов.
    if (typeof check?.remaining === 'number' && check.remaining <= LOW_CREDIT_USD) return true
    return check?.status === 'invalid'
  })
}

// --- Цены --------------------------------------------------------------------------------------

export function ratesOf(price: AiPrice): Rates {
  return {
    input: price.input,
    output: price.output,
    cacheWrite: price.cacheWrite,
    cacheWrite1h: price.cacheWrite1h,
    cacheRead: price.cacheRead
  }
}

/** Цена «за миллион» в виде строки. null-ставка честно показывается прочерком, а не нулём. */
export function priceLabel(rate: number | null): string {
  const perM = perMillion(rate)
  if (perM == null) return '—'
  if (perM === 0) return '$0'
  if (perM < 0.01) return `$${perM.toFixed(4)}`
  if (perM < 1) return `$${perM.toFixed(3)}`
  return `$${perM.toFixed(2)}`
}

export interface CalculatorRow {
  provider: string
  model: string
  costUsd: number
  contextTokens: number | null
}

/** Во сколько обойдётся заданный объём у каждой модели. Модели без цены входа/выхода отброшены. */
export function calculate(prices: AiPrice[], usage: TokenUsage, limit = 40): CalculatorRow[] {
  return prices
    .filter((p) => p.input != null || p.output != null)
    .map((p) => ({
      provider: p.provider,
      model: p.model,
      costUsd: costOf(usage, ratesOf(p)),
      contextTokens: p.contextTokens
    }))
    .sort((a, b) => a.costUsd - b.costUsd)
    .slice(0, limit)
}
