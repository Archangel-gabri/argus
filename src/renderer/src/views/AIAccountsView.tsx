import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, KeyRound, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Page, PageHeader, StatTile, Card, LimitNote } from '@/components/ui/Page'
import { money } from '@/lib/format'
import { useAi } from '@/store/ai'
import type { AiCheck } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'gemini', 'groq', 'xai', 'other'] as const

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

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
        <CheckCircle2 className="h-3.5 w-3.5" /> key valid
      </span>
    )
  if (check.status === 'quota')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" /> квота
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-xs text-rose-400">
      <XCircle className="h-3.5 w-3.5" /> {check.status === 'error' ? 'ошибка' : 'invalid'}
    </span>
  )
}

function AddForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const add = useAi((s) => s.add)
  const [provider, setProvider] = useState<string>('openrouter')
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [plan, setPlan] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    await add({ provider, label: label.trim() || undefined, apiKey: key.trim() || undefined, plan: plan.trim() || undefined })
    setBusy(false)
    onClose()
  }

  return (
    <Card className="mb-5">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Провайдер</span>
          <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Название</span>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Personal" />
        </label>
        <label className="col-span-2 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">API-ключ</span>
          <input
            className={inputCls}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-… (шифруется в vault, наружу не выходит)"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">План</span>
          <input className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Pro / pay-as-you-go" />
        </label>
        <div className="flex items-end justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Добавить
          </button>
        </div>
      </form>
    </Card>
  )
}

export function AIAccountsView(): React.JSX.Element {
  const accounts = useAi((s) => s.accounts)
  const checks = useAi((s) => s.checks)
  const checking = useAi((s) => s.checking)
  const load = useAi((s) => s.load)
  const check = useAi((s) => s.check)
  const remove = useAi((s) => s.remove)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    load()
  }, [load])

  const validCount = accounts.filter((a) => checks[a.id]?.status === 'valid').length
  const totalCredit = accounts.reduce((s, a) => s + (checks[a.id]?.remaining ?? 0), 0)

  return (
    <Page>
      <PageHeader
        title="AI"
        subtitle="ключи, планы, квоты"
        action={
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-bold text-bg hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> Аккаунт
          </button>
        }
      />
      <LimitNote>
        Честно: <b className="text-slate-200">OpenRouter</b> отдаёт остаток и usage по API. Для
        Anthropic / OpenAI / Gemini доступна только <b className="text-slate-200">проверка валидности
        ключа</b>; статус подписки и точный spend — вручную или Admin-ключами (этап C).
      </LimitNote>

      {!api && (
        <div className="mb-4 rounded-lg border border-border bg-surface/60 p-3 text-xs text-slate-500">
          Browser-preview: аккаунты и проверки доступны только в десктоп-приложении.
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Аккаунтов" value={String(accounts.length)} />
        <StatTile label="Ключи валидны" value={`${validCount}/${accounts.length}`} hint="по последней проверке" />
        <StatTile label="Live credit" value={money(totalCredit)} hint="OpenRouter" />
      </div>

      <div className="mt-6">
        {adding && <AddForm onClose={() => setAdding(false)} />}

        {accounts.length === 0 ? (
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500 transition-colors hover:border-accent/40 hover:text-slate-300"
          >
            Нет аккаунтов — добавь первый ключ (OpenRouter — якорь).
          </button>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {accounts.map((a) => {
              const c = checks[a.id]
              return (
                <Card key={a.id}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold uppercase text-accent">
                      {a.provider.slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold text-white">{a.label}</span>
                        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                          {a.provider}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Plan: <span className="text-slate-300">{a.plan || '—'}</span>
                      </div>
                    </div>
                    <Verdict check={c} hasKey={a.hasKey} />
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-lg bg-bg/40 p-3">
                      <div className="text-[11px] text-slate-500">Credit left</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                        {c?.remaining != null ? money(c.remaining) : '—'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-bg/40 p-3">
                      <div className="text-[11px] text-slate-500">Usage</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                        {c?.usage != null ? money(c.usage) : '—'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <button
                      onClick={() => check(a.id)}
                      disabled={!a.hasKey || checking[a.id]}
                      className="flex items-center gap-1.5 rounded-lg bg-card px-2.5 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
                    >
                      {checking[a.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      Проверить
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Удалить аккаунт «${a.label}»?`)) remove(a.id)
                      }}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
                      title="Удалить"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {a.notes && <div className="mt-3 text-[11px] text-slate-500">ⓘ {a.notes}</div>}
                  {c?.detail && <div className="mt-2 text-[11px] text-slate-600">{c.detail}</div>}
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </Page>
  )
}
