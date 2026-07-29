import { useEffect, useState } from 'react'
import { CalendarClock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Page, PageHeader, StatTile, Card, SourceBadge } from '@/components/ui/Page'
import { Donut } from '@/components/ui/Donut'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useDevices } from '@/store/devices'
import { useSubs } from '@/store/subs'
import { catColor, toUsd, SUB_CATEGORIES } from '@/data/subscriptions'
import type { Currency, Subscription, SubscriptionInput } from '@/types'
import { CURRENCY_CODES } from '@/types'

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

function daysUntil(iso: string | null): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent/40'

function SubForm({
  initial,
  onSubmit,
  onClose
}: {
  initial?: Subscription | null
  onSubmit: (i: SubscriptionInput) => void
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [category, setCategory] = useState(initial?.category ?? 'AI')
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? 'USD')
  const [period, setPeriod] = useState<'mo' | 'yr'>(initial?.period === 'yr' ? 'yr' : 'mo')
  const [renews, setRenews] = useState(initial?.nextRenewal ?? '')
  const submit = (): void => {
    if (!name.trim() || !parseFloat(amount)) return
    onSubmit({ name: name.trim(), category, amount: parseFloat(amount), currency, period, nextRenewal: renews || null })
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
        <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          {SUB_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
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
              {c}
            </option>
          ))}
        </select>
        <select className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value as 'mo' | 'yr')}>
          <option value="mo">/мес</option>
          <option value="yr">/год</option>
        </select>
        <input className={inputCls} type="date" value={renews} onChange={(e) => setRenews(e.target.value)} />
      </div>
      <button onClick={submit} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover">
        {initial ? 'Сохранить' : 'Добавить'}
      </button>
    </Card>
  )
}

export function SubscriptionsView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const subs = useSubs((s) => s.subs)
  const loaded = useSubs((s) => s.loaded)
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
      <PageHeader title="Subscriptions" subtitle={`${all.length} активных · в месяц`} />

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

      {(adding || editing) && (
        <SubForm
          initial={editing}
          onSubmit={(i) => {
            if (editing) updateSub(editing.id, i)
            else addSub(i)
            setAdding(false)
            setEditing(null)
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

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-white">Все подписки</h2>
          <div className="divide-y divide-border">
            {all.map((x) => {
              const days = daysUntil(x.renews)
              return (
                <div key={x.id} className="group flex items-center gap-3 py-2.5 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: catColor(x.category) }} />
                  <span className="min-w-0 flex-1 truncate text-slate-200">{x.name}</span>
                  {days != null && days <= 14 && (
                    <span className="hidden shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 sm:inline">
                      через {days}д
                    </span>
                  )}
                  <span className="hidden w-16 text-xs text-slate-500 sm:inline">{x.category}</span>
                  <SourceBadge kind={x.source} />
                  <span className="w-24 text-right tabular-nums text-slate-300">
                    {money(x.amount, x.currency)}
                    <span className="text-slate-500">/{x.period}</span>
                  </span>
                  {x.userId ? (
                    <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
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
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => removeSub(x.userId!)}
                        className="rounded p-1 text-slate-500 hover:text-rose-400"
                        title="Удалить"
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
                    {x.days <= 0 ? 'сегодня' : `${x.days}д`}
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
