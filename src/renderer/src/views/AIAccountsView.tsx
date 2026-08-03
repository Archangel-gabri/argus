import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle
} from 'lucide-react'
import { Page, PageHeader, StatTile, Card } from '@/components/ui/Page'
import { Sparkline } from '@/components/ui/Sparkline'
import { money } from '@/lib/format'
import {
  KIND_LABEL,
  STATUS_LABEL,
  aiSummary,
  byModel,
  daysAgoDate,
  dailySeries,
  daysUntilExpiry,
  groupByKind,
  monthlyCost,
  needsAttention,
  totalsFor
} from '@/lib/ai-account'
import { AccessForm } from '@/components/ai/AccessForm'
import { AccessDrawer } from '@/components/ai/AccessDrawer'
import { CostCalculator } from '@/components/ai/CostCalculator'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess, AiCheck, Subscription } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

function Verdict({ check, hasKey }: { check?: AiCheck; hasKey: boolean }): React.JSX.Element {
  if (!hasKey)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <KeyRound className="h-3.5 w-3.5" /> нет ключа
      </span>
    )
  if (!check) return <span className="text-xs text-slate-500">не проверялся</span>
  if (check.status === 'valid')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> ключ рабочий
      </span>
    )
  if (check.status === 'quota')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" /> квота
      </span>
    )
  if (check.status === 'error' && check.detail?.startsWith('Автопроверка'))
    return <span className="text-xs text-slate-500">не проверяется</span>
  if (check.status === 'error' && check.detail?.startsWith('Сеть:'))
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" /> сеть
      </span>
    )
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${check.status === 'error' ? 'text-slate-500' : 'text-rose-400'}`}>
      <XCircle className="h-3.5 w-3.5" /> {check.status === 'error' ? 'неизвестно' : 'неверный'}
    </span>
  )
}

/** Строка о деньгах в карточке: связанная подписка или честное «бесплатно / не привязано». */
function MoneyLine({ access, sub }: { access: AiAccess; sub?: Subscription }): React.JSX.Element {
  if (sub) {
    const monthly = monthlyCost(sub)
    return (
      <span className="text-slate-300">
        {money(sub.amount, sub.currency)}/{sub.period === 'yr' ? 'год' : 'мес'}
        {sub.period === 'yr' && monthly != null && (
          <span className="text-slate-600"> · {money(Math.round(monthly))}/мес</span>
        )}
        {sub.nextRenewal && <span className="text-slate-600"> · до {sub.nextRenewal}</span>}
      </span>
    )
  }
  if (access.payment === 'free') return <span className="text-slate-500">бесплатно</span>
  return <span className="text-slate-600">подписка не привязана</span>
}

function AccessCard({
  access,
  check,
  spent,
  series,
  sub,
  onOpen,
  onEdit,
  onDelete
}: {
  access: AiAccess
  check?: AiCheck
  spent: number | null
  series: number[]
  sub?: Subscription
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const expiresIn = daysUntilExpiry(access.keyExpiresAt)
  return (
    <Card className="cursor-pointer transition-colors hover:border-accent/30">
      <div onClick={onOpen} className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold uppercase text-accent">
          {access.provider.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-white">{access.label}</span>
            {access.status !== 'active' && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                {STATUS_LABEL[access.status]}
              </span>
            )}
            {access.thirdParty && (
              <span title="Запросы идут через посредника">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {access.account || access.provider}
            {access.plan ? ` · ${access.plan}` : ''}
          </div>
        </div>
        <Verdict check={check} hasKey={access.hasKey} />
      </div>

      <div onClick={onOpen} className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-bg/40 p-3">
          <div className="text-[11px] text-slate-500">Стоит</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">
            <MoneyLine access={access} sub={sub} />
          </div>
        </div>
        <div className="rounded-lg bg-bg/40 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-500">Сожжено за 30 дн.</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {spent == null ? '—' : money(Math.round(spent * 100) / 100)}
              </div>
            </div>
            {series.some((v) => v > 0) && <Sparkline data={series} />}
          </div>
        </div>
      </div>

      {expiresIn !== null && expiresIn <= 30 && (
        <div className="mt-3 text-[11px] text-amber-400">
          {expiresIn < 0 ? `Ключ истёк ${-expiresIn} дн. назад` : `Ключ истекает через ${expiresIn} дн.`}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <button onClick={onOpen} className="text-xs font-medium text-slate-400 hover:text-accent">
          Подробно →
        </button>
        <div className="flex items-center gap-1">
          <button onClick={onEdit} className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-accent" title="Редактировать">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
            title="Удалить"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Card>
  )
}

export function AIAccountsView(): React.JSX.Element {
  const access = useAi((s) => s.access)
  const checks = useAi((s) => s.checks)
  const usage = useAi((s) => s.usage)
  const prices = useAi((s) => s.prices)
  const loaded = useAi((s) => s.loaded)
  const loading = useAi((s) => s.loading)
  const collecting = useAi((s) => s.collecting)
  const error = useAi((s) => s.error)
  const load = useAi((s) => s.load)
  const collect = useAi((s) => s.collect)
  const remove = useAi((s) => s.remove)
  const subs = useSubs((s) => s.subs)
  const loadSubs = useSubs((s) => s.load)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AiAccess | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)

  useEffect(() => {
    void load()
    void loadSubs()
  }, [load, loadSubs])

  const summary = aiSummary(access, checks)
  const since = daysAgoDate(29)

  // Расход за 30 дней и месячные деньги считаются один раз на весь экран: карточек немного,
  // но каждая иначе перебирала бы весь массив дней.
  const spentBySource = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of ['claude-code', 'codex']) out[s] = totalsFor(usage, { since, source: s }).costUsd
    return out
  }, [usage, since])

  const seriesBySource = useMemo(() => {
    const out: Record<string, number[]> = {}
    for (const s of ['claude-code', 'codex']) out[s] = dailySeries(usage.filter((d) => d.source === s), 30)
    return out
  }, [usage])

  const sourceOf = (a: AiAccess): string | null => {
    if (a.usedBy.some((u) => u.toLowerCase().includes('claude code'))) return 'claude-code'
    if (a.usedBy.some((u) => u.toLowerCase().includes('codex'))) return 'codex'
    if (a.provider === 'anthropic') return 'claude-code'
    if (a.provider === 'openai') return 'codex'
    return null
  }

  const monthlyTotal = useMemo(() => {
    // Только реальные деньги: доступы без привязанной подписки в сумму не входят, иначе
    // «сколько я плачу за ИИ» превратилось бы в оценку.
    let sum = 0
    for (const a of access) {
      const sub = subs.find((s) => s.id === a.subscriptionId)
      const m = monthlyCost(sub)
      if (m != null) sum += m
    }
    return sum
  }, [access, subs])

  const burned30 = useMemo(() => totalsFor(usage, { since }).costUsd, [usage, since])
  const attention = needsAttention(access, checks)
  const groups = groupByKind(access)
  const openedAccess = access.find((a) => a.id === opened) ?? null
  const topModels = useMemo(() => byModel(usage, since).slice(0, 3), [usage, since])

  return (
    <Page>
      <PageHeader
        title="AI"
        subtitle="доступы, модели, цены и расход"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCalcOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover"
            >
              <Calculator className="h-4 w-4" /> Калькулятор
            </button>
            <button
              onClick={() => void collect()}
              disabled={collecting}
              className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
            >
              {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Пересчитать расход
            </button>
            <button
              onClick={() => {
                setEditing(null)
                setAdding((v) => !v)
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-bold text-bg hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> Доступ
            </button>
          </div>
        }
      />
      {!api && (
        <div className="mb-4 rounded-lg border border-border bg-surface/60 p-3 text-xs text-slate-500">
          Доступно только в приложении.
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Доступов" value={loaded ? String(access.length) : '—'} hint={`${groups.length} типов`} />
        <StatTile
          label="Плачу в месяц"
          value={loaded ? money(Math.round(monthlyTotal)) : '—'}
          hint="только привязанные подписки"
        />
        <StatTile
          label="Сожжено за 30 дн."
          value={burned30 > 0 ? money(Math.round(burned30)) : '—'}
          hint="эквивалент по ценам API"
        />
        <StatTile
          label="Требуют внимания"
          value={loaded ? String(attention.length) : '—'}
          hint={summary.workingKeys ? `ключи: ${summary.workingKeys}` : 'ключи не проверены'}
        />
      </div>

      {calcOpen && (
        <div className="mt-5">
          <CostCalculator prices={prices} />
        </div>
      )}

      {topModels.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card/40 px-4 py-2.5 text-xs text-slate-500">
          <span className="font-medium text-slate-400">Больше всего за 30 дней:</span>
          {topModels.map((m) => (
            <span key={`${m.source}/${m.model}`}>
              {m.model} <span className="tabular-nums text-slate-300">{money(Math.round(m.costUsd * 100) / 100)}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-6">
        {error && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-xs text-rose-300" role="alert">
            <span>{error}</span>
            <button onClick={() => void load(true)} disabled={loading} className="rounded-md px-2 py-1 font-medium hover:bg-white/5 disabled:opacity-50">
              Повторить
            </button>
          </div>
        )}

        {/* key даёт форме идентичность цели правки. Без него переход «карандаш у A →
            карандаш у B» не перемонтирует компонент: React видит тот же элемент,
            useState сохраняет значения формы A, а «Сохранить» отправляет их с
            идентификатором B — то есть молча подменяет чужую запись. */}
        {(adding || editing) && (
          <AccessForm
            key={editing?.id ?? 'new'}
            initial={editing}
            onClose={() => {
              setAdding(false)
              setEditing(null)
            }}
          />
        )}

        {!loaded && error ? (
          <div className="w-full rounded-xl border border-rose-500/20 py-16 text-center text-sm text-slate-500">
            Список доступов не загружен
          </div>
        ) : !loaded || loading ? (
          <div className="flex w-full items-center justify-center gap-2 rounded-xl border border-border py-16 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Загружаю доступы…
          </div>
        ) : access.length === 0 ? (
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500 transition-colors hover:border-accent/40 hover:text-slate-300"
          >
            Доступов нет — добавь первый
          </button>
        ) : (
          <div className="space-y-8">
            {groups.map((group) => (
              <section key={group.kind}>
                <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {KIND_LABEL[group.kind]} <span className="text-slate-600">· {group.items.length}</span>
                </h2>
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {group.items.map((a) => {
                    const source = sourceOf(a)
                    return (
                      <AccessCard
                        key={a.id}
                        access={a}
                        check={checks[a.id]}
                        spent={source ? (spentBySource[source] ?? null) : null}
                        series={source ? (seriesBySource[source] ?? []) : []}
                        sub={subs.find((s) => s.id === a.subscriptionId)}
                        onOpen={() => setOpened(a.id)}
                        onEdit={() => {
                          setEditing(a)
                          setAdding(false)
                        }}
                        onDelete={() => {
                          if (window.confirm(`Удалить доступ «${a.label}»?`)) void remove(a.id)
                        }}
                      />
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {openedAccess && <AccessDrawer access={openedAccess} onClose={() => setOpened(null)} />}
    </Page>
  )
}
