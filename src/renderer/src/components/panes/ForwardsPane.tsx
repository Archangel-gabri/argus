import { useEffect, useState } from 'react'
import { Plus, Loader2, Trash2, ArrowRight } from 'lucide-react'
import type { DeviceDTO, ForwardInfo } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

export function ForwardsPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [list, setList] = useState<ForwardInfo[]>([])
  const [lport, setLport] = useState('')
  const [rhost, setRhost] = useState('127.0.0.1')
  const [rport, setRport] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (!api) return
    setList(await api.forward.list(device.id))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

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
    const r = await api.forward.open(device.id, lp, rhost.trim() || '127.0.0.1', rp)
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
    <div className="h-full overflow-y-auto rounded-lg border border-border bg-surface/40 px-4 py-3">
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
  )
}
