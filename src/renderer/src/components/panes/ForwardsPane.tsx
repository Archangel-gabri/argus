import { useEffect, useState } from 'react'
import { Plus, Loader2, Trash2, ArrowRight, ArrowRightLeft, RefreshCw, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { DeviceDTO, ForwardInfo, ListeningPort } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

// Пресеты частых сервисов — быстрый туннель к порту на сервере.
const PRESETS: Array<{ label: string; port: number }> = [
  { label: 'Панель 3x-ui', port: 2053 },
  { label: 'Remnawave', port: 3000 },
  { label: 'Postgres', port: 5432 },
  { label: 'MySQL', port: 3306 },
  { label: 'Redis', port: 6379 },
  { label: 'Grafana', port: 3300 }
]

const BIND_BADGE: Record<ListeningPort['bind'], { label: string; cls: string }> = {
  loopback: { label: 'local', cls: 'text-slate-500 ring-border' },
  wildcard: { label: 'открыт наружу', cls: 'text-amber-400 ring-amber-500/30' },
  other: { label: 'LAN', cls: 'text-sky-400 ring-sky-500/30' }
}

// URL для кликабельного открытия в браузере (http-сервисы за туннелем).
const HTTP_PORTS = new Set([80, 443, 2053, 3000, 3300, 8080, 8006, 9000, 5601, 9090])

export function ForwardsPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [list, setList] = useState<ForwardInfo[]>([])
  const [lport, setLport] = useState('')
  const [rhost, setRhost] = useState('127.0.0.1')
  const [rport, setRport] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [ports, setPorts] = useState<ListeningPort[]>([])
  const [portsErr, setPortsErr] = useState<string | null>(null)
  const [portsLoading, setPortsLoading] = useState(false)

  const refresh = async (): Promise<void> => {
    if (!api) return
    setList(await api.forward.list(device.id))
  }
  const loadPorts = async (): Promise<void> => {
    if (!api) return
    setPortsLoading(true)
    setPortsErr(null)
    const r = await api.ports.list(device.id)
    setPortsLoading(false)
    if (r.ok) setPorts(r.ports)
    else {
      setPorts([])
      setPortsErr(r.error ?? 'не удалось получить список')
    }
  }

  useEffect(() => {
    refresh()
    loadPorts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const activeLocal = new Set(list.map((f) => f.localPort))

  const openTunnel = async (localPort: number, remotePort: number): Promise<void> => {
    if (!api) return
    setBusy(true)
    setError(null)
    const r = await api.forward.open(device.id, localPort, '127.0.0.1', remotePort)
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'не удалось открыть туннель')
    refresh()
  }

  const add = async (): Promise<void> => {
    const lp = parseInt(lport, 10)
    const rp = parseInt(rport, 10)
    if (!lp || !rp) {
      setError('Укажи локальный и удалённый порт')
      return
    }
    if (!api) return
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
    <div className="h-full space-y-3 overflow-y-auto pr-1">
      {/* ── Слушают на сервере ── */}
      <div className="rounded-lg border border-border bg-surface/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Слушают на сервере</span>
          <button
            onClick={loadPorts}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            title="Обновить"
          >
            {portsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        {portsErr ? (
          <p className="py-2 text-center text-xs text-slate-500">{portsErr}</p>
        ) : ports.length === 0 ? (
          <p className="py-2 text-center text-xs text-slate-600">{portsLoading ? 'Сканирую…' : 'Портов не найдено.'}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {ports.map((p) => {
              const open = activeLocal.has(p.port)
              const badge = BIND_BADGE[p.bind]
              return (
                <li key={`${p.proto}-${p.addr}-${p.port}`} className="group flex items-center gap-2.5 py-1.5 text-xs">
                  <span
                    className={cn(
                      'w-8 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold uppercase',
                      p.proto === 'tcp' ? 'bg-white/5 text-slate-400' : 'bg-violet-500/10 text-violet-300'
                    )}
                  >
                    {p.proto}
                  </span>
                  <span className="w-12 shrink-0 font-mono tabular-nums text-slate-200">{p.port}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">{p.process || '—'}</span>
                  <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ring-1', badge.cls)}>{badge.label}</span>
                  {p.proto === 'tcp' &&
                    (open ? (
                      <span className="shrink-0 text-[10px] font-medium text-accent">открыт</span>
                    ) : (
                      <button
                        onClick={() => openTunnel(p.port, p.port)}
                        disabled={busy}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-300 opacity-0 ring-1 ring-border transition hover:bg-white/5 group-hover:opacity-100 disabled:opacity-40"
                        title={`Туннель localhost:${p.port} → сервер`}
                      >
                        <ArrowRightLeft className="h-3 w-3" /> Туннель
                      </button>
                    ))}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* ── Активные туннели ── */}
      <div className="rounded-lg border border-border bg-surface/40 p-3">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Активные туннели</div>
        {list.length === 0 ? (
          <p className="py-1 text-center text-xs text-slate-600">Нет активных туннелей.</p>
        ) : (
          <ul className="space-y-1">
            {list.map((f) => (
              <li key={f.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="flex-1 truncate font-mono text-xs text-slate-300">
                  localhost:{f.localPort} <span className="text-slate-600">→</span> {f.remoteHost}:{f.remotePort}
                </span>
                {HTTP_PORTS.has(f.localPort) && (
                  <a
                    href={`http://localhost:${f.localPort}`}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded p-1 text-slate-400 hover:text-accent"
                    title="Открыть в браузере"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  onClick={() => stop(f.id)}
                  className="shrink-0 rounded p-1 text-slate-400 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                  title="Остановить"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Ручной туннель + пресеты ── */}
      <div className="rounded-lg border border-border bg-bg/40 p-3">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Ручной туннель</div>
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
          <button
            onClick={add}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Запустить
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.port}
              onClick={() => openTunnel(p.port, p.port)}
              disabled={busy || activeLocal.has(p.port)}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
              title={`Туннель localhost:${p.port} → сервер:${p.port}`}
            >
              {p.label} · {p.port}
            </button>
          ))}
        </div>
        {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
        <p className="mt-2 text-[11px] text-slate-600">
          Доступ к сервису на сервере через localhost. Туннель живёт, пока открыто приложение. UDP через SSH -L не туннелируется.
        </p>
      </div>
    </div>
  )
}
