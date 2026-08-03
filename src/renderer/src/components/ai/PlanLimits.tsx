import { cn } from '@/lib/cn'
import { useAi } from '@/store/ai'
import { daysAgoDate, totalsFor } from '@/lib/ai-account'
import { DEFAULT_WINDOW_HOURS, formatResetIn, windowState } from '../../../../shared/ai-blocks'
import { totalTokens } from '../../../../shared/ai-pricing'
import type { AiAccess, AiUsageBlock, AiUsageDay } from '@/types'

/** Токены человеческим числом: «10.4M» читается, «10 428 913» — нет. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Одна строка лимита: слева что и когда обновится, посередине полоса, справа доля.
 *
 * Доля показывается ТОЛЬКО от заданного потолка. Провайдеры своих порогов не публикуют, и
 * «66 % израсходовано» без известного знаменателя было бы выдумкой; пока потолка нет, справа
 * стоит абсолютный расход, а полоса отмеряет прошедшее время периода.
 */
function LimitRow({
  title,
  caption,
  used,
  spent,
  limit,
  elapsed,
  onAdopt,
  peak
}: {
  title: string
  caption: string
  used: number | null
  spent: number
  limit: number | null
  elapsed: number
  onAdopt?: () => void
  peak?: number
}): React.JSX.Element {
  const byLimit = used != null
  const fill = Math.min(1, byLimit ? used : elapsed)
  const over = byLimit && used > 1
  const nearing = byLimit && used >= 0.8

  return (
    <div className="py-2">
      <div className="flex items-center gap-3">
        <div className="w-[8.5rem] shrink-0">
          <div className="text-[12px] text-slate-300">{title}</div>
          <div className="mt-0.5 text-[11px] text-slate-600">{caption}</div>
        </div>

        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              over ? 'bg-rose-500' : nearing ? 'bg-amber-400' : byLimit ? 'bg-accent' : 'bg-slate-600'
            )}
            style={{ width: `${Math.max(2, fill * 100)}%` }}
          />
        </div>

        <div className="w-[5.5rem] shrink-0 text-right">
          <div className={cn('text-[12px] font-medium tabular-nums', over ? 'text-rose-400' : 'text-slate-200')}>
            {byLimit ? `${Math.round(used * 100)}%` : tokens(spent)}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-600">
            {byLimit ? `из ${tokens(limit ?? 0)}` : 'потолок не задан'}
          </div>
        </div>
      </div>

      {/* Потолок провайдер не публикует, но его видно по своей же истории: самый нагруженный
          период — это как минимум столько, сколько лимит позволяет. Предлагаем цифру, а не
          подставляем молча: она оценка, и владелец должен её признать. */}
      {!byLimit && onAdopt && peak != null && peak > 0 && (
        <button
          onClick={onAdopt}
          className="mt-1.5 w-full rounded border border-dashed border-border py-1 text-[11px] text-slate-600 transition-colors hover:border-accent/40 hover:text-slate-300"
        >
          Взять потолок из наблюдений — {tokens(peak)}
        </button>
      )}
    </div>
  )
}

/**
 * Лимиты тарифа: окно сессии и неделя.
 *
 * Показывается всем, у кого есть свои логи расхода. Длительность окна берётся из записи, а
 * если её не задавали — пять часов: так отмеряют квоту и Anthropic, и OpenAI, и это ближе к
 * правде, чем не показать ничего.
 */
export function PlanLimits({
  access,
  blocks,
  days,
  source,
  now = Date.now()
}: {
  access: AiAccess
  blocks: AiUsageBlock[]
  days: AiUsageDay[]
  source: string
  now?: number
}): React.JSX.Element | null {
  const update = useAi((s) => s.update)

  const mine = blocks.filter((b) => b.source === source)
  const hours = access.limits.windowHours ?? DEFAULT_WINDOW_HOURS
  const state = windowState(mine, access.limits.windowTokens, now)
  const sessionPeak = mine.reduce((max, b) => Math.max(max, b.tokens), 0)

  const week = totalsFor(days, { since: daysAgoDate(6), source })
  const weekTokens = totalTokens(week.usage)
  const weekLimit = access.limits.weekTokens ?? null

  // Недельный пик — по завершённым неделям истории. Считается грубо: максимум суточного
  // расхода × 7 занизил бы редкие всплески, поэтому берём саму неделю целиком.
  const weekPeak = (() => {
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

  const adopt = (patch: { windowTokens?: number; weekTokens?: number }): void => {
    void update(access.id, { provider: access.provider, limits: { ...access.limits, ...patch } })
  }

  if (mine.length === 0 && weekTokens === 0) return null

  return (
    <section className="rounded border border-border/70 bg-bg/40 px-3 py-1.5">
      <h3 className="flex items-baseline gap-2 pb-0.5 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Лимиты тарифа</span>
        {access.plan && <span className="truncate text-[11px] text-slate-600">{access.plan}</span>}
      </h3>

      {state ? (
        <LimitRow
          title="Текущая сессия"
          caption={`Сбросится ${formatResetIn(state.resetsInMs)}`}
          used={state.used}
          spent={state.block.tokens}
          limit={access.limits.windowTokens ?? null}
          elapsed={state.elapsed}
          peak={sessionPeak}
          onAdopt={() => adopt({ windowTokens: Math.round(sessionPeak) })}
        />
      ) : (
        <div className="flex items-baseline justify-between gap-3 py-2">
          <span className="text-[12px] text-slate-500">Сессия не начата</span>
          <span className="text-[11px] text-slate-600">окно {hours} ч с первого запроса</span>
        </div>
      )}

      <div className="border-t border-border/50">
        <LimitRow
          title="Эта неделя"
          caption="Последние 7 дней"
          used={weekLimit && weekLimit > 0 ? weekTokens / weekLimit : null}
          spent={weekTokens}
          limit={weekLimit}
          // Полоса без потолка отмеряет, сколько недели прошло — по дню недели, не по расходу.
          elapsed={(new Date(now).getDay() || 7) / 7}
          peak={weekPeak}
          onAdopt={() => adopt({ weekTokens: Math.round(weekPeak) })}
        />
      </div>
    </section>
  )
}
