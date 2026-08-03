import { useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Sparkline } from '@/components/ui/Sparkline'
import { money } from '@/lib/format'
import { byModel, daysAgoDate, dailySeries, totalsFor } from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import type { AiAccess } from '@/types'

const SPANS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' }
]

/**
 * Какой источник логов относится к этому доступу.
 *
 * Связь честная, но грубая: логи знают, какой инструмент потратил токены, и не знают, на какой
 * аккаунт он смотрел. Для доступов без своего инструмента расхода нет — так и пишем, вместо
 * того чтобы показать чужие цифры.
 */
function sourceFor(access: AiAccess): string | null {
  if (access.usedBy.some((u) => u.toLowerCase().includes('claude code'))) return 'claude-code'
  if (access.usedBy.some((u) => u.toLowerCase().includes('codex'))) return 'codex'
  if (access.provider === 'anthropic') return 'claude-code'
  if (access.provider === 'openai') return 'codex'
  return null
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function AccessUsage({ access }: { access: AiAccess }): React.JSX.Element {
  const usage = useAi((s) => s.usage)
  const collect = useAi((s) => s.collect)
  const collecting = useAi((s) => s.collecting)
  const collectedAt = useAi((s) => s.usageCollectedAt)
  const unpriced = useAi((s) => s.unpriced)
  const [span, setSpan] = useState(30)

  const source = sourceFor(access)
  const since = daysAgoDate(span - 1)
  const totals = useMemo(
    () => (source ? totalsFor(usage, { since, source }) : null),
    [usage, since, source]
  )
  const rows = useMemo(
    () => (source ? byModel(usage.filter((d) => d.source === source), since) : []),
    [usage, since, source]
  )
  const series = useMemo(
    () => (source ? dailySeries(usage.filter((d) => d.source === source), span) : []),
    [usage, span, source]
  )

  if (!source)
    return (
      <div className="p-5">
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-slate-500">
          У этого доступа нет инструмента, который пишет локальные логи расхода.
          <br />
          Расход по нему считается только там, где провайдер отдаёт его сам — например, остаток
          OpenRouter на вкладке «Ключ».
        </div>
      </div>
    )

  return (
    <div className="flex h-full flex-col p-5">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {SPANS.map((s) => (
            <button
              key={s.days}
              onClick={() => setSpan(s.days)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                span === s.days ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:bg-white/5'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void collect()}
          disabled={collecting}
          className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
        >
          {collecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Перечитать логи
        </button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-bg/40 p-3">
          <div className="text-[11px] text-slate-500">Эквивалент по ценам API</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">
            {totals ? money(Math.round(totals.costUsd * 100) / 100) : '—'}
          </div>
          {access.kind === 'subscription' && (
            <div className="mt-0.5 text-[10px] text-slate-600">по подписке это не списанные деньги</div>
          )}
        </div>
        <div className="rounded-lg bg-bg/40 p-3">
          <div className="text-[11px] text-slate-500">Токенов</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">
            {totals
              ? tokens(
                  totals.usage.input +
                    totals.usage.output +
                    totals.usage.cacheWrite +
                    totals.usage.cacheWrite1h +
                    totals.usage.cacheRead
                )
              : '—'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-600">
            {totals ? `чтение кэша ${tokens(totals.usage.cacheRead)}` : ''}
          </div>
        </div>
        <div className="rounded-lg bg-bg/40 p-3">
          <div className="text-[11px] text-slate-500">Запросов</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">{totals?.requests ?? '—'}</div>
          <div className="mt-0.5 text-[10px] text-slate-600">
            {totals && totals.activeDays > 0 ? `в ${totals.activeDays} дн. из ${span}` : ''}
          </div>
        </div>
      </div>

      {series.some((v) => v > 0) && (
        <div className="mt-4 rounded-lg bg-bg/40 p-3">
          <div className="mb-2 text-[11px] text-slate-500">По дням</div>
          <Sparkline data={series} width={520} height={48} />
        </div>
      )}

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-slate-500">
            {collectedAt
              ? 'За выбранный период расхода нет.'
              : 'Логи ещё не читались — нажми «Перечитать логи».'}
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">Модель</th>
                <th className="py-1.5 text-right font-medium">Токенов</th>
                <th className="py-1.5 text-right font-medium">Запросов</th>
                <th className="py-1.5 text-right font-medium">Эквивалент</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-t border-border/60">
                  <td className="max-w-[18rem] truncate py-1.5 text-slate-200" title={r.model}>
                    {r.model}
                    {unpriced.includes(r.model) && (
                      <span className="ml-1.5 text-[10px] text-amber-500" title="Модели нет в каталоге цен">
                        цены нет
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-300">{tokens(r.tokens)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">{r.requests}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-white">
                    {money(Math.round(r.costUsd * 100) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
