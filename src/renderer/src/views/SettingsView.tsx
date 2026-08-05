import { useState, type FormEvent } from 'react'
import { Lock, Loader2, ShieldCheck, Timer, Eye } from 'lucide-react'
import { Page, PageHeader, Card } from '@/components/ui/Page'
import { Hint } from '@/components/ui/Hint'
import { useVault } from '@/store/vault'
import { loadPrefs, savePrefs, type Prefs } from '@/lib/prefs'
import { masterPasswordPolicyError } from '@/lib/password-strength'

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
    try {
      // Тот же общий гейт, что на онбординге и в main IPC: renderer не может его ослабить.
      const policyError = await masterPasswordPolicyError(next)
      if (policyError) {
        setMsg({ ok: false, text: policyError })
        return
      }
      const r = await api.vault.changePassword(cur, next)
      if (r.ok) {
        setMsg({ ok: true, text: 'Мастер-пароль изменён (SQLCipher rekey выполнен).' })
        setCur('')
        setNext('')
        setConfirm('')
      } else {
        setMsg({ ok: false, text: r.error ?? 'Не удалось' })
      }
    } catch (error) {
      setMsg({ ok: false, text: error instanceof Error ? error.message : 'Не удалось' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-3 gap-3">
      <input className={inputCls} type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Текущий пароль" disabled={!api} />
      <input className={inputCls} type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Новый пароль" disabled={!api} />
      <input className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Ещё раз" disabled={!api} />
      <div className="col-span-3 flex items-center justify-between">
        <span className={msg ? (msg.ok ? 'text-xs text-emerald-400' : 'text-xs text-rose-400') : 'text-[11px] text-slate-400'}>
          {msg ? msg.text : api ? 'Перешифрует базу новым ключом.' : 'Только в десктоп-приложении.'}
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
      <PageHeader title="Настройки" />

      <Section title="Безопасность">
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
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-400">
            Смена мастер-пароля
            <Hint>
              Из нового пароля выводится ключ (Argon2id), и база перешифровывается им целиком —
              SQLCipher rekey.
            </Hint>
          </div>
          <ChangePassword />
        </div>
      </Section>

      <Section title="Внешний вид">
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

      <Section title="О приложении">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          Argus 0.1.0 · всё хранится локально
        </div>
      </Section>
    </Page>
  )
}
