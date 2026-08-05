import { useEffect, useState } from 'react'
import { CalendarClock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Page, PageHeader, StatTile, Card, SourceBadge } from '@/components/ui/Page'
import { Donut } from '@/components/ui/Donut'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useDevices } from '@/store/devices'
import { useSubs } from '@/store/subs'
import { catColor, catLabel, toUsd, SUB_CATEGORIES } from '@/data/subscriptions'
import type { Currency, Subscription, SubscriptionInput } from '@/types'
import { CURRENCY_CODES } from '@/types'
import { advanceRenewal, daysUntilCalendar, renewalLabel } from '../../../shared/billing'
import { markFor } from '@/assets/providers/marks'

interface Row {
  id: string
  name: string
  category: string
  amount: number
  currency: Currency
  usd: number
  period: 'mo' | 'yr'
  renews: string | null
  source: 'live' | 'manual'
  userId?: string
}
const monthlyUsd = (r: Row): number => (r.period === 'mo' ? r.usd : r.usd / 12)

const daysUntil = (iso: string | null): number | null => iso ? daysUntilCalendar(iso) : null

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent/40'

function SubForm({
  initial,
  onSubmit,
  onClose,
  error
}: {
  initial?: Subscription | null
  onSubmit: (i: SubscriptionInput) => Promise<boolean>
  onClose: () => void
  error: string | null
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [provider, setProvider] = useState(initial?.provider ?? '')
  const [category, setCategory] = useState(initial?.category ?? 'AI')
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? 'USD')
  const [period, setPeriod] = useState<'mo' | 'yr'>(initial?.period === 'yr' ? 'yr' : 'mo')
  const [renews, setRenews] = useState(initial?.nextRenewal ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [manualRenewal, setManualRenewal] = useState(initial?.manualRenewal ?? false)
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    const parsedAmount = Number(amount)
    if (!name.trim()) {
      setValidation('Укажи название')
      return
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      setValidation('Сумма должна быть неотрицательным числом')
      return
    }
    if (busy) return
    setValidation(null)
    setBusy(true)
    try {
      await onSubmit({
        name: name.trim(), provider: provider.trim(), category, amount: parsedAmount,
        currency, period, nextRenewal: renews || null, notes: notes.trim() || null, manualRenewal
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{initial ? 'Редактировать подписку' : 'Новая подписка'}</h3>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <input className={inputCls} placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inputCls} placeholder="Провайдер" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          {SUB_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {catLabel(c)}
            </option>
          ))}
        </select>
        <input
          className={inputCls}
          placeholder="Сумма"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
          {CURRENCY_CODES.map((c) => (
            <option key={c} value={c}>
              {catLabel(c)}
            </option>
          ))}
        </select>
        <select className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value as 'mo' | 'yr')}>
          <option value="mo">/мес</option>
          <option value="yr">/год</option>
        </select>
        <input className={inputCls} type="date" value={renews} onChange={(e) => setRenews(e.target.value)} />
        <textarea
          className={cn(inputCls, 'min-h-16 resize-y sm:col-span-2')}
          placeholder="Заметки"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <label className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-3 py-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={manualRenewal}
            onChange={(event) => setManualRenewal(event.target.checked)}
          />
          Продлеваю вручную
        </label>
      </div>
      {(validation || error) && <p role="alert" className="mt-2 text-xs text-rose-400">{validation ?? error}</p>}
      <button
        onClick={() => void submit()}
        disabled={busy}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Сохраняю…' : initial ? 'Сохранить' : 'Добавить'}
      </button>
    </Card>
  )
}

/**
 * Знак компании в строке подписки.
 *
 * Раньше здесь была цветная точка категории — она отвечала на вопрос «к какой полке относится»,
 * но не на тот, который человек задаёт списку на самом деле: «где здесь Spotify». Логотип
 * отвечает быстрее любой строки. Компании без знака сохраняют точку категории, чтобы ряд не
 * рассыпался на «с картинкой» и «без картинки».
 */
