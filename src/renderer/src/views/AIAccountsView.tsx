import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react'
import { money } from '@/lib/format'
import {
  KIND_LABEL,
  aiSummary,
  dailySeries,
  daysAgoDate,
  groupByKind,
  monthlyCost,
  needsAttention,
  totalsFor
} from '@/lib/ai-account'
import { AccessForm } from '@/components/ai/AccessForm'
import { AccessRow } from '@/components/ai/AccessRow'
import { AccessPanel } from '@/components/ai/AccessPanel'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess, Subscription } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined
const SPAN_DAYS = 30

/** Инструмент, чьи локальные логи относятся к этому доступу. Больше ниоткуда расход не берётся. */
function sourceOf(a: AiAccess): string | null {
  if (a.usedBy.some((u) => u.toLowerCase().includes('claude code'))) return 'claude-code'
  if (a.usedBy.some((u) => u.toLowerCase().includes('codex'))) return 'codex'
  if (a.provider === 'anthropic') return 'claude-code'
  if (a.provider === 'openai') return 'codex'
  return null
}

/**
 * Что платится в месяц — по валютам, а не одной цифрой.
 *
 * Сводить евро и доллары по курсу здесь нельзя: курс приблизительный, а сумма выглядит точной.
 * Валют у владельца одна-две, поэтому честнее показать их рядом.
 */
function monthlyByCurrency(access: AiAccess[], subs: Subscription[]): Array<[string, number]> {
  const totals = new Map<string, number>()
  for (const a of access) {
    const sub = subs.find((s) => s.id === a.subscriptionId)
    const m = monthlyCost(sub)
    if (m == null || !sub) continue
    totals.set(sub.currency, (totals.get(sub.currency) ?? 0) + m)
  }
  return [...totals.entries()].sort((x, y) => y[1] - x[1])
}

export function AIAccountsView(): React.JSX.Element {
  const access = useAi((s) => s.access)
  const checks = useAi((s) => s.checks)
  const usage = useAi((s) => s.usage)
  const loaded = useAi((s) => s.loaded)
  const loading = useAi((s) => s.loading)
  const collecting = useAi((s) => s.collecting)
  const error = useAi((s) => s.error)
  const load = useAi((s) => s.load)
  const collect = useAi((s) => s.collect)
  const importAll = useAi((s) => s.importPasswordsAll)
  const remove = useAi((s) => s.remove)
  const subs = useSubs((s) => s.subs)
  const loadSubs = useSubs((s) => s.load)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AiAccess | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

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
  const attention = needsAttention(access, checks)
  const groups = groupByKind(access)
  const summary = aiSummary(access, checks)

  // Выбор держится за идентификатором: запись могла обновиться или исчезнуть.
  const selected = access.find((a) => a.id === selectedId) ?? null
  useEffect(() => {
    if (!selectedId && access.length > 0) setSelectedId(access[0].id)
    if (selectedId && access.length > 0 && !access.some((a) => a.id === selectedId)) setSelectedId(access[0].id)
  }, [access, selectedId])

  return (
    <div className="flex h-full flex-col">
      {/* Сводка одной строкой. Раньше тут стояли четыре плитки с крупными числами — они занимали
          пятую часть экрана и повторяли то, что и так видно в списке. */}
      <header className="flex items-center gap-5 border-b border-border px-6 py-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-5 text-[12px]">
          <span className="text-slate-500">
            Плачу{' '}
            {monthly.length === 0 ? (
              <span className="text-slate-300">ничего</span>
            ) : (
              monthly.map(([cur, sum], i) => (
                <span key={cur} className="tabular-nums text-slate-200">
                  {i > 0 && <span className="text-slate-600"> + </span>}
                  {money(Math.round(sum * 100) / 100, cur)}
                </span>
              ))
            )}
            <span className="text-slate-600"> в месяц</span>
          </span>

          <span className="text-slate-500">
            Сожжено{' '}
            <span className="tabular-nums text-slate-200">{burned > 0 ? money(Math.round(burned)) : '—'}</span>
            <span className="text-slate-600"> за 30 дней, по ценам API</span>
          </span>

          <span className="text-slate-500">
            <span className="tabular-nums text-slate-200">{loaded ? access.length : '—'}</span> доступов
            {summary.workingKeys && <span className="text-slate-600"> · ключи {summary.workingKeys}</span>}
          </span>

          {importResult && <span className="text-slate-600">{importResult}</span>}

          {attention.length > 0 && (
            <span className="text-amber-400">
              {attention.length}{' '}
              {attention.length === 1 ? 'требует внимания' : 'требуют внимания'}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Учётные записи провайдеров годами копятся в браузере — обходить доступы по одному
              значит делать работу, которую можно сделать разом. */}
          <button
            onClick={() => {
              setImporting(true)
              setImportResult(null)
              void importAll()
                .then((r) => {
                  if (r)
                    setImportResult(
                      r.imported === 0 ? 'паролей не нашлось' : `паролей ${r.imported}, новых аккаунтов ${r.added}`
                    )
                })
                .finally(() => setImporting(false))
            }}
            disabled={importing}
            title="Взять пароли аккаунтов из браузера — для всех доступов"
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] text-slate-400 ring-1 ring-border transition-colors hover:bg-card hover:text-slate-200 disabled:opacity-50"
          >
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Пароли
          </button>
          <button
            onClick={() => void collect()}
            disabled={collecting}
            title="Перечитать локальные логи Claude Code и Codex"
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] text-slate-400 ring-1 ring-border transition-colors hover:bg-card hover:text-slate-200 disabled:opacity-50"
          >
            {collecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Пересчитать
          </button>
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

      {!api && (
        <p className="border-b border-border bg-surface/60 px-6 py-2 text-[11px] text-slate-600">
          Доступно только в приложении.
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
        <div className="min-w-0 flex-1 overflow-y-auto py-2">
          {!loaded || loading ? (
            <p className="flex items-center justify-center gap-2 py-16 text-[12px] text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Загружаю доступы…
            </p>
          ) : access.length === 0 ? (
            <button
              onClick={() => setAdding(true)}
              className="mx-6 my-8 block w-[calc(100%-3rem)] rounded border border-dashed border-border py-14 text-center text-[12px] text-slate-600 transition-colors hover:border-accent/40 hover:text-slate-400"
            >
              Доступов нет — добавь первый
            </button>
          ) : (
            groups.map((group) => (
              <section key={group.kind} className="mb-1">
                <h2 className="px-6 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">
                  {KIND_LABEL[group.kind]}
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

        <aside className="hidden w-[26rem] shrink-0 border-l border-border bg-surface/40 xl:block">
          {selected ? (
            <AccessPanel
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
            <p className="px-5 py-8 text-[12px] text-slate-600">Выбери доступ слева.</p>
          )}
        </aside>
      </div>
    </div>
  )
}
