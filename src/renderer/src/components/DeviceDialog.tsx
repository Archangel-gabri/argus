import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { X, Loader2, Sparkles, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { AuthType, Currency, Status, DeviceInput, DeviceKind } from '@/types'

const CURRENCIES: Currency[] = ['USD', 'EUR', 'RUB']
const STATUSES: Status[] = ['online', 'degraded', 'offline', 'reboot', 'unknown', 'maintenance']
const KINDS: Array<{ id: DeviceKind; label: string }> = [
  { id: 'server', label: 'Сервер' },
  { id: 'pc', label: 'ПК' },
  { id: 'phone', label: 'Телефон' },
  { id: 'watch', label: 'Часы' },
  { id: 'buds', label: 'Наушники' },
  { id: 'router', label: 'Роутер' },
  { id: 'other', label: 'Другое' }
]
const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'
const api = typeof window !== 'undefined' ? window.api : undefined

interface FormFields {
  name: string
  provider: string
  kind: DeviceKind
  ip: string
  port: string
  user: string
  os: string
  country: string
  flag: string
  status: Status
  amount: string
  currency: Currency
  consoleUrl: string
  authMethod: AuthType
  password: string
  privateKey: string
  passphrase: string
  jumpId: string
}

const EMPTY: FormFields = {
  name: '', provider: '', kind: 'server', ip: '', port: '22', user: 'root', os: '', country: '', flag: '',
  status: 'online', amount: '', currency: 'USD', consoleUrl: '',
  authMethod: 'password', password: '', privateKey: '', passphrase: '', jumpId: ''
}

function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <label className={cn('block', full && 'col-span-2')}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  )
}

