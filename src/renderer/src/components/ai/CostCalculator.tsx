import { useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { Card } from '@/components/ui/Page'
import { calculate } from '@/lib/ai-account'
import type { AiPrice } from '@/types'

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm tabular-nums text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

/** Тысячи токенов из поля ввода. Мусор считаем нулём — «−5 тысяч токенов» не бывает. */
function thousands(v: string): number {
  const n = Number(v.replace(/\s/g, ''))
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

function cost(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/**
 * «Сколько будет стоить такая задача» — у всех известных моделей сразу.
 *
 * Объём задаётся в тысячах токенов, потому что в токенах его никто не держит в голове, а
 * порядок величины («300 тысяч входа») прикинуть можно.
 */
export function CostCalculator({ prices }: { prices: AiPrice[] }): React.JSX.Element {
  const [input, setInput] = useState('300')
  const [output, setOutput] = useState('20')
  const [cacheRead, setCacheRead] = useState('0')
  const [cacheWrite, setCacheWrite] = useState('0')
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const usage = {
      input: thousands(input),
      output: thousands(output),
      cacheWrite: thousands(cacheWrite),
      cacheWrite1h: 0,
      cacheRead: thousands(cacheRead)
    }
    const q = query.trim().toLowerCase()
    const pool = q ? prices.filter((p) => p.model.toLowerCase().includes(q) || p.provider.includes(q)) : prices
    return calculate(pool, usage, 25)
  }, [input, output, cacheRead, cacheWrite, query, prices])

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Calculator className="h-4 w-4 text-accent" /> Во сколько обойдётся задача
      </div>
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Вход, тыс.', value: input, set: setInput },
          { label: 'Выход, тыс.', value: output, set: setOutput },
          { label: 'Чтение кэша, тыс.', value: cacheRead, set: setCacheRead },
          { label: 'Запись кэша, тыс.', value: cacheWrite, set: setCacheWrite }
        ].map((f) => (
          <label key={f.label} className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">{f.label}</span>
            <input className={inputCls} value={f.value} onChange={(e) => f.set(e.target.value)} inputMode="numeric" />
          </label>
        ))}
      </div>
      <input
        className={`${inputCls} mt-3`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Фильтр по модели или провайдеру"
      />

      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border py-8 text-center text-xs text-slate-500">
          Под фильтр ничего не подошло
        </div>
      ) : (
        <div className="mt-4 max-h-80 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">Модель</th>
                <th className="py-1.5 font-medium">Провайдер</th>
                <th className="py-1.5 text-right font-medium">Контекст</th>
                <th className="py-1.5 text-right font-medium">Стоимость</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.provider}/${r.model}`} className="border-t border-border/60">
                  <td className="max-w-[18rem] truncate py-1.5 text-slate-200" title={r.model}>
                    {r.model}
                  </td>
                  <td className="py-1.5 text-slate-500">{r.provider}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {r.contextTokens ? `${Math.round(r.contextTokens / 1000)}k` : '—'}
                  </td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-white">{cost(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
