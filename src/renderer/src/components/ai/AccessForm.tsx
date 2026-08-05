import { useState, type FormEvent } from 'react'
import { Loader2, X } from 'lucide-react'
import { Card } from '@/components/ui/Page'
import { providerChangeError, KIND_LABEL, KIND_ORDER, PAYMENT_LABEL, STATUS_LABEL } from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess, AiAccountEntry, AiKind, AiLimits, AiPayment, AiStatus } from '@/types'

const PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'openrouter',
  'groq',
  'xai',
  'mistral',
  'cerebras',
  'nvidia_nim',
  'modelscope',
  'ollama',
  'tavily',
  'exa',
  'firecrawl',
  'github',
  'other'
] as const

// Идентификатор провайдера ХРАНИТСЯ в записи и уходит в main (по нему выбирается проба ключа),
// поэтому в значениях он остаётся как есть; читаемое имя — отдельной картой.
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  xai: 'xAI',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  nvidia_nim: 'NVIDIA NIM',
  modelscope: 'ModelScope',
  ollama: 'Ollama',
  tavily: 'Tavily',
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  github: 'GitHub',
  other: 'Другой'
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

const labelCls = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500'

function Field({
  label,
  hint,
  span,
  children
}: {
  label: string
  hint?: string
  span?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className={span ? 'col-span-2 block' : 'block'}>
      <span className={labelCls}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  )
}

