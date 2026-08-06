import { useEffect, useState } from 'react'
import { CalendarClock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Page, PageHeader, StatTile, Card } from '@/components/ui/Page'
import { Donut } from '@/components/ui/Donut'
import { approxMoney, isApprox, money, plural } from '@/lib/format'
import { cn } from '@/lib/cn'
import { BrandMark } from '@/components/BrandMark'
import { useDevices } from '@/store/devices'
import { useSubs } from '@/store/subs'
import { catColor, catLabel, toUsd, SUB_CATEGORIES } from '@/data/subscriptions'
import type { Currency, Subscription, SubscriptionInput } from '@/types'
import { CURRENCY_CODES } from '@/types'
import { advanceRenewal, daysUntilCalendar, renewalLabel } from '../../../shared/billing'

interface Row {
  id: string
  name: string
  /** Компания, которой платят: по ней ищется логотип. У строки-устройства это хостер. */
  provider?: string
  /** За какую железку платят — показывается в строке, когда связь задана. */
  forDevice?: string
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
  payableDevices,
  initial,
  onSubmit,
  onClose,
  error
}: {
  /** Устройства парка — чтобы платёж можно было привязать к железке, за которую он идёт. */
  payableDevices: Array<{ id: string; name: string }>
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
  const [deviceId, setDeviceId] = useState(initial?.deviceId ?? '')
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    // Запятая — обычный ввод на русской раскладке, а `inputMode="decimal"` её и предлагает.
    // Раньше «112,95» превращалось в NaN и отбивалось словами «сумма должна быть
    // неотрицательным числом» — человек видит неотрицательное число и не понимает претензии.
    const parsedAmount = Number(amount.trim().replace(',', '.'))
    if (!name.trim()) {
      setValidation('Укажи название')
      return
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      setValidation(
        amount.trim() ? `Не понимаю сумму «${amount.trim()}» — нужно число, например 112.95` : 'Укажи сумму'
      )
      return
    }
    if (busy) return
    setValidation(null)
    setBusy(true)
    try {
      await onSubmit({
        name: name.trim(), provider: provider.trim(), category, amount: parsedAmount,
        currency, period, nextRenewal: renews || null, notes: notes.trim() || null, manualRenewal,
        deviceId: deviceId || null
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{initial ? 'Редактировать подписку' : 'Новая подписка'}</h3>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-200" aria-label="Закрыть форму подписки">
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
          {/* Код валюты — сам себе подпись. Раньше он проходил через карту КАТЕГОРИЙ: сейчас
              спасал фолбэк «нет в карте — верни как есть», но первый же ключ категории,
              совпавший с кодом валюты, показал бы вместо «USD» слово «ИИ». */}
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
        <textarea
          className={cn(inputCls, 'min-h-16 resize-y sm:col-span-2')}
          placeholder="Заметки"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {/* Связь с железкой из парка. Без неё сервер, у которого в парке проставлена цена,
            попадает в месячный расход ДВАЖДЫ — и понять это по экрану невозможно, потому что
            записи называются по-разному и лежат в разных разделах. */}
        <select
          className={inputCls}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          aria-label="За какое устройство платим"
        >
          <option value="">Не за устройство</option>
          {payableDevices.map((d) => (
            <option key={d.id} value={d.id}>
              Платёж за {d.name}
            </option>
          ))}
        </select>
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

  // Устройство, за которое уже платит подписка, отдельной строкой НЕ показывается.
  //
  // Сервер живёт в приложении дважды по замыслу: как железка в парке (со своей ценой) и как
  // регулярный платёж в подписках. Пока связи между ними не было, экран складывал обе строки —
  // и месячный расход по инфраструктуре был вдвое больше настоящего. Заметить это можно было
  // только сверив список глазами, потому что называются они по-разному: «HubVPN · Germany» и
  // «VPS Германия — мастер-панель HubVPN».
  const paidBySubscription = new Set(subs.map((x) => x.deviceId).filter(Boolean))
  const infra: Row[] = devices
    .filter((d) => d.cost.usd > 0 && !paidBySubscription.has(d.id))
    .map((d) => ({
      id: 'dev-' + d.id,
      name: d.name,
      // Хостер — та же компания, что и «провайдер» у подписки, и знак у неё в каталоге есть.
      // Без этого поля строки парка молча оставались без логотипа, хотя фича заявлена «по
      // всему приложению».
      provider: d.provider,
      category: 'Infra',
      amount: d.cost.amount,
      currency: d.cost.currency,
      usd: d.cost.usd,
      period: 'mo',
      renews: null,
      source: 'live'
    }))
  const deviceName = new Map(devices.map((d) => [d.id, d.name]))
  const userRows: Row[] = subs.map((s) => ({
    id: s.id,
    name: s.name,
    provider: s.provider,
    // Имя железки в строке платежа: иначе непонятно, за что именно платим, и хочется завести
    // «ещё одну» запись — как раз то, из чего дубли и берутся.
    forDevice: s.deviceId ? deviceName.get(s.deviceId) : undefined,
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
  // Пометка «≈» нужна там, где КОНВЕРТАЦИЯ реально была. Проверять разнообразие валют
  // (`size > 1`) неверно: подписки целиком в евро — это одна валюта и всё равно пересчёт по
  // вшитому курсу. Если всё в долларах, курс ни при чём и значок только сеет сомнение.
  const currencies = all.map((x) => x.currency)
  const converted = isApprox(currencies)

  const byCat = Object.entries(
    all.reduce<Record<string, number>>((a, x) => {
      a[x.category] = (a[x.category] ?? 0) + monthlyUsd(x)
      return a
    }, {})
  )
    // Подпись — та же, что в списке. Раньше в легенду уезжал сырой ключ («AI», «Infra»), а в
    // строке рядом стояло «ИИ», «Инфраструктура» — одна сущность под двумя именами на одном экране.
    .map(([key, value]) => ({ label: catLabel(key), value, color: catColor(key) }))
    .sort((a, b) => b.value - a.value)

  const dated = all
    .map((x) => ({
      ...x,
      days: daysUntil(x.renews),
      // Кто платит. У автосписания прошедшая дата не доказывает, что платёж не прошёл.
      manual: x.userId ? (subs.find((s) => s.id === x.userId)?.manualRenewal ?? false) : true
    }))
    .filter((x): x is Row & { days: number; manual: boolean } => x.days != null)
  // Просрочка идёт ОТДЕЛЬНО от предстоящего. Раньше всё лежало в одном списке, отсортированном
  // по возрастанию, и панель «Ближайшие продления» забивалась самыми древними датами: заголовок
  // обещает будущее, а первой строкой шло «просрочено 216 дн.». Шести старых записей хватало,
  // чтобы ближайший реальный платёж не показался вовсе.
  const overdue = dated.filter((x) => x.days < 0).sort((a, b) => a.days - b.days).slice(0, 3)
  const upcoming = dated.filter((x) => x.days >= 0).sort((a, b) => a.days - b.days).slice(0, 6)

  return (
    <Page>
      <PageHeader
        title="Подписки"
        subtitle={`${all.length} ${plural(all.length, 'активная', 'активные', 'активных')}`}
      />

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
          payableDevices={devices.map((d) => ({ id: d.id, name: d.name }))}
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

      {/* Итог складывает евро, рубли и доллары по ВШИТОМУ курсу — он справочный и не
          обновляется. Без «≈» цифра читается как посчитанные деньги; соседний экран ИИ ровно
          поэтому показывает суммы по валютам раздельно. Здесь валют бывает много, поэтому
          оставляем один итог, но честно помечаем его приблизительность. */}
      <div className="grid grid-cols-3 gap-4">
        <StatTile
          label="В месяц"
          value={approxMoney(monthly, currencies)}
          hint={converted ? 'сведено по приблизительному курсу' : undefined}
        />
        <StatTile label="В год" value={approxMoney(yearly, currencies)} />
        {/* Считаем по КАТЕГОРИИ записи, а не по тому, откуда строка взялась. Раньше «инфрой»
            назывались только строки парка, и после связывания сервера с его платежом подпись
            показывала «0 инфра» при семи хостинговых подписках на экране. */}
        <StatTile
          label="Активных"
          value={String(all.length)}
          hint={`${all.filter((x) => x.category === 'Infra' || x.category === 'Hosting').length} на инфраструктуру · ${all.filter((x) => x.category !== 'Infra' && x.category !== 'Hosting').length} на сервисы`}
        />
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
                // Строка — СЕТКА, а не череда элементов подряд. Раньше бейджи («из парка»,
                // «продлять руками», срок продления) стояли между названием и суммой обычным
                // потоком, и каждая строка получала свою ширину: категория и цена гуляли по
                // горизонтали, взгляду не за что было зацепиться. Теперь колонок три —
                // название, срок, деньги, — и они выстроены у всех строк одинаково, а
                // подробности переехали под название, где им не приходится ни с чем спорить.
                <div
                  key={x.id}
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto_7rem_auto] items-center gap-3 py-2.5 text-sm"
                >
                  {/* Знак компании узнаётся быстрее строки: в списке из двадцати подписок глаз
                      находит Spotify по знаку раньше, чем прочитает название. */}
                  <BrandMark name={`${x.provider ?? ''} ${x.name}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-slate-200">{x.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span className="shrink-0">{catLabel(x.category)}</span>
                      {/* За какую железку платим. Это же единственный видимый след того, что
                          приложение связало сервер с его платежом: без имени строка выглядит
                          так, будто цена сервера просто пропала. */}
                      {x.forDevice && <span className="shrink-0 text-slate-400">· за {x.forDevice}</span>}
                      {stored?.provider && <span className="truncate">· {stored.provider}</span>}
                      {stored?.manualRenewal && (
                        <span
                          className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] text-amber-400"
                          title="Автосписания нет — продление надо оплатить самому"
                        >
                          продлять руками
                        </span>
                      )}
                    </span>
                  </span>
                  {days != null && days <= 14 ? (
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        days < 0
                          ? stored?.manualRenewal !== false
                            ? 'bg-rose-500/15 text-rose-400'
                            : 'bg-white/5 text-slate-400'
                          : 'bg-amber-500/15 text-amber-400'
                      )}
                    >
                      {renewalLabel(days, stored?.manualRenewal !== false)}
                    </span>
                  ) : (
                    <span />
                  )}
                  {/* Ноль в денежной колонке читается как «бесплатно», а у подписки, купленной на
                      стороне, цена бывает просто не внесена. Это разные вещи, и путать их нельзя:
                      из-за нуля подписка молча выпадает из месячного итога, выглядя оплаченной. */}
                  <span className="text-right tabular-nums text-slate-300">
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
                            // Якорь передаём отдельно: в самой дате после короткого месяца
                            // уже лежит зажатое число (31 января → 28 февраля), и считать от
                            // неё значит терять исходный день навсегда.
                            const nextRenewal = advanceRenewal(
                              stored.nextRenewal!,
                              stored.period,
                              Date.now(),
                              stored.renewalDay
                            )
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
                        onClick={() => {
                          // Везде в приложении необратимое удаление подтверждается, а здесь
                          // корзина срабатывала с первого клика — и кнопка ещё и невидима до
                          // наведения, то есть попасть по ней можно было мимоходом.
                          if (window.confirm(`Удалить подписку «${x.name}»? Отменить будет нельзя.`))
                            void removeSub(x.userId!)
                        }}
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
            <Donut data={byCat} center={approxMoney(monthly, currencies)} sub="/ мес" />
          </Card>
          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <CalendarClock className="h-4 w-4 text-accent" /> Ближайшие продления
            </h2>
            <ul className="space-y-2">
              {/* Просроченное — красным и сверху: это уже случилось, а не «скоро». Тем же цветом,
                  что и в списке слева: один факт не должен выглядеть двумя разными. */}
              {overdue.map((x) => (
                <li key={x.id} className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-300">{x.name}</span>
                  <span className={cn('tabular-nums', x.manual ? 'text-rose-400' : 'text-slate-400')}>
                    {renewalLabel(x.days, x.manual)}
                  </span>
                </li>
              ))}
              {upcoming.map((x) => (
                <li key={x.id} className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-300">{x.name}</span>
                  <span className={cn('tabular-nums', x.days <= 14 ? 'text-amber-400' : 'text-slate-400')}>
                    {renewalLabel(x.days)}
                  </span>
                </li>
              ))}
              {overdue.length === 0 && upcoming.length === 0 && (
                <li className="text-xs text-slate-400">Дат продления пока нет</li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  )
}
