import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { money } from '@/lib/format'
import {
  MONEY_GROUP_LABEL,
  attentionList,
  dailySeries,
  daysAgoDate,
  groupByMoney,
  monthlyCost,
  totalsFor,
  usageOwners
} from '@/lib/ai-account'
import { AccessForm } from '@/components/ai/AccessForm'
import { AccessRow } from '@/components/ai/AccessRow'
import { AccessDetail } from '@/components/ai/AccessDetail'
import { cn } from '@/lib/cn'
import { formatResetIn, windowState } from '../../../shared/ai-blocks'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess, Subscription } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined
const SPAN_DAYS = 30

/**
 * Что платится в месяц — по валютам, а не одной цифрой.
 *
 * Сводить евро и доллары по курсу здесь нельзя: курс приблизительный, а сумма выглядит точной.
 * Валют у владельца одна-две, поэтому честнее показать их рядом.
 */
function monthlyByCurrency(access: AiAccess[], subs: Subscription[]): Array<[string, number]> {
  const totals = new Map<string, number>()
  // Считаем по РАЗЛИЧНЫМ подпискам, а не по записям доступа. Один аккаунт ходит несколькими
  // каналами («Claude Max» и «Claude Code» — одна оплата), и обе записи законно ссылаются на
  // одну строку подписки: цикл по записям удваивал главную цифру экрана. Ради этого деньги и
  // вынесены в subscriptions — здесь инвариант нарушался.
  // Оформленное отделяем от задуманного: у записи со статусом planned подписка ещё не платится.
  const counted = new Set<string>()
  for (const a of access) {
    if (a.status === 'planned' || !a.subscriptionId || counted.has(a.subscriptionId)) continue
    const sub = subs.find((s) => s.id === a.subscriptionId)
    const m = monthlyCost(sub)
    if (m == null || !sub) continue
    counted.add(sub.id)
    totals.set(sub.currency, (totals.get(sub.currency) ?? 0) + m)
  }
  return [...totals.entries()].sort((x, y) => y[1] - x[1])
}

