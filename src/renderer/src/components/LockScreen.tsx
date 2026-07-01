import { useEffect, useState, type FormEvent } from 'react'
import { Lock, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react'
import { useVault } from '@/store/vault'

export function LockScreen(): React.JSX.Element {
  const { status, error, busy, keyringBackend, initialize, unlock, refresh } = useVault()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const setup = status === 'uninitialized'

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
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent ring-1 ring-accent/30">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-white">
            {setup ? 'Create your vault' : 'Unlock Nexus One'}
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
            placeholder="Master password"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          />
          {setup && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            />
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
          disabled={busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-bg transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {setup ? 'Create vault' : 'Unlock'}
        </button>

        <div className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
          <ShieldCheck className="h-3.5 w-3.5" /> Local-only · Argon2id → SQLCipher · keyring: {keyringBackend}
        </div>
        {keyringBackend === 'basic_text' && (
          <p className="mt-2 text-center text-[11px] text-amber-500/80">
            OS-кейчейн недоступен (plaintext fallback) — пароль не кэшируется, вводи каждый запуск.
          </p>
        )}
      </form>
    </div>
  )
}
