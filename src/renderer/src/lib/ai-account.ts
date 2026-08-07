import type { AiAccess, AiAccountEntry, AiCheck, AiKind, AiPrice, AiUsageDay, Subscription } from '@/types'
import { costOf, perMillion, type Rates, type TokenUsage } from '../../../shared/ai-pricing'
import { providerFamily } from '../../../shared/ai-providers'
import { CREDIT_WARNING_USD, KEY_EXPIRY_WARNING_DAYS } from '../../../shared/ai-thresholds'
import { daysUntilCalendar } from '../../../shared/billing'

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
    // Знаменатель — ПРОВЕРЕННЫЕ ключи, а не все существующие: пока проверка не прошла, вердикта
    // нет, и записывать такой ключ в «рабочие» или «сломанные» одинаково неправильно.
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

/**
 * Группы по экономике, а не по технике.
 *
 * Владелец думает не «роутер это или ключ», а «за что плачу, где кончается баланс, что бесплатно
 * и что ещё не взял». Прежняя разбивка по типу записи рассыпала один провайдер по трём полкам:
 * подписка ChatGPT в «Подписках», Codex в «Роутерах», ключ в «API-ключах».
 */
export type MoneyGroup = 'paid' | 'balance' | 'free' | 'available'

export const MONEY_GROUP_LABEL: Record<MoneyGroup, string> = {
  paid: 'Плачу',
  balance: 'Балансы',
  free: 'Бесплатные',
  available: 'Можно взять'
}

export function moneyGroupOf(access: AiAccess, subs: Subscription[]): MoneyGroup {
  // «Ещё не взял» важнее всего остального: у такой записи нет ни денег, ни ключа, и мешать её
  // с рабочими доступами — значит выдавать список дел за инвентарь.
  if (access.status === 'planned') return 'available'
  const sub = subs.find((s) => s.id === access.subscriptionId)
  if (sub) return 'paid'
  if (access.payment === 'free' || access.kind === 'local' || access.kind === 'free-tier') return 'free'
  return 'balance'
}

const MONEY_ORDER: MoneyGroup[] = ['paid', 'balance', 'free', 'available']

export function groupByMoney(
  access: AiAccess[],
  subs: Subscription[]
): Array<{ group: MoneyGroup; items: AiAccess[] }> {
  return MONEY_ORDER.map((group) => ({
    group,
    items: access.filter((a) => moneyGroupOf(a, subs) === group)
  })).filter((g) => g.items.length > 0)
}

/** Аккаунт вместе с записью, в которой лежат его учётные данные. */
export interface FamilyAccount {
  account: AiAccountEntry
  accessId: string
  accessLabel: string
}

/**
 * Все аккаунты СЕМЬИ провайдера, а не одной записи.
 *
 * У владельца доступ к OpenAI идёт тремя путями сразу — подписка ChatGPT, Codex через сторонний
 * роутер и ключ API, — но почты у них одни и те же. Открыв любую из этих записей, он должен
 * видеть весь список, а не ту его часть, которая случайно попала именно сюда.
 */
export function familyAccounts(access: AiAccess, all: AiAccess[]): FamilyAccount[] {
  const family = providerFamily(access.provider)
  const out: FamilyAccount[] = []
  const seen = new Set<string>()
  // Своя запись идёт первой: её аккаунты важнее одноимённых из соседних.
  for (const a of [access, ...all.filter((x) => x.id !== access.id)]) {
    if (providerFamily(a.provider) !== family) continue
    for (const account of a.accounts) {
      const key = account.email.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ account, accessId: a.id, accessLabel: a.label })
    }
  }
  return out
}

/**
 * Кому принадлежит расход инструмента.
 *
 * Логи Claude Code и Codex знают, каким инструментом сожжены токены, но не знают, на какой
 * доступ он смотрел. Раньше это решалось эвристикой прямо в компоненте — и один и тот же расход
 * показывался как свой у КАЖДОЙ записи провайдера: у подписки Claude, у ключа Anthropic, у
 * второго ключа. Цифра выглядела достоверной и была неправдой.
 *
 * Теперь источник достаётся ровно одной записи. Побеждает та, что явно названа в `usedBy`, —
 * это утверждение владельца. Если таких нет, берётся самая старая запись подходящего провайдера:
 * произвольный, но устойчивый выбор, который не скачет между запусками.
 */
