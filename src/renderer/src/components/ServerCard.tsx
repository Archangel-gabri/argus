import { useEffect, useRef, useState } from 'react'
import { TerminalSquare, MoreVertical, ExternalLink, Pencil, Trash2, FolderOpen, Network } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money, pct } from '@/lib/format'
import { providerHex, providerGlyph } from '@/lib/providers'
import { providerLogo } from '@/lib/providerLogos'
import { Sparkline } from '@/components/ui/Sparkline'
import type { DeviceDTO, Status } from '@/types'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'

const api = typeof window !== 'undefined' ? window.api : undefined

// 6-state system (color + text label = colorblind-safe). Only 'reboot' animates.
const STATUS: Record<Status, { dot: string; label: string; text: string; ring: boolean }> = {
  online: { dot: 'bg-emerald-500', label: 'Online', text: 'text-emerald-400', ring: true },
  degraded: { dot: 'bg-amber-400', label: 'Degraded', text: 'text-amber-400', ring: false },
  reboot: { dot: 'bg-sky-400', label: 'Rebooting', text: 'text-sky-400', ring: false },
  offline: { dot: 'bg-rose-500', label: 'Offline', text: 'text-rose-400', ring: false },
  unknown: { dot: 'bg-slate-500', label: 'Unknown', text: 'text-slate-400', ring: false },
  maintenance: { dot: 'bg-violet-400', label: 'Maintenance', text: 'text-violet-400', ring: false }
}

function Metric({
  label,
  value,
  percent,
  muted,
  spark
}: {
  label: string
  value: string
  percent: number
  muted?: boolean
  spark?: number[]
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="shrink-0 text-slate-400">{label}</span>
        {spark && spark.length >= 2 && (
          <Sparkline data={spark} color={muted ? '#78716c' : '#f59e0b'} width={56} height={16} />
        )}
        <span className="shrink-0 font-medium tabular-nums text-slate-200">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-600/30">
        <div
          className={cn('h-full rounded-full transition-all', muted ? 'bg-slate-600' : 'bg-accent')}
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
    </div>
  )
}

function ProviderBadge({ provider }: { provider: string }): React.JSX.Element {
  const logo = providerLogo(provider)
  const [failed, setFailed] = useState(false)
  if (logo && !failed) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-black/5">
        <img
          src={logo}
          alt={provider}
          className="h-7 w-7 object-contain"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </div>
    )
  }
  const hex = providerHex(provider)
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold"
      style={{ backgroundColor: `${hex}1a`, color: hex, boxShadow: `inset 0 0 0 1px ${hex}33` }}
    >
      {providerGlyph(provider)}
    </div>
  )
}

export function ServerCard({ s }: { s: DeviceDTO }): React.JSX.Element {
  const openEdit = useUI((st) => st.openEdit)
  const openTerminal = useUI((st) => st.openTerminal)
  const openSftp = useUI((st) => st.openSftp)
  const openForwards = useUI((st) => st.openForwards)
  const remove = useDevices((st) => st.remove)
  const [menu, setMenu] = useState(false)
  const [cpuHist, setCpuHist] = useState<number[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    api.metrics.history(s.id, 30).then((rows) => {
      if (alive) setCpuHist(rows.map((r) => r.cpu ?? 0))
    })
    return () => {
      alive = false
    }
  }, [s.id, s.cpu])

  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menu])

  const st = STATUS[s.status]
  const ramPct = s.ram.total ? (s.ram.used / s.ram.total) * 100 : 0
  // live bars stay lit for online + degraded; muted for down/unknown/maintenance/reboot
  const dim = s.status !== 'online' && s.status !== 'degraded'

  return (
    <div className="group rounded-xl border border-border bg-card/80 p-5 shadow-lg shadow-black/20 transition-colors hover:border-slate-600/60 hover:bg-card">
      <div className="flex items-start gap-3">
        <ProviderBadge provider={s.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-white">{s.name}</span>
            {s.flag && <span className="text-sm leading-none">{s.flag}</span>}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
            {s.ip || '—'}
            {s.role ? ` · ${s.role}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => openTerminal(s)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-accent"
            aria-label="Open terminal"
            title="SSH terminal"
          >
            <TerminalSquare className="h-[18px] w-[18px]" />
          </button>
          <div className="relative" ref={ref}>
            <button
              onClick={() => setMenu((v) => !v)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              aria-label="More"
            >
              <MoreVertical className="h-[18px] w-[18px]" />
            </button>
            {menu && (
              <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl">
                <button
                  onClick={() => {
                    setMenu(false)
                    openEdit(s)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  onClick={() => {
                    setMenu(false)
                    openSftp(s)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5"
                >
                  <FolderOpen className="h-3.5 w-3.5" /> Файлы (SFTP)
                </button>
                <button
                  onClick={() => {
                    setMenu(false)
                    openForwards(s)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5"
                >
                  <Network className="h-3.5 w-3.5" /> Проброс портов
                </button>
                <button
                  onClick={() => {
                    setMenu(false)
                    if (window.confirm(`Delete “${s.name}”? This cannot be undone.`)) remove(s.id)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-rose-400 hover:bg-rose-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
        <div>
          <span className="text-slate-500">OS</span>{' '}
          <span className="text-slate-300">{s.os || '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Status</span>
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              st.dot,
              st.ring && 'shadow-[0_0_0_3px_rgba(34,211,238,0.15)]',
              s.status === 'reboot' && 'animate-pulse'
            )}
          />
          <span className={cn('font-medium', st.text)}>{st.label}</span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <Metric label="CPU load" value={pct(s.cpu)} percent={s.cpu} muted={dim} spark={cpuHist} />
        <Metric
          label="RAM usage"
          value={`${s.ram.used} / ${s.ram.total} GB`}
          percent={ramPct}
          muted={dim}
        />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
        {s.consoleUrl ? (
          <a
            href={s.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Hoster Console
          </a>
        ) : (
          <span className="text-xs text-slate-600">No console</span>
        )}
        {s.cost.amount > 0 && (
          <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-300">
            {money(s.cost.amount, s.cost.currency)}
            <span className="text-slate-500">/mo</span>
          </span>
        )}
      </div>
    </div>
  )
}