/** Число из поля ввода: пустая строка — это «не знаю», а не ноль. */
function numOrNull(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function AccessForm({ initial, onClose }: { initial?: AiAccess | null; onClose: () => void }): React.JSX.Element {
  const add = useAi((s) => s.add)
  const update = useAi((s) => s.update)
  const subs = useSubs((s) => s.subs)

  const [kind, setKind] = useState<AiKind>(initial?.kind ?? 'api')
  const [provider, setProvider] = useState<string>(initial?.provider ?? 'openrouter')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [account, setAccount] = useState(initial?.account ?? '')
  const [plan, setPlan] = useState(initial?.plan ?? '')
  const [status, setStatus] = useState<AiStatus>(initial?.status ?? 'active')
  const [payment, setPayment] = useState<AiPayment>(initial?.payment ?? 'card')
  const [key, setKey] = useState('')
  const [keyRef, setKeyRef] = useState(initial?.keyRef ?? '')
  const [keyExpiresAt, setKeyExpiresAt] = useState(initial?.keyExpiresAt ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [thirdParty, setThirdParty] = useState(initial?.thirdParty ?? false)
  const [usedBy, setUsedBy] = useState((initial?.usedBy ?? []).join(', '))
  const [subscriptionId, setSubscriptionId] = useState(initial?.subscriptionId ?? '')
  const [rpm, setRpm] = useState(initial?.limits?.rpm != null ? String(initial.limits.rpm) : '')
  const [rpd, setRpd] = useState(initial?.limits?.rpd != null ? String(initial.limits.rpd) : '')
  const [windowHours, setWindowHours] = useState(
    initial?.limits?.windowHours != null ? String(initial.limits.windowHours) : ''
  )
  const [windowTokens, setWindowTokens] = useState(
    initial?.limits?.windowTokens != null ? String(initial.limits.windowTokens) : ''
  )
  const [accounts, setAccounts] = useState<AiAccountEntry[]>(initial?.accounts ?? [])
  const [notes, setNotes] = useState(initial?.notes ?? '')

  /** Правка одного аккаунта в списке. Список короткий — переписываем целиком, это дешевле логики. */
  const patchAccount = (index: number, patch: Partial<AiAccountEntry>): void =>
    setAccounts(accounts.map((a, i) => (i === index ? { ...a, ...patch } : a)))
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    if (initial) {
      const providerError = providerChangeError(initial.provider, provider, key)
      if (providerError) {
        setFormError(providerError)
        return
      }
    }
    setBusy(true)
    try {
      const limits: AiLimits = {
        rpm: numOrNull(rpm),
        rpd: numOrNull(rpd),
        windowHours: numOrNull(windowHours),
        windowTokens: numOrNull(windowTokens)
      }
      const input = {
        kind,
        provider,
        label: label.trim() || undefined,
        account: account.trim(),
        plan: plan.trim(),
        status,
        payment,
        apiKey: key.trim() || undefined,
        keyRef: keyRef.trim() || null,
        keyExpiresAt: keyExpiresAt.trim() || null,
        baseUrl: baseUrl.trim() || null,
        thirdParty,
        usedBy: usedBy
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        subscriptionId: subscriptionId || null,
        // Пустые строки не сохраняем: пустой аккаунт в списке — это забытая правка, а не факт.
        accounts: accounts
          .filter((a) => a.email.trim())
          .map((a) => ({
            email: a.email.trim(),
            plan: a.plan?.trim() || undefined,
            note: a.note?.trim() || undefined,
            primary: a.primary
          })),
        limits,
        notes: notes.trim() || null
      }
      const ok = initial ? await update(initial.id, input) : await add(input)
      if (ok) onClose()
      else setFormError(useAi.getState().error ?? 'Не удалось сохранить доступ')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось сохранить доступ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-5">
      <form
        onSubmit={(e) => {
          void submit(e)
        }}
        className="grid grid-cols-2 gap-3"
      >
        <Field label="Тип">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as AiKind)}>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Провайдер">
          <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p] ?? p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Название">
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Max 20x" />
        </Field>
        <Field label="Аккаунт / почта" hint="на что оформлено — чтобы не путать одинаковые подписки">
          <input className={inputCls} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="me@example.com" />
        </Field>
        <Field label="План">
          <input className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Max 20x / pay-as-you-go" />
        </Field>
        <Field label="Состояние">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as AiStatus)}>
            {(Object.keys(STATUS_LABEL) as AiStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="API-ключ" span>
          <input
            className={inputCls}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={initial ? 'пусто — не менять' : 'sk-…'}
          />
        </Field>
        <Field label="Где ещё лежит ключ" hint="указатель, а не значение">
          <input
            className={inputCls}
            value={keyRef}
            onChange={(e) => setKeyRef(e.target.value)}
            placeholder="secrets/env/api-keys.env → OPENROUTER_API_KEY"
          />
        </Field>
        <Field label="Ключ истекает" hint="для PAT и временных токенов">
          <input className={inputCls} type="date" value={keyExpiresAt} onChange={(e) => setKeyExpiresAt(e.target.value)} />
        </Field>

        <Field label="Оплата">
          <select className={inputCls} value={payment} onChange={(e) => setPayment(e.target.value as AiPayment)}>
            {(Object.keys(PAYMENT_LABEL) as AiPayment[]).map((p) => (
              <option key={p} value={p}>
                {PAYMENT_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Подписка (деньги)" hint="сумма и продление живут в разделе «Подписки»">
          <select className={inputCls} value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}>
            <option value="">— не связано —</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.amount} {s.currency}/{s.period === 'yr' ? 'год' : 'мес'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Адрес API" hint="для роутеров и локальных моделей">
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </Field>
        <Field label="Кто пользуется" hint="через запятую">
          <input className={inputCls} value={usedBy} onChange={(e) => setUsedBy(e.target.value)} placeholder="Claude Code, gen-image.sh" />
        </Field>

        <Field label="Запросов в минуту">
          <input className={inputCls} value={rpm} onChange={(e) => setRpm(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
        <Field label="Запросов в сутки">
          <input className={inputCls} value={rpd} onChange={(e) => setRpd(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
        <Field label="Окно лимита, часов" hint="у подписок обычно 5">
          <input
            className={inputCls}
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
            inputMode="numeric"
            placeholder="—"
          />
        </Field>
        <Field label="Токенов в окне" hint="твоя наблюдаемая оценка — провайдер её не публикует">
          <input
            className={inputCls}
            value={windowTokens}
            onChange={(e) => setWindowTokens(e.target.value)}
            inputMode="numeric"
            placeholder="—"
          />
        </Field>

        <div className="col-span-2">
          <span className={labelCls}>Другие аккаунты того же провайдера</span>
          {accounts.map((a, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-2">
              <input
                className={inputCls}
                value={a.email}
                onChange={(e) => patchAccount(i, { email: e.target.value })}
                placeholder="почта или логин"
              />
              <input
                className={`${inputCls} max-w-[11rem]`}
                value={a.plan ?? ''}
                onChange={(e) => patchAccount(i, { plan: e.target.value })}
                placeholder="тариф"
              />
              <input
                className={`${inputCls} max-w-[13rem]`}
                value={a.note ?? ''}
                onChange={(e) => patchAccount(i, { note: e.target.value })}
                placeholder="для чего"
              />
              <button
                type="button"
                onClick={() => setAccounts(accounts.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-2 text-slate-400 hover:bg-rose-500/10 hover:text-rose-400"
                title="Убрать аккаунт"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setAccounts([...accounts, { email: '' }])}
            className="mt-0.5 rounded px-2 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-border hover:bg-card-hover hover:text-slate-200"
          >
            + аккаунт
          </button>
          <span className="mt-1 block text-[11px] text-slate-400">
            Тариф у каждого свой — так видно, на какой почте лежит платная подписка.
          </span>
        </div>

        <Field label="Заметки" span>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <label className="col-span-2 flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={thirdParty} onChange={(e) => setThirdParty(e.target.checked)} className="accent-amber-500" />
          Запросы идут через посредника — всё, что отправлено, видит третья сторона
        </label>

        <div className="col-span-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {initial ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
        {formError && (
          <div className="col-span-2 text-xs text-rose-400" role="alert">
            {formError}
          </div>
        )}
      </form>
    </Card>
  )
}
