import { cn } from '@/lib/cn'
import { useAi } from '@/store/ai'
import { formatResetIn, windowState } from '../../../../shared/ai-blocks'
import type { AiAccess, AiUsageBlock } from '@/types'

/** Токены человеческим числом: «10.4M» читается, «10 428 913» — нет. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Текущее окно лимита: слева что это и когда сбросится, справа — сколько израсходовано.
 *
 * Полоса заполняется по ДОЛЕ ПОТОЛКА, если владелец его задал. Если нет — по прошедшему
 * времени окна, и подпись говорит про время, а не про проценты: Anthropic своих порогов не
 * публикует, и «57 % израсходовано» без известного знаменателя было бы выдумкой.
 */
export function LimitBar({
  access,
  blocks,
  source,
  now = Date.now()
}: {
  access: AiAccess
  blocks: AiUsageBlock[]
  /** Логи какого инструмента относятся к этому доступу. */
  source: string
  now?: number
}): React.JSX.Element | null {
  const update = useAi((s) => s.update)
  const hours = access.limits.windowHours
  if (!hours) return null

  const mine = blocks.filter((b) => b.source === source)
  const state = windowState(mine, access.limits.windowTokens, now)
  // Самое нагруженное окно в истории — нижняя граница настоящего лимита провайдера.
  const observedPeak = mine.reduce((max, b) => Math.max(max, b.tokens), 0)

  const onAdoptPeak = async (peak: number): Promise<void> => {
    await update(access.id, {
      provider: access.provider,
      limits: { ...access.limits, windowTokens: Math.round(peak) }
    })
  }

  if (!state)
    return (
      <div className="rounded border border-border/70 bg-bg/40 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-slate-400">Сессия не начата</span>
          <span className="text-[11px] text-slate-600">окно {hours} ч с первого запроса</span>
        </div>
      </div>
    )

  const byLimit = state.used != null
  const fill = Math.min(1, byLimit ? (state.used ?? 0) : state.elapsed)
  const over = byLimit && (state.used ?? 0) > 1
  const nearing = byLimit && (state.used ?? 0) >= 0.8

  return (
    <div className="rounded border border-border/70 bg-bg/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 shrink-0">
          <div className="text-[12px] font-medium text-slate-200">Текущая сессия</div>
          <div className="mt-0.5 text-[11px] text-slate-600">Сбросится {formatResetIn(state.resetsInMs)}</div>
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

        <div className="shrink-0 text-right">
          {byLimit ? (
            <div className={cn('text-[12px] font-medium tabular-nums', over ? 'text-rose-400' : 'text-slate-200')}>
              {Math.round((state.used ?? 0) * 100)}%
            </div>
          ) : (
            <div className="text-[12px] font-medium tabular-nums text-slate-200">{tokens(state.block.tokens)}</div>
          )}
          <div className="mt-0.5 text-[11px] text-slate-600">
            {byLimit ? `${tokens(state.block.tokens)} из ${tokens(access.limits.windowTokens ?? 0)}` : 'за сессию'}
          </div>
        </div>
      </div>

      {/* Потолок провайдер не публикует, но его видно по своей же истории: самое нагруженное
          окно — это как минимум столько, сколько лимит позволяет. Предлагаем эту цифру, а не
          подставляем молча: она оценка, и владелец должен её признать. */}
      {!byLimit && observedPeak > 0 && (
        <button
          onClick={() => void onAdoptPeak(observedPeak)}
          className="mt-2 w-full rounded border border-dashed border-border py-1 text-[11px] text-slate-600 transition-colors hover:border-accent/40 hover:text-slate-300"
        >
          Взять потолок из наблюдений — {tokens(observedPeak)} за сессию
        </button>
      )}
    </div>
  )
}
