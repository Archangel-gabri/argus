import { useEffect, useState, type FormEvent } from 'react'
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useVault } from '@/store/vault'
import { checkStrength, MIN_PASSWORD_SCORE, type ZxcvbnResult } from '@/lib/password-strength'
import wordmark from '@/assets/brand/argus-wordmark.png'

// Гейтим по СКОРУ (crack-time), не по составу пароля (MASTER-PLAN C0.3).
const STRENGTH: Array<{ label: string; bar: string; text: string }> = [
  { label: 'очень слабый', bar: 'bg-rose-500', text: 'text-rose-400' },
  { label: 'слабый', bar: 'bg-rose-400', text: 'text-rose-400' },
  { label: 'так себе', bar: 'bg-amber-400', text: 'text-amber-400' },
  { label: 'хороший', bar: 'bg-emerald-500', text: 'text-emerald-400' },
  { label: 'отличный', bar: 'bg-emerald-400', text: 'text-emerald-400' }
]

export function LockScreen(): React.JSX.Element {
  const { status, error, busy, keyringBackend, initialize, unlock, refresh } = useVault()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ack, setAck] = useState(false)
  const [strength, setStrength] = useState<ZxcvbnResult | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const setup = status === 'uninitialized'

  // Ленивая проверка силы (динамический импорт словарей при первом вводе).
  useEffect(() => {
    if (!setup || !pw) {
      setStrength(null)
      return
    }
    let alive = true
    void checkStrength(pw).then((r) => {
      if (alive) setStrength(r)
    })
    return () => {
      alive = false
    }
  }, [setup, pw])

  const score = strength?.score ?? 0
  const setupGateOk =
    !setup || (score >= MIN_PASSWORD_SCORE && ack && pw === confirm && pw.length >= 6)

  useEffect(() => {
    refresh()
  }, [refresh])

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setLocalError(null)
    if (pw.length < 6) {
      setLocalError('Минимум 6 символов')
      return
    }
    if (setup && pw !== confirm) {
      setLocalError('Пароли не совпадают')
      return
    }
    if (setup && !ack) {
      setLocalError('Подтверди, что понимаешь: восстановления нет')
      return
    }
    if (setup) {
      // Авторитетная проверка на сабмите (не полагаемся на async-состояние индикатора).
      const finalScore = (await checkStrength(pw)).score
      if (finalScore < MIN_PASSWORD_SCORE) {
        setLocalError('Пароль слишком слабый — возьми passphrase из 3-4 слов')
        return
      }
    }
    const ok = setup ? await initialize(pw) : await unlock(pw)
    if (!ok) {
      setPw('')
      setConfirm('')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img src={wordmark} alt="Argus" className="mx-auto w-56 rounded-xl" />
          <h1 className="mt-4 text-xl font-semibold text-white">
            {setup ? 'Создать хранилище' : 'Argus заблокирован'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {setup
              ? 'Задай мастер-пароль — им шифруется вся база (SQLCipher).'
              : 'Введи мастер-пароль для доступа к данным.'}
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Мастер-пароль"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          />
          {setup && (
            <>
              {pw && strength && (
                <div>
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={cn(
                          'h-1 flex-1 rounded-full transition-colors',
                          i < score ? STRENGTH[score].bar : 'bg-slate-600/40'
                        )}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px]">
                    <span className={STRENGTH[score].text}>{STRENGTH[score].label}</span>
                    <span className="text-slate-600">
                      взлом ≈ {strength.crackTimes.offlineSlowHashingXPerSecond.display}
                    </span>
                  </div>
                </div>
              )}
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Ещё раз"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
              />
              <label className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#f59e0b]"
                />
                Понимаю: восстановления мастер-пароля НЕТ — потеря пароля = потеря всех данных vault.
              </label>
            </>
          )}
        </div>

        {(localError || error) && (
          <div className="mt-3 flex items-center gap-2 text-xs text-rose-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {localError || error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !setupGateOk}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-bg transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {setup ? 'Создать' : 'Войти'}
        </button>

        <div className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
          <ShieldCheck className="h-3.5 w-3.5" /> Локально · шифрование SQLCipher
        </div>
        {keyringBackend === 'basic_text' && (
          <p className="mt-2 text-center text-[11px] text-amber-500/80">
            Кейчейн ОС недоступен — вводи пароль каждый запуск.
          </p>
        )}
      </form>
    </div>
  )
}
