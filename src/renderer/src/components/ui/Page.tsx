import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Page({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="h-full overflow-y-auto px-8 py-7">{children}</div>
}

export function PageHeader({
  title,
  subtitle,
  action
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Card({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={cn('rounded-xl border border-border bg-card/60 p-5', className)}>{children}</div>
}

export function StatTile({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  )
}

const BADGE = {
  live: 'text-accent bg-accent/10',
  manual: 'text-slate-400 bg-white/5',
  soon: 'text-amber-400 bg-amber-400/10'
} as const

export function SourceBadge({ kind }: { kind: 'live' | 'manual' | 'soon' }): React.JSX.Element {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', BADGE[kind])}>
      {kind}
    </span>
  )
}
