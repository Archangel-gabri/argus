import { useEffect, useState } from 'react'
import { X, Plus, Loader2, Trash2, Network, ArrowRight } from 'lucide-react'
import { useUI } from '@/store/ui'
import type { ForwardInfo } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

export function ForwardsPanel(): React.JSX.Element | null {
  const target = useUI((s) => s.forwards)
  const close = useUI((s) => s.closeForwards)
  const [list, setList] = useState<ForwardInfo[]>([])
  const [lport, setLport] = useState('')
  const [rhost, setRhost] = useState('127.0.0.1')
  const [rport, setRport] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (!api || !target) return
    setList(await api.forward.list(target.id))
  }

  useEffect(() => {
    if (target) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  if (!target) return null

  const add = async (): Promise<void> => {
    if (!api) return
    const lp = parseInt(lport, 10)
    const rp = parseInt(rport, 10)
    if (!lp || !rp) {
      setError('Укажи локальный и удалённый порт')
      return
    }
    setBusy(true)
    setError(null)
    const r = await api.forward.open(target.id, lp, rhost.trim() || '127.0.0.1', rp)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'не удалось')
      return
    }
    setLport('')
    setRport('')
    refresh()
  }
  const stop = (id: string): void => {
    if (!api) return
    api.forward.close(id)
    setTimeout(refresh, 120)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={close}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-white">
            <Network className="h-4 w-4 shrink-0 text-accent" /> <span className="truncate">Проброс портов · {target.name}</span>
          </h2>
          <button onClick={close} className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 rounded-lg border border-border bg-bg/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="font-mono">localhost:</span>
              <input
                value={lport}
                onChange={(e) => setLport(e.target.value)}
                placeholder="8080"
                inputMode="numeric"
                className="w-20 rounded border border-border bg-bg/60 px-2 py-1 text-slate-200 outline-none focus:border-accent/40"
              />
              <ArrowRight className="h-3.5 w-3.5" />
              <input
                value={rhost}
                onChange={(e) => setRhost(e.target.value)}
                placeholder="127.0.0.1"
                className="w-28 rounded border border-border bg-bg/60 px-2 py-1 font-mono text-slate-200 outline-none focus:border-accent/40"
              />
              <span className="font-mono">:</span>
              <input
                value={rport}
                onChange={(e) => setRport(e.target.value)}
                placeholder="80"
                inputMode="numeric"
                className="w-16 rounded border border-border bg-bg/60 px-2 py-1 text-slate-200 outline-none focus:border-accent/40"
              />
            </div>
            <button
              onClick={add}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Запустить туннель
            </button>
            {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
            <p className="mt-2 text-[11px] text-slate-600">
              Доступ к сервису на сервере через localhost (напр. панель, БД). Туннель живёт, пока открыто приложение.
            </p>
          </div>

          {list.length === 0 ? (
            <p className="text-center text-sm text-slate-500">Активных туннелей нет.</p>
          ) : (
            <ul className="space-y-1">
              {list.map((f) => (
                <li key={f.id} className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="flex-1 truncate font-mono text-xs text-slate-300">
                    localhost:{f.localPort} <span className="text-slate-600">→</span> {f.remoteHost}:{f.remotePort}
                  </span>
                  <button
                    onClick={() => stop(f.id)}
                    className="rounded p-1 text-slate-400 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                    title="Остановить"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
