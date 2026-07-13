import { useState, type FormEvent } from 'react'
import { Lock, Loader2, ShieldCheck, Timer, Eye } from 'lucide-react'
import { Page, PageHeader, Card, LimitNote } from '@/components/ui/Page'
import { useVault } from '@/store/vault'
import { loadPrefs, savePrefs, type Prefs } from '@/lib/prefs'
import { checkStrength, MIN_PASSWORD_SCORE } from '@/lib/password-strength'

const api = typeof window !== 'undefined' ? window.api : undefined

const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Card className="mb-5">
      <h2 className="mb-3 text-sm font-semibold text-white">{title}</h2>
      {children}
    </Card>
  )
}

function ChangePassword(): React.JSX.Element {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setMsg(null)
    if (next.length < 6) {
      setMsg({ ok: false, text: 'Новый пароль — минимум 6 символов' })
      return
    }
    if (next !== confirm) {
      setMsg({ ok: false, text: 'Пароли не совпадают' })
      return
    }
    if (!api) return
    setBusy(true)
    // Тот же zxcvbn-гейт, что на онбординге — нельзя ослабить мастер-пароль до слабого.
    const score = (await checkStrength(next)).score
    if (score < MIN_PASSWORD_SCORE) {
      setBusy(false)
      setMsg({ ok: false, text: 'Новый пароль слишком слабый — возьми passphrase из 3-4 слов' })
      return
    }
    const r = await api.vault.changePassword(cur, next)
    setBusy(false)
    if (r.ok) {
      setMsg({ ok: true, text: 'Мастер-пароль изменён (SQLCipher rekey выполнен).' })
      setCur('')
      setNext('')
      setConfirm('')
    } else {
      setMsg({ ok: false, text: r.error ?? 'Не удалось' })
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-3 gap-3">
      <input className={inputCls} type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Текущий пароль" disabled={!api} />
      <input className={inputCls} type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Новый пароль" disabled={!api} />
      <input className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Ещё раз" disabled={!api} />
      <div className="col-span-3 flex items-center justify-between">
        <span className={msg ? (msg.ok ? 'text-xs text-emerald-400' : 'text-xs text-rose-400') : 'text-[11px] text-slate-600'}>
          {msg ? msg.text : api ? 'Перешифрует базу новым ключом (Argon2id → SQLCipher rekey).' : 'Только в десктоп-приложении.'}
        </span>
        <button
          type="submit"
          disabled={busy || !api}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Сменить
        </button>
      </div>
    </form>
  )
}

export function SettingsView(): React.JSX.Element {
  const lock = useVault((s) => s.lock)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)

  const update = (patch: Partial<Prefs>): void => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
  }

  return (
    <Page>
      <PageHeader title="Settings" subtitle="безопасность · внешний вид · о приложении" />

      <Section title="Security">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <Timer className="h-4 w-4 text-slate-500" />
            Авто-лок при бездействии
            <select
              className={inputCls + ' w-auto'}
              value={prefs.autolockMin}
              onChange={(e) => update({ autolockMin: Number(e.target.value) as Prefs['autolockMin'] })}
            >
              <option value={0}>выключен</option>
              <option value={5}>5 минут</option>
              <option value={15}>15 минут</option>
              <option value={30}>30 минут</option>
            </select>
          </label>
          <button
            onClick={() => lock()}
            className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover"
          >
            <Lock className="h-3.5 w-3.5" /> Заблокировать сейчас
          </button>
        </div>
        <div className="border-t border-border/70 pt-4">
          <div className="mb-2 text-xs font-medium text-slate-400">Смена мастер-пароля</div>
          <ChangePassword />
        </div>
      </Section>

      <Section title="Appearance">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <Eye className="h-4 w-4 text-slate-500" />
          <input
            type="checkbox"
            checked={prefs.reduceMotion}
            onChange={(e) => update({ reduceMotion: e.target.checked })}
            className="h-4 w-4 accent-[#f59e0b]"
          />
          Reduce motion — без анимаций и переходов
        </label>
      </Section>

      <Section title="About">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          Argus 0.1.0 · local-first · Argon2id → SQLCipher · секреты не покидают main-процесс
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Дизайн-контракт: DESIGN.md · Спек редизайна: docs/REDESIGN-2026-07.md · Карта UI: docs/UX-MAP.md
        </p>
      </Section>

      <LimitNote>
        Recovery Kit, экспорт/импорт vault и Integrations (Ollama, ключи) — этап C: требует
        envelope-архитектуры мастер-ключа, не делается на живом vault без миграции.
      </LimitNote>
    </Page>
  )
}
