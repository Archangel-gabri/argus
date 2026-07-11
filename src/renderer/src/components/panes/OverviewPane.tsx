import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money, pct } from '@/lib/format'
import { deviceIllustration } from '@/lib/illustrations'
import { STATUS, ProviderBadge } from '@/components/ServerCard'
import { useDevices } from '@/store/devices'
import type { DeviceDTO } from '@/types'

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-sm text-slate-200">{value || '—'}</div>
    </div>
  )
}

export function OverviewPane({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const st = STATUS[d.status]
  const jump = d.jumpId ? (devices.find((x) => x.id === d.jumpId)?.name ?? d.jumpId) : null
  const ramPct = d.ram.total ? (d.ram.used / d.ram.total) * 100 : 0

  return (
    <div className="h-full space-y-4 overflow-y-auto pr-1">
      <div
        className="relative h-56 overflow-hidden rounded-xl bg-bg"
        style={{ boxShadow: `inset 0 0 0 1px ${st.hex}33` }}
      >
        <div
          className="pointer-events-none absolute inset-x-12 bottom-3 h-20"
          style={{ background: 'radial-gradient(ellipse at center, var(--color-glow) 0%, transparent 70%)' }}
        />
        <img src={deviceIllustration(d.kind, d.role)} alt="" className="mx-auto h-full object-contain py-3" draggable={false} />
        <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">
          <span className={cn('h-1.5 w-1.5 rounded-full', st.dot, d.status === 'reboot' && 'animate-pulse')} />
          <span className={cn('text-[11px] font-medium leading-none', st.text)}>{st.label}</span>
        </div>
        <div className="absolute right-3 top-3">
          <ProviderBadge provider={d.provider} />
        </div>
        {d.flag && (
          <span className="absolute bottom-3 left-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-base leading-none ring-1 ring-white/10 backdrop-blur-sm">
            {d.flag}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Fact label="OS" value={d.os} />
        <Fact label="Страна" value={d.country} />
        <Fact label="Хост" value={`${d.ip || '—'}:${d.port}`} />
        <Fact label="Пользователь" value={d.user} />
        <Fact
          label="Авторизация"
          value={d.authType === 'key' ? 'SSH-ключ' : d.authType === 'password' ? 'пароль' : 'нет'}
        />
        <Fact label="Jump-host" value={jump ?? '—'} />
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/50 p-3 text-xs">
        <div>
          <div className="mb-1 flex justify-between">
            <span className="text-slate-500">CPU</span>
            <span className="tabular-nums text-slate-200">{pct(d.cpu)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-600/30">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, d.cpu))}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between">
            <span className="text-slate-500">RAM</span>
            <span className="tabular-nums text-slate-200">
              {d.ram.used}/{d.ram.total} GB
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-600/30">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, ramPct))}%` }} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2.5">
        {d.consoleUrl ? (
          <a
            href={d.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Hoster Console
          </a>
        ) : (
          <span className="text-xs text-slate-600">No console</span>
        )}
        {d.cost.amount > 0 && (
          <span className="text-xs font-medium tabular-nums text-slate-300">
            {money(d.cost.amount, d.cost.currency)}
            <span className="text-slate-500">/mo · ${d.cost.usd} норм.</span>
          </span>
        )}
      </div>

      {d.notes && (
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-card/50 p-3 text-xs text-slate-400">{d.notes}</p>
      )}
    </div>
  )
}
