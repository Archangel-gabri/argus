import { useEffect, useMemo, useState } from 'react'
import { Calculator, Loader2, RefreshCw, Star } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CostCalculator } from '@/components/ai/CostCalculator'
import { priceLabel } from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import type { AiAccess, AiAccessModel, AiPrice } from '@/types'

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

type Filter = 'all' | 'cheap' | 'long' | 'vision' | 'tools'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'cheap', label: 'Дешевле $1 / 1M' },
  { id: 'long', label: 'Контекст 200k+' },
  { id: 'vision', label: 'Видит картинки' },
  { id: 'tools', label: 'Умеет инструменты' }
]

/** Провайдер каталога, из которого берутся модели этого доступа. */
function catalogProvider(access: AiAccess): string {
  // У роутера свой прайс-лист: он перепродаёт чужие модели по своей цене, и брать цены
  // прямого провайдера для него — значит показывать не то, что спишется.
  if (access.kind === 'router' || access.provider === 'openrouter') return 'openrouter'
  return access.provider
}

/** Пустой список моделей — стабильная ссылка: иначе каждый рендер пересчитывал бы таблицу. */
const NO_MODELS: AiAccessModel[] = []

export function AccessModels({ access }: { access: AiAccess }): React.JSX.Element {
  const prices = useAi((s) => s.prices)
  const models = useAi((s) => s.models[access.id]) ?? NO_MODELS
  const loadModels = useAi((s) => s.loadModels)
  const setModel = useAi((s) => s.setModel)
  const refreshPrices = useAi((s) => s.refreshPrices)
  const pricesLoading = useAi((s) => s.pricesLoading)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [calc, setCalc] = useState(false)

  useEffect(() => {
    void loadModels(access.id)
  }, [access.id, loadModels])

  const favorites = useMemo(() => new Set(models.filter((m) => m.favorite).map((m) => m.model)), [models])

  const rows = useMemo(() => {
    const provider = catalogProvider(access)
    const q = query.trim().toLowerCase()
    return prices
      .filter((p) => p.provider === provider)
      .filter((p) => (q ? p.model.toLowerCase().includes(q) : true))
      .filter((p: AiPrice) => {
        if (filter === 'cheap') return p.input != null && p.input * 1_000_000 < 1
        if (filter === 'long') return (p.contextTokens ?? 0) >= 200_000
        if (filter === 'vision') return p.supportsVision
        if (filter === 'tools') return p.supportsTools
        return true
      })
      .sort((a, b) => {
        // Избранное — наверх: это то, чем владелец реально пользуется.
        const fa = favorites.has(a.model) ? 0 : 1
        const fb = favorites.has(b.model) ? 0 : 1
        if (fa !== fb) return fa - fb
        return (a.input ?? Infinity) - (b.input ?? Infinity)
      })
  }, [prices, access, query, filter, favorites])

  const toggleFavorite = (model: string): void => {
    const cur = models.find((m) => m.model === model)
    void setModel({
      accessId: access.id,
      model,
      favorite: !cur?.favorite,
      markupPct: cur?.markupPct ?? null,
      priceInput: cur?.priceInput ?? null,
      priceOutput: cur?.priceOutput ?? null,
      notes: cur?.notes ?? null
    })
  }

  return (
    <div className="flex h-full flex-col p-5">
      <div className="flex items-center gap-2">
        <input className={inputCls} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск модели" />
        <button
          onClick={() => setCalc((v) => !v)}
          title="Посчитать стоимость задачи"
          aria-pressed={calc}
          className={cn(
            'shrink-0 rounded p-2 ring-1 ring-border transition-colors',
            calc ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-card-hover hover:text-slate-200'
          )}
        >
          <Calculator className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void refreshPrices(access.hasKey ? access.id : undefined)}
          disabled={pricesLoading}
          title="Обновить каталог цен"
          className="shrink-0 rounded p-2 text-slate-500 ring-1 ring-border transition-colors hover:bg-card-hover hover:text-slate-200 disabled:opacity-50"
        >
          {pricesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Калькулятор живёт здесь, а не в шапке экрана: считают стоимость, когда уже смотрят на
          цены, и почти никогда — открывая раздел. */}
      {calc && (
        <div className="mt-3">
          <CostCalculator prices={rows.length ? prices.filter((p) => p.provider === catalogProvider(access)) : prices} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
              filter === f.id ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:bg-white/5'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border py-12 text-center text-xs text-slate-500">
          {prices.length === 0
            ? 'Каталог цен пуст — нажми «Обновить цены».'
            : `Для провайдера «${catalogProvider(access)}» подходящих моделей в каталоге нет.`}
        </div>
      ) : (
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">Модель</th>
                <th className="py-1.5 text-right font-medium">Вход / 1M</th>
                <th className="py-1.5 text-right font-medium">Выход / 1M</th>
                <th className="py-1.5 text-right font-medium">Кэш чт.</th>
                <th className="py-1.5 text-right font-medium">Контекст</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.model} className="border-t border-border/60">
                  <td className="max-w-[20rem] truncate py-1.5 text-slate-200" title={p.model}>
                    {p.model}
                    {p.deprecatedAt && <span className="ml-1.5 text-[10px] text-amber-500">до {p.deprecatedAt}</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-300">{priceLabel(p.input)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-300">{priceLabel(p.output)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">{priceLabel(p.cacheRead)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {p.contextTokens ? `${Math.round(p.contextTokens / 1000)}k` : '—'}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => toggleFavorite(p.model)}
                      className="rounded p-1 text-slate-600 hover:text-accent"
                      title={favorites.has(p.model) ? 'Убрать из «пользуюсь»' : 'Отметить «пользуюсь»'}
                      aria-pressed={favorites.has(p.model)}
                    >
                      <Star className={`h-3.5 w-3.5 ${favorites.has(p.model) ? 'fill-accent text-accent' : ''}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
