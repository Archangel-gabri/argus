import { useEffect, useState } from 'react'
import { X, Play, Save, Loader2, Trash2, Terminal as TermIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { Snippet } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

interface Result {
  id: string
  name: string
  ok: boolean
  output: string
  error?: string
}

export function BroadcastPanel(): React.JSX.Element | null {
  const open = useUI((s) => s.broadcast)
  const setOpen = useUI((s) => s.setBroadcast)
  const devices = useDevices((s) => s.devices)
  const [cmd, setCmd] = useState('')
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [snips, setSnips] = useState<Snippet[]>([])
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Result[]>([])

  const eligible = devices.filter((d) => d.hasSecret && !d.ip.includes('x.x'))

  useEffect(() => {
    if (!open) return
    setResults([])
    if (api) api.snippets.list().then(setSnips)
    setSel(Object.fromEntries(eligible.map((d) => [d.id, true])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const chosen = eligible.filter((d) => sel[d.id])

  const run = async (): Promise<void> => {
    if (!api || !cmd.trim() || chosen.length === 0) return
    setRunning(true)
    setResults([])
    const rs = await Promise.all(
      chosen.map(async (d): Promise<Result> => {
        const r = await api.ssh.exec(d.id, cmd)
        return { id: d.id, name: d.name, ok: r.ok, output: r.output, error: r.error }
      })
    )
    setResults(rs)
    setRunning(false)
  }

  const saveSnippet = async (): Promise<void> => {
    if (!api || !cmd.trim()) return
    const name = window.prompt('Название сниппета:')
    if (!name) return
    await api.snippets.create(name, cmd)
    api.snippets.list().then(setSnips)
  }
  const delSnippet = async (id: string): Promise<void> => {
    if (!api) return
    await api.snippets.remove(id)
    api.snippets.list().then(setSnips)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={() => setOpen(false)}>
      <div
        className="flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <TermIcon className="h-4 w-4 text-accent" /> Broadcast — выполнить на многих
          </h2>
          <button onClick={() => setOpen(false)} className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Команда</span>
              <button
                onClick={saveSnippet}
                disabled={!cmd.trim()}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-accent disabled:opacity-40"
              >
                <Save className="h-3 w-3" /> сохранить
              </button>
            </div>
            <textarea
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              rows={2}
              placeholder="uptime && df -h /"
              className="w-full resize-y rounded-lg border border-border bg-bg/60 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-accent/40"
            />
            {snips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {snips.map((s) => (
                  <span key={s.id} className="group flex items-center gap-1 rounded-md bg-card px-2 py-1 text-xs text-slate-300 ring-1 ring-border">
                    <button onClick={() => setCmd(s.command)} className="hover:text-accent">
                      {s.name}
                    </button>
                    <button
                      onClick={() => delSnippet(s.id)}
                      className="text-slate-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Хосты ({chosen.length}/{eligible.length})
            </span>
            {eligible.length === 0 ? (
              <p className="text-xs text-slate-500">Нет хостов с сохранёнными кредами и реальным IP.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {eligible.map((d) => (
                  <label
                    key={d.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1',
                      sel[d.id] ? 'bg-accent/10 text-accent ring-accent/30' : 'bg-card text-slate-300 ring-border'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={!!sel[d.id]}
                      onChange={(e) => setSel((p) => ({ ...p, [d.id]: e.target.checked }))}
                      className="h-3.5 w-3.5 accent-[#22d3ee]"
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="space-y-2">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Результат</span>
              {results.map((r) => (
                <div key={r.id} className="rounded-lg border border-border bg-bg/40">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
                    <span className={cn('h-1.5 w-1.5 rounded-full', r.ok ? 'bg-accent' : 'bg-rose-500')} />
                    <span className="font-medium text-slate-200">{r.name}</span>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-slate-400">
                    {r.ok ? r.output || '(пусто)' : `✖ ${r.error}`}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="text-xs text-slate-500">{running ? 'Выполняю…' : `${chosen.length} хостов`}</span>
          <button
            onClick={run}
            disabled={running || !cmd.trim() || chosen.length === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Выполнить
          </button>
        </div>
      </div>
    </div>
  )
}
