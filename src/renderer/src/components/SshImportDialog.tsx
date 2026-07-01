import { useEffect, useState } from 'react'
import { X, FileDown, Radar, Loader2 } from 'lucide-react'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { ParsedHost } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

export function SshImportDialog(): React.JSX.Element | null {
  const source = useUI((s) => s.sshImport)
  const setSource = useUI((s) => s.setSshImport)
  const reload = useDevices((s) => s.load)
  const [hosts, setHosts] = useState<ParsedHost[]>([])
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<number | null>(null)

  const isTailscale = source === 'tailscale'

  useEffect(() => {
    if (source === false) return
    setAdded(null)
    if (!api) {
      setHosts([])
      return
    }
    setLoading(true)
    const p = source === 'tailscale' ? api.discovery.tailscale() : api.sshconfig.parse()
    p.then((h) => {
      setHosts(h)
      setSel(Object.fromEntries(h.map((x) => [x.name, true])))
      setLoading(false)
    })
  }, [source])

  if (source === false) return null
  const chosen = hosts.filter((h) => sel[h.name])

  const doImport = async (): Promise<void> => {
    if (!api) return
    setBusy(true)
    const r = await api.sshconfig.import(chosen)
    await reload()
    setBusy(false)
    setAdded(r.added)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={() => setSource(false)}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            {isTailscale ? <Radar className="h-4 w-4 text-accent" /> : <FileDown className="h-4 w-4 text-accent" />}
            {isTailscale ? 'Обнаружение Tailscale' : 'Импорт ~/.ssh/config'}
          </h2>
          <button
            onClick={() => setSource(false)}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!api ? (
            <p className="text-sm text-slate-500">Доступно только в десктоп-приложении.</p>
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> {isTailscale ? 'Опрашиваю тайнет…' : 'Читаю ~/.ssh/config…'}
            </div>
          ) : added != null ? (
            <p className="text-sm text-slate-200">
              Добавлено серверов: <span className="font-semibold text-accent">{added}</span>.
            </p>
          ) : hosts.length === 0 ? (
            <p className="text-sm text-slate-500">
              {isTailscale
                ? 'Тайнет не найден (tailscale не установлен / не залогинен / нет пиров).'
                : 'В ~/.ssh/config не найдено хостов (или файла нет).'}
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-500">Найдено {hosts.length} — отметь для добавления:</p>
              <div className="space-y-1">
                {hosts.map((h) => (
                  <label
                    key={h.name}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
                  >
                    <input
                      type="checkbox"
                      checked={!!sel[h.name]}
                      onChange={(e) => setSel((p) => ({ ...p, [h.name]: e.target.checked }))}
                      className="h-4 w-4 accent-[#22d3ee]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-200">{h.name}</div>
                      <div className="truncate font-mono text-xs text-slate-500">
                        {h.user}@{h.host}:{h.port}
                        {h.proxyJump ? ` · via ${h.proxyJump}` : ''}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {api && !loading && added == null && hosts.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <span className="text-xs text-slate-500">Выбрано: {chosen.length}</span>
            <button
              onClick={doImport}
              disabled={busy || chosen.length === 0}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Добавить
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