export function usageOwners(access: AiAccess[]): Map<string, string> {
  const owners = new Map<string, string>()
  const claim = (source: string, id: string): void => {
    if (!owners.has(source)) owners.set(source, id)
  }

  const named = (tool: string): AiAccess[] =>
    access.filter((a) => a.usedBy.some((u) => u.toLowerCase().includes(tool)))

  for (const a of named('claude code')) claim('claude-code', a.id)
  for (const a of named('codex')) claim('codex', a.id)

  // При равных датах порядок решает идентификатор: сортировка по одному полю оставляет
  // элементы в порядке прихода, и владелец расхода менялся бы от запуска к запуску.
  const byAge = [...access].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))
  for (const a of byAge) {
    if (providerFamily(a.provider) === 'anthropic') claim('claude-code', a.id)
    if (providerFamily(a.provider) === 'openai') claim('codex', a.id)
  }
  return owners
}

/** Источник логов этой записи или null, если расход принадлежит другой. */
export function sourceFor(access: AiAccess, all: AiAccess[]): string | null {
  for (const [source, id] of usageOwners(all)) if (id === access.id) return source
  return null
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
 * Перевод в доллары и пометка приблизительности — из общей таблицы курсов (src/shared/fx.ts).
 *
 * Нужны здесь потому, что расход по логам считается в долларах (цены провайдеров долларовые),
 * а подписка может быть в евро: делить одно на другое без перевода — получить красивое число,
 * которое ничего не значит. Своя таблица тут была короче общей на половину валют, и окупаемость
 * подписки, скажем, в JPY показывалась как «не знаю» при посчитанном итоге на экране подписок.
 * Семантика «неизвестная валюта → null» описана у самой функции: соврать курсом хуже, чем
 * не показать.
 */
export { FX_IS_APPROXIMATE, toUsd } from '../../../shared/fx'

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

/**
 * Через сколько дней истекает ключ. null — даты нет или она не разбирается.
 *
 * Считает та же функция, что и у сторожа. Своя реализация здесь расходилась с ней на день в
 * поясах западнее UTC: `Date.parse('2026-08-20')` даёт UTC-полночь, а `setHours(0,0,0,0)`
 * откатывает её на предыдущий локальный день. В Нью-Йорке экран показывал 14 дней там, где
 * сторож видел 15, — ровно на пороге предупреждения. Обе цифры выглядят осмысленно, и именно
 * поэтому расхождение опасно: уведомление уже горит, а экран ещё говорит «всё в порядке».
 */
export function daysUntilExpiry(iso: string | null, now = Date.now()): number | null {
  return iso ? daysUntilCalendar(iso, now) : null
}

export interface Attention {
  accessId: string
  /** Готовая фраза: объект, факт и что делать. Её и показываем — считать заново не нужно. */
  text: string
  severity: 'warning' | 'critical'
}


/** Ниже этого остатка доступ считается почти исчерпанным — тот же порог, что у сторожа:
 *  теперь буквально та же константа (src/shared/ai-thresholds.ts), а не два числа,
 *  совпадающие на честном слове. */
export const LOW_CREDIT_USD = CREDIT_WARNING_USD

/** Записи, требующие внимания: ключ умер, скоро истечёт или бесплатный доступ так и не взят. */
export function needsAttention(
  access: AiAccess[],
  checks: Record<string, AiCheck>,
  now = Date.now()
): AiAccess[] {
  return access.filter((a) => {
    if (a.status === 'expired') return true
    const days = daysUntilExpiry(a.keyExpiresAt, now)
    if (days !== null && days <= KEY_EXPIRY_WARNING_DAYS) return true
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
