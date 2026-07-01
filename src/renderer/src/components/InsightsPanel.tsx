import { Plus, Zap, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { money } from '@/lib/format'
import { useDevices, totals } from '@/store/devices'
import { useUI } from '@/store/ui'
import { SpendPie } from './SpendPie'

function Title({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2">
      {Icon && <Icon className="h-4 w-4 text-accent" />}
      <h2 className="text-sm font-semibold text-white">{children}</h2>
    </div>
  )
}

export function InsightsPanel(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const openCreate = useUI((s) => s.openCreate)
  const { monthly, yearly } = totals(devices)
  const quick = devices[0] ? `${devices[0].user}@${devices[0].ip || devices[0].id}` : 'root@host'

  return (
    <div className="space-y-7">
      <button
        onClick={openCreate}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-bold text-bg transition-colors hover:bg-accent-hover"
      >
        <Plus className="h-[18px] w-[18px]" /> Add New Device
      </button>

      <section>
        <Title icon={Zap}>Quick Connect</Title>
        <div className="flex items-center gap-2">
          <input
            defaultValue={quick}
            key={quick}
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg/60 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          />
          <button className="shrink-0 rounded-lg bg-card px-3.5 py-2 text-sm font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover">
            Connect
          </button>
        </div>
      </section>

      <section>
        <Title>Costs Overview</Title>
        <div className="rounded-xl border border-border bg-card/60 p-4">
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-slate-400">Total Monthly</span>
            <span className="text-lg font-semibold tabular-nums text-white">{money(monthly)}</span>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-slate-400">Total Yearly</span>
            <span className="text-lg font-semibold tabular-nums text-white">{money(yearly)}</span>
          </div>
        </div>
      </section>

      <section>
        <Title>Infrastructure Spend</Title>
        <SpendPie />
      </section>
    </div>
  )
}
