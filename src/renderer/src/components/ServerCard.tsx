import { useEffect, useRef, useState } from 'react'
import {
  TerminalSquare,
  MoreVertical,
  ExternalLink,
  Pencil,
  Trash2,
  FolderOpen,
  Network
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { money, pct } from '@/lib/format'
import { providerHex, providerGlyph } from '@/lib/providers'
import { providerLogo } from '@/lib/providerLogos'
import { deviceIllustration } from '@/lib/illustrations'
import type { DeviceDTO, Status } from '@/types'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'

// 6-state system (color + text label = colorblind-safe). Only 'reboot' animates.
export const STATUS: Record<
  Status,
  { dot: string; label: string; text: string; hex: string; ring: boolean }
> = {
  online: { dot: 'bg-emerald-500', label: 'Online', text: 'text-emerald-400', hex: '#10b981', ring: true },
  degraded: { dot: 'bg-amber-400', label: 'Degraded', text: 'text-amber-400', hex: '#fbbf24', ring: false },
  reboot: { dot: 'bg-sky-400', label: 'Rebooting', text: 'text-sky-400', hex: '#38bdf8', ring: false },
  offline: { dot: 'bg-rose-500', label: 'Offline', text: 'text-rose-400', hex: '#f43f5e', ring: false },
  unknown: { dot: 'bg-slate-500', label: 'Unknown', text: 'text-slate-400', hex: '#78716c', ring: false },
  maintenance: { dot: 'bg-violet-400', label: 'Maintenance', text: 'text-violet-400', hex: '#a78bfa', ring: false }
}

function Bar({
  label,
  value,
  percent,
  muted
}: {
  label: string
  value: string
  percent: number
  muted?: boolean
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="shrink-0 text-slate-500">{label}</span>
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

export function ProviderBadge({
  provider,
  size = 'md'
}: {
  provider: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const logo = providerLogo(provider)
  const [failed, setFailed] = useState(false)
  const box = size === 'sm' ? 'h-8 w-8 rounded-md' : 'h-10 w-10 rounded-lg'
  const img = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7'
  if (logo && !failed) {
    return (
      <div className={cn('flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-black/5', box)}>
        <img src={logo} alt={provider} className={cn('object-contain', img)} onError={() => setFailed(true)} draggable={false} />
      </div>
    )
  }
  const hex = providerHex(provider)
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center text-[12px] font-bold', box)}
      style={{ backgroundColor: `${hex}1a`, color: hex, boxShadow: `inset 0 0 0 1px ${hex}33` }}
    >
      {providerGlyph(provider)}
    </div>
  )
}

export function ServerCard({ s }: { s: DeviceDTO }): React.JSX.Element {
  const openEdit = useUI((st) => st.openEdit)
  const openDetail = useUI((st) => st.openDetail)
  const openTerminal = useUI((st) => st.openTerminal)
  const openSftp = useUI((st) => st.openSftp)
  const openForwards = useUI((st) => st.openForwards)
  const remove = useDevices((st) => st.remove)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
    <div className="group rounded-xl border border-border bg-card/80 p-4 shadow-lg shadow-black/20 transition-colors hover:border-slate-600/60 hover:bg-card">
      {/* Сцена: изо-портрет + статус-кольцо + флаг + бейдж хостера. Клик — детальный drawer. */}
      <div
        onClick={() => openDetail(s)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openDetail(s)
        }}
        aria-label={`Open ${s.name}`}
        className="relative h-44 cursor-pointer overflow-hidden rounded-lg bg-bg"
        style={{ boxShadow: `inset 0 0 0 1px ${st.hex}33${st.ring ? `, inset 0 -24px 48px -32px ${st.hex}55` : ''}` }}
      >
        <div
          className="pointer-events-none absolute inset-x-8 bottom-2 h-16"
          style={{ background: 'radial-gradient(ellipse at center, var(--color-glow) 0%, transparent 70%)' }}
        />
        <img
          src={deviceIllustration(s.kind, s.role)}
          alt=""
          draggable={false}
          className={cn('mx-auto h-full object-contain py-2 transition-opacity', dim && 'opacity-40 saturate-50')}
        />
        <div className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">
          <span className={cn('h-1.5 w-1.5 rounded-full', st.dot, s.status === 'reboot' && 'animate-pulse')} />
          <span className={cn('text-[11px] font-medium leading-none', st.text)}>{st.label}</span>
        </div>
        <div className="absolute right-2 top-2">
          <ProviderBadge provider={s.provider} size="sm" />
        </div>
        {s.flag && (
          <span
            className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-sm leading-none ring-1 ring-white/10 backdrop-blur-sm"
            title={s.country}
          >
            {s.flag}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-white">{s.name}</div>
          <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
            {s.user}@{s.ip || '—'}
            {s.role ? ` · ${s.role}` : ''}
          </div>
        </div>
        <div className="relative shrink-0" ref={ref}>
          <button
            onClick={() => setMenu((v) => !v)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="More"
          >
            <MoreVertical className="h-[18px] w-[18px]" />
          </button>
          {menu && (
            <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl">
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

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Bar label="CPU" value={pct(s.cpu)} percent={s.cpu} muted={dim} />
        <Bar label="RAM" value={`${s.ram.used}/${s.ram.total} GB`} percent={ramPct} muted={dim} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => openTerminal(s)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-bold text-bg transition-colors hover:bg-accent-hover"
        >
          <TerminalSquare className="h-3.5 w-3.5" /> SSH
        </button>
        {s.consoleUrl ? (
          <a
            href={s.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-slate-200 ring-1 ring-border transition-colors hover:bg-white/5"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Panel
          </a>
        ) : (
          <span className="flex flex-1 items-center justify-center rounded-lg px-3 py-2 text-xs text-slate-600 ring-1 ring-border/50">
            No console
          </span>
        )}
        {s.cost.amount > 0 && (
          <span className="shrink-0 rounded-md bg-white/5 px-2 py-1.5 text-xs font-medium tabular-nums text-slate-300">
            {money(s.cost.amount, s.cost.currency)}
            <span className="text-slate-500">/mo</span>
          </span>
        )}
      </div>
    </div>
  )
}
