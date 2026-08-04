import { useEffect, useMemo, useState } from 'react'
import { Calculator, Loader2, RefreshCw, Star } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CostCalculator } from '@/components/ai/CostCalculator'
import { priceLabel } from '@/lib/ai-account'
import { providerFamily } from '../../../../../shared/ai-providers'
import { useAi } from '@/store/ai'
import type { AiAccess, AiAccessModel, AiPrice } from '@/types'

const inputCls =
  'w-full rounded border border-border bg-bg/60 px-2.5 py-1.5 text-[12px] text-slate-200 outline-none focus:border-accent/40'

type Filter = 'all' | 'mine' | 'cheap' | 'long'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'mine', label: 'Пользуюсь' },
  { id: 'cheap', label: 'Дешевле $1' },
  { id: 'long', label: 'Контекст 200k+' }
]

/** Прайс-лист, из которого берутся цены для этого доступа. */
function catalogProvider(access: AiAccess): string {
  // У роутера свой прайс: он перепродаёт чужие модели по своей цене, и брать цены прямого
  // провайдера значит показывать не то, что спишется.
  if (access.kind === 'router' || access.provider === 'openrouter') return 'openrouter'
  const family = providerFamily(access.provider)
  return family === 'google' ? 'gemini' : family === 'nvidia' ? 'nvidia_nim' : family
}

/** Цена модели: точное имя, потом без префикса провайдера — в логах и списках он не одинаков. */
function priceOf(model: string, prices: AiPrice[], provider: string): AiPrice | undefined {
  const lower = model.toLowerCase()
  return (
    prices.find((p) => p.provider === provider && p.model.toLowerCase() === lower) ??
    prices.find((p) => p.model.toLowerCase() === lower) ??
    prices.find((p) => p.model.toLowerCase().endsWith(`/${lower}`))
  )
}

const NO_MODELS: AiAccessModel[] = []

export function AccessModels({ access }: { access: AiAccess }): React.JSX.Element {
  const prices = useAi((s) => s.prices)
  const models = useAi((s) => s.models[access.id]) ?? NO_MODELS
  const loadModels = useAi((s) => s.loadModels)
  const setModel = useAi((s) => s.setModel)
  const fetchModels = useAi((s) => s.fetchModels)
  const refreshPrices = useAi((s) => s.refreshPrices)
  const pricesLoading = useAi((s) => s.pricesLoading)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [calc, setCalc] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void loadModels(access.id)
  }, [access.id, loadModels])

  const provider = catalogProvider(access)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .map((m) => ({ m, price: priceOf(m.model, prices, provider) }))
      .filter(({ m }) => (q ? m.model.toLowerCase().includes(q) : true))
      .filter(({ m, price }) => {
        if (filter === 'mine') return m.favorite
        if (filter === 'cheap') return price?.input != null && price.input * 1_000_000 < 1
        if (filter === 'long') return (m.contextTokens ?? price?.contextTokens ?? 0) >= 200_000
        return true
      })
      .sort((a, b) => {
        // Отмеченные — наверх: это то, чем владелец реально пользуется.
        if (a.m.favorite !== b.m.favorite) return a.m.favorite ? -1 : 1
        return a.m.model.localeCompare(b.m.model)
      })
  }, [models, prices, provider, query, filter])

  const lastFetch = models.reduce((max, m) => Math.max(max, m.fetchedAt ?? 0), 0)

  const onFetch = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await fetchModels(access.id)
      if (r)
        setNote(
          `у провайдера ${r.total}${r.added ? `, новых ${r.added}` : ''}${r.removed ? `, убрано ${r.removed}` : ''}`
        )
    } finally {
      setBusy(false)
    }
  }

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
            'shrink-0 rounded p-1.5 ring-1 ring-border transition-colors',
            calc ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-card-hover hover:text-slate-200'
          )}
        >
          <Calculator className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void onFetch()}
          disabled={busy}
          title="Спросить у провайдера список моделей"
          className="shrink-0 rounded p-1.5 text-slate-500 ring-1 ring-border transition-colors hover:bg-card-hover hover:text-slate-200 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                filter === f.id ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-white/5'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="shrink-0 text-[10px] text-slate-600">
          {note ?? (lastFetch > 0 ? `обновлено ${new Date(lastFetch).toLocaleDateString('ru-RU')}` : 'список не спрашивали')}
        </span>
      </div>

      {calc && (
        <div className="mt-3">
          <CostCalculator prices={prices.filter((p) => p.provider === provider)} />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mt-4 rounded border border-dashed border-border py-10 text-center text-[12px] text-slate-600">
          {models.length === 0 ? (
            <>
              Список моделей не загружен.
              <button onClick={() => void onFetch()} className="ml-1 text-accent hover:underline">
                Спросить у провайдера
              </button>
            </>
          ) : (
            'Под фильтр ничего не подошло'
          )}
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-surface text-slate-600">
              <tr>
                <th className="py-1 font-normal">Модель</th>
                <th className="py-1 text-right font-normal">Вход / 1M</th>
                <th className="py-1 text-right font-normal">Выход / 1M</th>
                <th className="py-1 text-right font-normal">Контекст</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, price }) => (
                <tr key={m.model} className="group border-t border-border/50">
                  <td className="max-w-[15rem] truncate py-1 text-slate-300" title={m.model}>
                    {m.model}
                    {price?.deprecatedAt && <span className="ml-1 text-[10px] text-amber-500">до {price.deprecatedAt}</span>}
                  </td>
                  <td className="py-1 text-right tabular-nums text-slate-400">{priceLabel(price?.input ?? null)}</td>
                  <td className="py-1 text-right tabular-nums text-slate-400">{priceLabel(price?.output ?? null)}</td>
                  <td className="py-1 text-right tabular-nums text-slate-600">
                    {(() => {
                      const ctx = m.contextTokens ?? price?.contextTokens ?? null
                      return ctx ? `${Math.round(ctx / 1000)}k` : '—'
                    })()}
                  </td>
                  <td className="py-1 text-right">
                    <button
                      onClick={() => toggleFavorite(m.model)}
                      className={cn(
                        'rounded p-0.5 transition-opacity',
                        m.favorite ? 'text-accent' : 'text-slate-700 opacity-0 group-hover:opacity-100'
                      )}
                      title={m.favorite ? 'Убрать из «пользуюсь»' : 'Отметить «пользуюсь»'}
                      aria-pressed={m.favorite}
                    >
                      <Star className={cn('h-3 w-3', m.favorite && 'fill-accent')} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Цены живут отдельно от перечня: провайдер отдаёт список моделей, но не прайс. */}
      <button
        onClick={() => void refreshPrices(access.hasKey ? access.id : undefined)}
        disabled={pricesLoading}
        className="mt-2 flex shrink-0 items-center justify-center gap-1.5 rounded border border-dashed border-border py-1 text-[11px] text-slate-600 transition-colors hover:border-accent/40 hover:text-slate-300 disabled:opacity-50"
      >
        {pricesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        Обновить каталог цен
      </button>
    </div>
  )
}
