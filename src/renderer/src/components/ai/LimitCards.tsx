import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { daysAgoDate, totalsFor } from '@/lib/ai-account'
import { DEFAULT_WINDOW_HOURS, formatResetIn, windowState } from '../../../../shared/ai-blocks'
import { totalTokens } from '../../../../shared/ai-pricing'
import type { AiAccess, AiCheck, AiQuota, AiUsageBlock, AiUsageDay } from '@/types'

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Одна плашка лимита.
 *
 * Устроена так же, как её показывают сами провайдеры: слева что это и когда обновится, справа
 * доля, между ними полоса. Доля берётся только от известного потолка — провайдеры своих порогов
 * не публикуют, и процент без знаменателя был бы выдумкой.
 */
function LimitCard({
  title,
  caption,
  spent,
  limit,
  elapsed,
  unit = 'токенов',
  peak
}: {
  title: string
  caption: string
  spent: number
  limit: number | null
  /** Доля прошедшего времени периода — полоса, когда мерить не от чего. */
  elapsed: number
  unit?: string
  /** Самый нагруженный такой же период в истории. */
  peak?: number
}): React.JSX.Element {
  // Потолок владельца — это факт, наблюдаемый максимум — оценка. Считаем от того, что есть:
  // ждать, пока человек нажмёт кнопку, чтобы увидеть проценты, незачем — данные для оценки
  // лежат в его же истории. Но оценку положено называть оценкой.
  const own = limit && limit > 0 ? limit : null
  const observed = !own && peak && peak > 0 ? peak : null
  const scale = own ?? observed
  const used = scale ? spent / scale : null

  const byLimit = used != null
  const fill = Math.min(1, byLimit ? used : elapsed)
  const over = byLimit && used > 1
  const nearing = byLimit && used >= 0.8

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-200">{title}</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', over ? 'text-rose-400' : 'text-white')}>
          {byLimit ? `${observed ? '≈' : ''}${Math.round(used * 100)}%` : tokens(spent)}
        </span>
      </div>

      {/* Без известного потолка полоса отмеряет ВРЕМЯ периода, а не долю квоты. Чтобы её не
          читали как заполнение лимита, она рисуется штриховкой и приглушённо. */}
      {/* Сплошная полоса — доля известного потолка. Приглушённая — доля наблюдаемого максимума,
          то есть оценка. Штриховая — вообще не про расход, а про прошедшее время периода. */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700',
            over ? 'bg-rose-500' : nearing ? 'bg-amber-400' : own ? 'bg-accent' : observed ? 'bg-accent/50' : 'bg-slate-700'
          )}
          style={{
            width: `${Math.max(2, fill * 100)}%`,
            ...(byLimit
              ? {}
              : {
                  backgroundImage:
                    'repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 3px, transparent 3px 6px)'
                })
          }}
        />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-600">
        <span>{caption}</span>
        <span className="tabular-nums">
          {own
            ? `${tokens(spent)} из ${tokens(own)}`
            : observed
              ? `${tokens(spent)} из ${tokens(observed)} — наблюдаемый максимум`
              : `${unit} · полоса — прошедшее время`}
        </span>
      </div>

    </div>
  )
}