function BrandDot({
  name,
  provider,
  category
}: {
  name: string
  provider?: string
  category: string
}): React.JSX.Element {
  const mark = markFor(`${provider ?? ''} ${name}`)
  if (!mark)
    return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: catColor(category) }} />
  return (
    <svg
      viewBox={mark.vb}
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden
      className="shrink-0"
      style={{ color: mark.tint }}
    >
      {mark.paths.map((path, i) => (
        <path key={i} d={path.d} fillRule={path.fillRule} clipRule={path.clipRule} />
      ))}
    </svg>
  )
}

export function SubscriptionsView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const subs = useSubs((s) => s.subs)
  const loaded = useSubs((s) => s.loaded)
  const error = useSubs((s) => s.error)
  const loadSubs = useSubs((s) => s.load)
  const addSub = useSubs((s) => s.create)
  const updateSub = useSubs((s) => s.update)
  const removeSub = useSubs((s) => s.remove)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Subscription | null>(null)

  useEffect(() => {
    if (!loaded) loadSubs()
  }, [loaded, loadSubs])

  const infra: Row[] = devices
    .filter((d) => d.cost.usd > 0)
    .map((d) => ({
      id: 'dev-' + d.id,
      name: d.name,
      category: 'Infra',
      amount: d.cost.amount,
      currency: d.cost.currency,
      usd: d.cost.usd,
      period: 'mo',
      renews: null,
      source: 'live'
    }))
  const userRows: Row[] = subs.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    amount: s.amount,
    currency: s.currency,
    usd: toUsd(s.amount, s.currency),
    period: s.period,
    renews: s.nextRenewal,
    source: 'manual',
    userId: s.id
  }))
  const all = [...infra, ...userRows]
  const monthly = all.reduce((s, x) => s + monthlyUsd(x), 0)
  const yearly = monthly * 12

  const byCat = Object.entries(
    all.reduce<Record<string, number>>((a, x) => {
      a[x.category] = (a[x.category] ?? 0) + monthlyUsd(x)
      return a
    }, {})
  )
    .map(([label, value]) => ({ label, value, color: catColor(label) }))
    .sort((a, b) => b.value - a.value)

  const upcoming = all
    .map((x) => ({ ...x, days: daysUntil(x.renews) }))
    .filter((x): x is Row & { days: number } => x.days != null)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6)

  return (
    <Page>
      <PageHeader title="Подписки" subtitle={`${all.length} активных · в месяц`} />

      <div className="mb-4 flex justify-end">
        <button
          onClick={() => {
            setEditing(null)
            setAdding((v) => !v)
          }}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-bold text-bg hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" /> Подписка
        </button>
      </div>

      {/* key даёт форме идентичность цели правки. Без него переход «карандаш у A →
          карандаш у B» не перемонтирует компонент: React видит тот же элемент,
          useState сохраняет значения формы A, а «Сохранить» отправляет их с
          идентификатором B — то есть молча подменяет чужую запись. */}
      {(adding || editing) && (
        <SubForm
          key={editing?.id ?? 'new'}
          initial={editing}
          error={error}
          onSubmit={async (input) => {
            const ok = editing ? await updateSub(editing.id, input) : await addSub(input)
            if (ok) {
              setAdding(false)
              setEditing(null)
            }
            return ok
          }}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}

      <div className="grid grid-cols-3 gap-4">
        <StatTile label="В месяц" value={money(monthly)} />
        <StatTile label="В год" value={money(yearly)} />
        <StatTile label="Активных" value={String(all.length)} hint={`${infra.length} инфра · ${userRows.length} приложений`} />
      </div>

      {error && !adding && !editing && <p role="alert" className="mt-3 text-xs text-rose-400">{error}</p>}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-white">Все подписки</h2>
          <div className="divide-y divide-border">
            {all.map((x) => {
              const days = daysUntil(x.renews)
              const stored = x.userId ? subs.find((sub) => sub.id === x.userId) : undefined
              return (
                <div key={x.id} className="group flex items-center gap-3 py-2.5 text-sm">
                  {/* Знак компании узнаётся быстрее строки: в списке из двадцати подписок глаз
                      находит Spotify по зелёному кружку раньше, чем прочитает название. Цвет
                      категории остаётся запасным вариантом — для тех, чьего знака нет. */}
                  <BrandDot name={x.name} provider={stored?.provider} category={x.category} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-200">{x.name}</span>
                    {stored && <span className="block truncate text-[10px] text-slate-500">{stored.provider || 'провайдер не указан'}</span>}
                  </span>
                  {days != null && days <= 14 && (
                    <span
                      className={cn(
                        'hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium sm:inline',
                        days < 0 ? 'bg-rose-500/15 text-rose-400' : 'bg-amber-500/15 text-amber-400'
                      )}
                    >
                      {renewalLabel(days)}
                    </span>
                  )}
                  {/* Ширины не хватало на «Инфраструктура», и подпись уезжала под соседний бейдж.
                      Обрезаем явно и даём полный текст подсказкой, а не рисуем поверх. */}
                  <span className="hidden w-24 truncate text-xs text-slate-500 sm:inline" title={catLabel(x.category)}>
                    {catLabel(x.category)}
                  </span>
                  <SourceBadge kind={x.source} />
                  {stored?.manualRenewal && (
                    <span className="hidden rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400 lg:inline">вручную</span>
                  )}
                  {/* Ноль в денежной колонке читается как «бесплатно», а у подписки, купленной на
                      стороне, цена бывает просто не внесена. Это разные вещи, и путать их нельзя:
                      из-за нуля подписка молча выпадает из месячного итога, выглядя оплаченной. */}
                  <span className="w-24 text-right tabular-nums text-slate-300">
                    {x.amount > 0 ? (
                      <>
                        {money(x.amount, x.currency)}
                        <span className="text-slate-500">{x.period === 'yr' ? '/год' : '/мес'}</span>
                      </>
                    ) : (
                      <span className="text-[11px] text-amber-400/70" title="Подписка есть, но её цена не внесена — в месячный итог она не попадает">
                        цены нет
                      </span>
                    )}
                  </span>
                  {x.userId ? (
                    <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      {/* Кнопка нужна не только ручным: у автосписаний дату тоже никто не
                          двигает, и без неё прошедший срок остаётся в записи навсегда. */}
                      {stored?.nextRenewal && (
                        <button
                          onClick={() => {
                            const nextRenewal = advanceRenewal(stored.nextRenewal!, stored.period)
                            if (nextRenewal) void updateSub(stored.id, { ...stored, nextRenewal })
                          }}
                          className="rounded px-1.5 py-1 text-[10px] text-slate-500 hover:text-emerald-400"
                          title="Сдвинуть дату на оплаченный период"
                          aria-label={`Отметить продление ${stored.name}`}
                        >
                          Продлено
                        </button>
                      )}
                      <button
                        onClick={() => {
                          const s = subs.find((sub) => sub.id === x.userId)
                          if (s) {
                            setEditing(s)
                            setAdding(false)
                          }
                        }}
                        className="rounded p-1 text-slate-500 hover:text-accent"
                        title="Редактировать"
                        aria-label={`Редактировать подписку ${x.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => void removeSub(x.userId!)}
                        className="rounded p-1 text-slate-500 hover:text-rose-400"
                        title="Удалить"
                        aria-label={`Удалить подписку ${x.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : (
                    <span className="w-6" />
                  )}
                </div>
              )
            })}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-white">По категориям</h2>
            <Donut data={byCat} center={money(monthly)} sub="/ мес" />
          </Card>
          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <CalendarClock className="h-4 w-4 text-accent" /> Ближайшие продления
            </h2>
            <ul className="space-y-2">
              {upcoming.map((x) => (
                <li key={x.id} className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-300">{x.name}</span>
                  <span className={cn('tabular-nums', x.days <= 14 ? 'text-amber-400' : 'text-slate-500')}>
                    {renewalLabel(x.days)}
                  </span>
                </li>
              ))}
              {upcoming.length === 0 && <li className="text-xs text-slate-500">нет дат продления</li>}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  )
}