export function AIAccountsView(): React.JSX.Element {
  const access = useAi((s) => s.access)
  const checks = useAi((s) => s.checks)
  const usage = useAi((s) => s.usage)
  const blocks = useAi((s) => s.blocks)
  const quotas = useAi((s) => s.quotas)
  const loaded = useAi((s) => s.loaded)
  const loading = useAi((s) => s.loading)
  const error = useAi((s) => s.error)
  const load = useAi((s) => s.load)
  const remove = useAi((s) => s.remove)
  const subs = useSubs((s) => s.subs)
  const loadSubs = useSubs((s) => s.load)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AiAccess | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void load()
    void loadSubs()
  }, [load, loadSubs])

  const since = daysAgoDate(SPAN_DAYS - 1)

  // Расход считается один раз на источник: строк много, а источников два.
  const bySource = useMemo(() => {
    const out: Record<string, { total: number; series: number[] }> = {}
    for (const s of ['claude-code', 'codex']) {
      const rows = usage.filter((d) => d.source === s)
      out[s] = { total: totalsFor(rows, { since }).costUsd, series: dailySeries(rows, SPAN_DAYS) }
    }
    return out
  }, [usage, since])

  const burned = useMemo(() => totalsFor(usage, { since }).costUsd, [usage, since])
  const monthly = useMemo(() => monthlyByCurrency(access, subs), [access, subs])
  // Кому какой источник логов принадлежит — считается один раз на весь список: иначе один и тот
  // же расход показывался бы как свой у каждой записи провайдера.
  const owners = useMemo(() => usageOwners(access), [access])
  const sourceOf = (a: AiAccess): string | null => {
    for (const [source, id] of owners) if (id === a.id) return source
    return null
  }

  const attention = attentionList(access, checks)
  const groups = groupByMoney(access, subs)
  // Неоформленные не считаются доступами: «14 доступов», из которых четырёх не существует, —
  // это ложь инвентаря.
  const owned = access.filter((a) => a.status !== 'planned')
  const available = access.length - owned.length

  // Окно лимита самой дорогой подписки — единственное число на экране, которое меняется в
  // течение дня. Ради него сюда и заходят посреди работы.
  const mainWindow = (() => {
    const paid = owned
      .filter((a) => a.subscriptionId)
      .sort((x, y) => (monthlyCost(subs.find((s) => s.id === y.subscriptionId)) ?? 0) - (monthlyCost(subs.find((s) => s.id === x.subscriptionId)) ?? 0))[0]
    if (!paid) return null

    // Цифра провайдера бьёт нашу всегда: она считает расход АККАУНТА, включая телефон и второй
    // ноутбук, а локальные логи знают только эту машину.
    const slices = quotas[paid.id] ?? []
    const session = slices.find((s) => s.scope === 'session')
    const week = slices.find((s) => s.scope === 'week')
    if (session?.ratio != null) {
      return {
        label: paid.label,
        used: session.ratio,
        exact: true,
        resetsInMs: session.resetsAt ? session.resetsAt - Date.now() : null,
        week: week?.ratio ?? null
      }
    }

    const src = sourceOf(paid)
    if (!src) return null
    const state = windowState(blocks.filter((b) => b.source === src), paid.limits.windowTokens)
    return state
      ? { label: paid.label, used: state.used, exact: false, resetsInMs: state.resetsInMs, week: null }
      : null
  })()

  // Выбор держится за идентификатором: запись могла обновиться или исчезнуть.
  const selected = access.find((a) => a.id === selectedId) ?? null
  // Первая ВИДИМАЯ строка, а не первая в данных: список сгруппирован по типам, и порядок
  // хранения с ним не совпадает — иначе справа открывается не то, что подсвечено слева.
  const firstVisible = groups[0]?.items[0]?.id ?? null
  useEffect(() => {
    if (!firstVisible) return
    if (!selectedId || !access.some((a) => a.id === selectedId)) setSelectedId(firstVisible)
  }, [access, selectedId, firstVisible])

  return (
    <div className="flex h-full flex-col">
      {/* Сводка одной строкой. Раньше тут стояли четыре плитки с крупными числами — они занимали
          пятую часть экрана и повторяли то, что и так видно в списке. */}
      <header className="flex items-center gap-5 border-b border-border px-6 py-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-5 text-[12px]">
          {/* Окно идёт первым: это единственное число здесь, которое меняется в течение часа, а
              заходят сюда посреди работы — узнать, упрусь ли сейчас в лимит. Плата за месяц
              меняется раз в месяц и ждёт своей очереди. */}
          {mainWindow && (
            <span className="flex items-baseline gap-2 text-slate-500">
              <span className="truncate text-slate-300">{mainWindow.label}</span>
              {mainWindow.used != null && (
                <>
                  <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-border align-middle">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        mainWindow.used >= 1 ? 'bg-rose-500' : mainWindow.used >= 0.8 ? 'bg-amber-400' : 'bg-accent',
                        mainWindow.exact ? '' : 'opacity-50'
                      )}
                      style={{ width: `${Math.max(3, Math.min(1, mainWindow.used) * 100)}%` }}
                    />
                  </span>
                  <span className="tabular-nums text-slate-200">
                    {mainWindow.exact ? '' : '≈'}
                    {Math.round(mainWindow.used * 100)}%
                  </span>
                </>
              )}
              {mainWindow.resetsInMs != null && mainWindow.resetsInMs > 0 && (
                <span className="text-slate-400">сброс {formatResetIn(mainWindow.resetsInMs)}</span>
              )}
              {mainWindow.week != null && (
                <span className="text-slate-400">
                  · неделя <span className="tabular-nums text-slate-400">{Math.round(mainWindow.week * 100)}%</span>
                </span>
              )}
            </span>
          )}

          <span className="text-slate-500">
            Плачу{' '}
            {monthly.length === 0 ? (
              <span className="text-slate-300">ничего</span>
            ) : (
              monthly.map(([cur, sum], i) => (
                <span key={cur} className="tabular-nums text-slate-200">
                  {i > 0 && <span className="text-slate-400"> + </span>}
                  {money(sum, cur)}
                </span>
              ))
            )}
            <span className="text-slate-400"> в месяц</span>
          </span>

          <span className="text-slate-500">
            {/* Сослагательное наклонение не случайно: «сожжено» читается как списанные деньги,
                а по подписке это лишь оценка того, во что обошёлся бы тот же объём. */}
            За 30 дней сжёг бы{' '}
            <span className="tabular-nums text-slate-200">{burned > 0 ? `≈${money(burned)}` : '—'}</span>
            <span className="text-slate-400"> по ценам API</span>
          </span>

          <span className="text-slate-500">
            <span className="tabular-nums text-slate-200">{loaded ? owned.length : '—'}</span> доступов
            {available > 0 && <span className="text-slate-400"> · {available} можно взять</span>}
          </span>

        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => {
              setEditing(null)
              setAdding(true)
            }}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" /> Доступ
          </button>
        </div>
      </header>

      {attention.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-500/15 bg-amber-500/[0.05] px-6 py-2">
          {attention.slice(0, 4).map((a) => (
            <button
              key={a.text}
              onClick={() => setSelectedId(a.accessId)}
              className={cn(
                'text-[12px] transition-colors hover:underline',
                a.severity === 'critical' ? 'text-rose-300' : 'text-amber-300/90'
              )}
            >
              {a.text}
            </button>
          ))}
          {attention.length > 4 && (
            <span className="text-[11px] text-slate-400">и ещё {attention.length - 4}</span>
          )}
        </div>
      )}

      {!api && (
        <p className="border-b border-border bg-surface/60 px-6 py-2 text-[11px] text-slate-400">
        </p>
      )}
      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-rose-500/20 bg-rose-500/[0.06] px-6 py-2 text-[11px] text-rose-300" role="alert">
          <span>{error}</span>
          <button onClick={() => void load(true)} disabled={loading} className="rounded px-2 py-0.5 font-medium hover:bg-white/5 disabled:opacity-50">
            Повторить
          </button>
        </div>
      )}

      {(adding || editing) && (
        <div className="border-b border-border px-6 py-4">
          {/* key даёт форме идентичность цели правки. Без него переход «правлю A → правлю B»
              не перемонтирует компонент: React видит тот же элемент, состояние остаётся от A,
              и «Сохранить» отправляет значения A под идентификатором B. */}
          <AccessForm
            key={editing?.id ?? 'new'}
            initial={editing}
            onClose={() => {
              setAdding(false)
              setEditing(null)
            }}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-[22rem] shrink-0 overflow-y-auto border-r border-border py-2">
          {!loaded || loading ? (
            <p className="flex items-center justify-center gap-2 py-16 text-[12px] text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Загружаю доступы…
            </p>
          ) : access.length === 0 ? (
            <button
              onClick={() => setAdding(true)}
              className="mx-6 my-8 block w-[calc(100%-3rem)] rounded border border-dashed border-border py-14 text-center text-[12px] text-slate-400 transition-colors hover:border-accent/40 hover:text-slate-200"
            >
              Доступов нет — добавь первый
            </button>
          ) : (
            groups.map((group) => (
              <section key={group.group} className="mb-1">
                <h2 className="flex items-baseline justify-between gap-2 px-6 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
                  <span>{MONEY_GROUP_LABEL[group.group]}</span>
                </h2>
                {group.items.map((a) => {
                  const src = sourceOf(a)
                  return (
                    <AccessRow
                      key={a.id}
                      access={a}
                      check={checks[a.id]}
                      sub={subs.find((s) => s.id === a.subscriptionId)}
                      series={src ? (bySource[src]?.series ?? []) : []}
                      spent={src ? (bySource[src]?.total ?? 0) : 0}
                      selected={a.id === selectedId}
                      onSelect={() => setSelectedId(a.id)}
                    />
                  )
                })}
              </section>
            ))
          )}
        </div>

        <aside className="min-w-0 flex-1 bg-surface/20">
          {selected ? (
            <AccessDetail
              key={selected.id}
              access={selected}
              onEdit={() => {
                setEditing(selected)
                setAdding(false)
              }}
              onDelete={() => {
                if (window.confirm(`Удалить доступ «${selected.label}»?`)) void remove(selected.id)
              }}
            />
          ) : (
            <p className="px-6 py-8 text-[12px] text-slate-400">Выбери доступ слева.</p>
          )}
        </aside>
      </div>
    </div>
  )
}