/** Плашка денег для доступов, где провайдер отдаёт баланс (сейчас это OpenRouter). */
function BalanceCard({ check }: { check: AiCheck }): React.JSX.Element {
  const remaining = check.remaining ?? 0
  const spent = check.usage ?? 0
  const total = remaining + spent
  const left = total > 0 ? remaining / total : 0
  const low = remaining <= 5

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-200">Баланс</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', low ? 'text-amber-400' : 'text-white')}>
          {money(remaining)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn('h-full rounded-full', low ? 'bg-amber-400' : 'bg-accent')}
          style={{ width: `${Math.max(2, left * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-600">
        <span>{low ? 'почти исчерпан' : 'осталось'}</span>
        <span className="tabular-nums">потрачено {money(Math.round(spent * 100) / 100)}</span>
      </div>
    </div>
  )
}

/** Квота бесплатного тарифа: предел есть, просто считается не деньгами, а кредитами. */
function QuotaCard({ quota }: { quota: AiQuota }): React.JSX.Element {
  const used = quota.limit && quota.limit > 0 ? quota.used / quota.limit : null
  const low = used != null && used >= 0.8

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-200">Квота{quota.plan ? ` · ${quota.plan}` : ''}</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', low ? 'text-amber-400' : 'text-white')}>
          {used != null ? `${Math.round(used * 100)}%` : quota.used.toLocaleString('ru-RU')}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn('h-full rounded-full', low ? 'bg-amber-400' : 'bg-accent')}
          style={{ width: `${Math.max(2, Math.min(1, used ?? 0) * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-600">
        <span>
          {quota.periodEnd
            ? `обновится ${new Date(quota.periodEnd).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
            : 'за расчётный период'}
        </span>
        <span className="tabular-nums">
          {quota.used.toLocaleString('ru-RU')}
          {quota.limit ? ` из ${quota.limit.toLocaleString('ru-RU')}` : ''} {quota.unit}
        </span>
      </div>
    </div>
  )
}

/**
 * Лимиты доступа: окно сессии, сутки и неделя — ровно те периоды, которыми считают провайдеры.
 *
 * Для доступов без своих логов расхода показывается то, что известно: баланс, если провайдер его
 * отдаёт, и объявленные лимиты запросов.
 */
export function LimitCards({
  access,
  blocks,
  days,
  source,
  check,
  quota,
  now = Date.now()
}: {
  access: AiAccess
  blocks: AiUsageBlock[]
  days: AiUsageDay[]
  /** Источник логов расхода или null, если своих логов у доступа нет. */
  source: string | null
  check?: AiCheck
  quota?: AiQuota
  now?: number
}): React.JSX.Element | null {
  const mine = source ? blocks.filter((b) => b.source === source) : []
  const state = source ? windowState(mine, access.limits.windowTokens, now) : null
  const sessionPeak = mine.reduce((max, b) => Math.max(max, b.tokens), 0)

  const today = source ? totalsFor(days, { since: daysAgoDate(0), source }) : null
  const week = source ? totalsFor(days, { since: daysAgoDate(6), source }) : null
  const todayTokens = today ? totalTokens(today.usage) : 0
  const weekTokens = week ? totalTokens(week.usage) : 0

  // Пик недели — по скользящим неделям истории: разовый всплеск важнее среднего, потому что
  // лимит бьёт именно по нему.
  const weekPeak = (() => {
    if (!source) return 0
    let max = 0
    for (let offset = 0; offset < 8; offset++) {
      const since = daysAgoDate(6 + offset * 7)
      const until = daysAgoDate(offset * 7)
      const sum = days
        .filter((d) => d.source === source && d.date >= since && d.date <= until)
        .reduce((n, d) => n + d.input + d.output + d.cacheWrite + d.cacheWrite1h + d.cacheRead, 0)
      max = Math.max(max, sum)
    }
    return max
  })()

  const dayPeak = (() => {
    if (!source) return 0
    const byDate = new Map<string, number>()
    for (const d of days) {
      if (d.source !== source) continue
      byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.input + d.output + d.cacheWrite + d.cacheWrite1h + d.cacheRead)
    }
    return Math.max(0, ...byDate.values())
  })()


  const hasBalance = typeof check?.remaining === 'number'
  // Объявленные лимиты тарифа — тоже повод показать блок: у бесплатного доступа это всё, что
  // о нём известно, и прятать их значит оставлять такие записи вовсе без лимитов.
  const declared = access.limits.rpd != null || access.limits.rpm != null || access.limits.tpmo != null
  if (!source && !hasBalance && !quota && !declared) return null

  const hours = access.limits.windowHours ?? DEFAULT_WINDOW_HOURS
  const nowDate = new Date(now)
  const dayElapsed = (nowDate.getHours() * 60 + nowDate.getMinutes()) / (24 * 60)

  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Лимиты</span>
        {access.plan && <span className="truncate text-[11px] text-slate-600">{access.plan}</span>}
      </h3>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {hasBalance && check && <BalanceCard check={check} />}
        {quota && <QuotaCard quota={quota} />}

        {source && (
          <>
            {state ? (
              <LimitCard
                title="Текущая сессия"
                caption={`сбросится ${formatResetIn(state.resetsInMs)}`}
                spent={state.block.tokens}
                limit={access.limits.windowTokens ?? null}
                elapsed={state.elapsed}
                peak={sessionPeak}
              />
            ) : (
              <div className="rounded-lg border border-border bg-card/50 p-3.5">
                <div className="text-[12px] font-medium text-slate-200">Текущая сессия</div>
                <p className="mt-2 text-[11px] text-slate-600">
                  не начата — окно {hours} ч открывается с первого запроса
                </p>
              </div>
            )}

            <LimitCard
              title="Сегодня"
              caption="с начала суток"
              spent={todayTokens}
              limit={access.limits.tpd ?? null}
              elapsed={dayElapsed}
              peak={dayPeak}
            />

            <LimitCard
              title="Последние 7 дней"
              caption="скользящее окно"
              spent={weekTokens}
              limit={access.limits.weekTokens ?? null}
              // Окно скользящее, поэтому «прошедшего времени» у него нет: показываем полную
              // полосу. Раньше здесь стоял день календарной недели — расход считался за одно,
              // а полоса рисовалась про другое.
              elapsed={1}
              peak={weekPeak}
            />
          </>
        )}
      </div>

      {(access.limits.rpm != null || access.limits.rpd != null || access.limits.rpmo != null || access.limits.tpmo != null) && (
        <p className="mt-2 text-[11px] text-slate-600">
          {/* Это условия тарифа, а не измерение: провайдер их объявил, но сколько израсходовано,
              по ним не узнать. Подписываем отдельно, чтобы не путались с посчитанным расходом. */}
          По условиям тарифа:{' '}
          {[
            access.limits.rpm != null ? `${access.limits.rpm} запросов в минуту` : null,
            access.limits.rpd != null ? `${access.limits.rpd.toLocaleString('ru-RU')} запросов в сутки` : null,
            access.limits.rpmo != null ? `${access.limits.rpmo.toLocaleString('ru-RU')} запросов в месяц` : null,
            access.limits.tpmo != null ? `${(access.limits.tpmo / 1_000_000).toFixed(0)}M токенов в месяц` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </section>
  )
}