export function DeviceDialog(): React.JSX.Element | null {
  const dialog = useUI((s) => s.dialog)
  const close = useUI((s) => s.closeDialog)
  const create = useDevices((s) => s.create)
  const update = useDevices((s) => s.update)
  const devices = useDevices((s) => s.devices)

  const [f, setF] = useState<FormFields>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
  const keyFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setError(null)
    if (dialog.mode === 'edit') {
      const d = dialog.device
      setF({
        name: d.name, provider: d.provider, kind: d.kind, ip: d.ip, port: String(d.port), user: d.user, os: d.os,
        country: d.country, flag: d.flag, status: d.status,
        amount: d.cost.amount ? String(d.cost.amount) : '', currency: d.cost.currency,
        consoleUrl: d.consoleUrl, authMethod: d.authType === 'key' ? 'key' : 'password',
        password: '', privateKey: '', passphrase: '', jumpId: d.jumpId ?? ''
      })
    } else if (dialog.mode === 'new') {
      setF(EMPTY)
    }
  }, [dialog])

  const loadKeyFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const text = await file.text()
    setF((p) => ({ ...p, privateKey: text, authMethod: 'key' }))
  }

  if (dialog.mode === 'closed') return null
  const editing = dialog.mode === 'edit'

  const set =
    (k: keyof FormFields) =>
    (e: { target: { value: string } }): void =>
      setF((p) => ({ ...p, [k]: e.target.value }))

  const probe = async (): Promise<void> => {
    if (!api) return
    setProbing(true)
    setProbeMsg(null)
    const r = await api.ssh.probeHost({
      host: f.ip.trim(),
      port: parseInt(f.port, 10) || 22,
      user: f.user.trim() || 'root',
      password: f.authMethod === 'password' ? f.password : '',
      privateKey: f.authMethod === 'key' ? f.privateKey || undefined : undefined,
      passphrase: f.authMethod === 'key' ? f.passphrase || undefined : undefined
    })
    setProbing(false)
    if (r.ok) {
      setF((p) => ({ ...p, os: r.os || p.os, name: p.name || r.hostname || p.name, status: 'online' }))
      setProbeMsg(`✓ ${r.os ?? 'ok'} · ${r.cores ?? '?'} ядер · ${r.ramTotal ?? '?'} ГБ RAM`)
    } else {
      setProbeMsg(`✖ ${r.error ?? 'не удалось'}`)
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!f.name.trim()) {
      setError('Name is required')
      return
    }
    setBusy(true)
    setError(null)
    const input: DeviceInput = {
      name: f.name.trim(),
      provider: f.provider.trim() || 'Custom',
      kind: f.kind,
      ip: f.ip.trim(),
      port: parseInt(f.port, 10) || 22,
      user: f.user.trim() || 'root',
      os: f.os.trim(),
      country: f.country.trim(),
      flag: f.flag.trim(),
      status: f.status,
      cost: { amount: parseFloat(f.amount) || 0, currency: f.currency, usd: 0 },
      consoleUrl: f.consoleUrl.trim(),
      authType: f.authMethod,
      // Blank on edit = keep the stored secret; only send what belongs to the chosen method.
      password: f.authMethod === 'password' ? (f.password ? f.password : null) : undefined,
      privateKey: f.authMethod === 'key' ? (f.privateKey ? f.privateKey : undefined) : undefined,
      passphrase: f.authMethod === 'key' ? (f.passphrase ? f.passphrase : undefined) : undefined,
      jumpId: f.jumpId || null
    }
    const r = dialog.mode === 'edit' ? await update(dialog.device.id, input) : await create(input)
    setBusy(false)
    if (r.ok) close()
    else setError(r.error ?? 'Failed to save')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={close}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-white">{editing ? 'Edit device' : 'Add device'}</h2>
          <button
            onClick={close}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" full>
              <input className={inputCls} value={f.name} onChange={set('name')} placeholder="HubVPN · Tokyo" autoFocus />
            </Field>
            <Field label="Provider">
              <input className={inputCls} value={f.provider} onChange={set('provider')} placeholder="Hetzner" />
            </Field>
            <Field label="Тип">
              <select
                className={inputCls}
                value={f.kind}
                onChange={(e) => setF((p) => ({ ...p, kind: e.target.value as DeviceKind }))}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select className={inputCls} value={f.status} onChange={set('status')}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Host / IP">
              <input className={inputCls} value={f.ip} onChange={set('ip')} placeholder="203.0.113.10" />
            </Field>
            <Field label="Port">
              <input className={inputCls} value={f.port} onChange={set('port')} inputMode="numeric" />
            </Field>
            <Field label="SSH user">
              <input className={inputCls} value={f.user} onChange={set('user')} placeholder="root" />
            </Field>
            <Field label="OS">
              <input className={inputCls} value={f.os} onChange={set('os')} placeholder="Ubuntu 24.04" />
            </Field>
            <Field label="Country">
              <input className={inputCls} value={f.country} onChange={set('country')} placeholder="Japan" />
            </Field>
            <Field label="Flag">
              <input className={inputCls} value={f.flag} onChange={set('flag')} placeholder="🇯🇵" />
            </Field>
            <Field label="Cost / mo">
              <input className={inputCls} value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="5" />
            </Field>
            <Field label="Currency">
              <select className={inputCls} value={f.currency} onChange={set('currency')}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Hoster console URL" full>
              <input className={inputCls} value={f.consoleUrl} onChange={set('consoleUrl')} placeholder="https://…" />
            </Field>
            <Field label="Jump-host (бастион)" full>
              <select className={inputCls} value={f.jumpId} onChange={set('jumpId')}>
                <option value="">— нет —</option>
                {devices
                  .filter((d) => dialog.mode !== 'edit' || d.id !== dialog.device.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Авторизация" full>
              <div className="flex gap-1 rounded-lg border border-border bg-bg/60 p-1">
                {(['password', 'key'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setF((p) => ({ ...p, authMethod: m }))}
                    className={cn(
                      'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      f.authMethod === m ? 'bg-accent text-bg' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {m === 'password' ? 'Пароль' : 'SSH-ключ'}
                  </button>
                ))}
              </div>
            </Field>

            {f.authMethod === 'password' ? (
              <Field label={editing ? 'SSH password (blank = keep current)' : 'SSH password (optional)'} full>
                <input
                  className={inputCls}
                  type="password"
                  value={f.password}
                  onChange={set('password')}
                  placeholder="stored encrypted in the vault"
                />
              </Field>
            ) : (
              <>
                <Field label={editing ? 'Приватный ключ (пусто = оставить текущий)' : 'Приватный ключ (PEM / OpenSSH)'} full>
                  <textarea
                    className={cn(inputCls, 'h-24 resize-y font-mono text-[11px] leading-tight')}
                    value={f.privateKey}
                    onChange={set('privateKey')}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => keyFileRef.current?.click()}
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover"
                  >
                    <Upload className="h-3 w-3" /> Загрузить из файла
                  </button>
                  <input
                    ref={keyFileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => void loadKeyFile(e.target.files?.[0])}
                  />
                </Field>
                <Field label="Passphrase ключа (если есть)" full>
                  <input
                    className={inputCls}
                    type="password"
                    value={f.passphrase}
                    onChange={set('passphrase')}
                    placeholder="optional"
                  />
                </Field>
              </>
            )}
          </div>

          {api && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={probe}
                disabled={
                  probing ||
                  !f.ip.trim() ||
                  (f.authMethod === 'password' ? !f.password : !f.privateKey)
                }
                className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover disabled:opacity-50"
              >
                {probing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                )}
                Определить по SSH
              </button>
              {probeMsg && <span className="text-xs text-slate-500">{probeMsg}</span>}
            </div>
          )}
          {error && <div className="mt-3 text-xs text-rose-400">{error}</div>}

          <div className="mt-5 flex items-center justify-between">
            <span className="text-[11px] text-slate-600">Secrets are encrypted at rest (SQLCipher).</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? 'Save' : 'Add device'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
