import { useMemo, useState } from 'react'
import { money } from '@/lib/format'
import { UsageBars } from '@/components/ai/UsageBars'
import { byModel, dailySeries, daysAgoDate, totalsFor } from '@/lib/ai-account'
import { totalTokens } from '../../../../shared/ai-pricing'
import { cn } from '@/lib/cn'
import { useAi } from '@/store/ai'
import type { AiAccess } from '@/types'

const SPANS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' }
]

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Расход доступа: сколько сожжено и на что.
 *
 * Кнопки «пересчитать» здесь нет — логи читаются сами при запуске. Показывать человеку кнопку,
 * которую надо нажимать каждый раз при входе, значит перекладывать на него работу приложения.
 */
export function UsageSection({ access, source }: { access: AiAccess; source: string | null }): React.JSX.Element | null {
  const usage = useAi((s) => s.usage)
  const collectedAt = useAi((s) => s.usageCollectedAt)
  const unpriced = useAi((s) => s.unpriced)
  const [span, setSpan] = useState(30)

  const since = daysAgoDate(span - 1)
  const rows = useMemo(() => (source ? usage.filter((d) => d.source === source) : []), [usage, source])
  const totals = useMemo(() => totalsFor(rows, { since }), [rows, since])
  const series = useMemo(() => dailySeries(rows, span), [rows, span])
  const models = useMemo(() => byModel(rows, since).slice(0, 6), [rows, since])

  if (!source)
    return (
      <section>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Расход</h3>
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-[12px] text-slate-600">
          У этого доступа нет инструмента, который пишет локальные логи. Расход по нему виден там, где
          провайдер отдаёт его сам, — в плашке баланса выше.
        </p>
      </section>
    )

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Расход</h3>
        <div className="flex items-center gap-3">
          {collectedAt && (
            <span className="text-[10px] text-slate-700">
              логи прочитаны {new Date(collectedAt).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
            </span>
          )}
          <div className="flex gap-1">
            {SPANS.map((s) => (
              <button
                key={s.days}
                onClick={() => setSpan(s.days)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  span === s.days ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-white/5'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex gap-8">
            <div>
              <div className="text-[11px] text-slate-600">
                {access.kind === 'subscription' ? 'Эквивалент по ценам API' : 'Потрачено'}
              </div>
              <div className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums text-white">
                {money(Math.round(totals.costUsd))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-600">Токенов</div>
              <div className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums text-white">
                {tokens(totalTokens(totals.usage))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-600">Запросов</div>
              <div className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums text-white">
                {totals.requests}
              </div>
            </div>
          </div>
          {series.some((v) => v > 0) && <UsageBars data={series} width={360} height={44} />}
        </div>

        {access.kind === 'subscription' && totals.costUsd > 0 && (
          <p className="mt-3 text-[11px] text-slate-600">
            По подписке это не списанные деньги: столько стоил бы тот же объём по ценам API.
          </p>
        )}

        {models.length > 0 && (
          <table className="mt-4 w-full text-left text-[11px]">
            <thead className="text-slate-600">
              <tr>
                <th className="py-1 font-normal">Модель</th>
                <th className="py-1 text-right font-normal">Токенов</th>
                <th className="py-1 text-right font-normal">Запросов</th>
                <th className="py-1 text-right font-normal">Стоимость</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-t border-border/50">
                  <td className="max-w-[18rem] truncate py-1 text-slate-300" title={m.model}>
                    {m.model}
                    {unpriced.includes(m.model) && <span className="ml-1.5 text-[10px] text-amber-500">цены нет</span>}
                  </td>
                  <td className="py-1 text-right tabular-nums text-slate-400">{tokens(m.tokens)}</td>
                  <td className="py-1 text-right tabular-nums text-slate-600">{m.requests}</td>
                  <td className="py-1 text-right tabular-nums text-slate-200">{money(Math.round(m.costUsd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {totals.requests === 0 && (
          <p className="mt-3 text-[12px] text-slate-600">За выбранный период запросов не было.</p>
        )}
      </div>
    </section>
  )
}
