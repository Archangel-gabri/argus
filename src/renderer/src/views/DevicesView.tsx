import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useDevices } from '@/store/devices'
import { useUI } from '@/store/ui'
import { ServerCard } from '@/components/ServerCard'
import { InsightsPanel } from '@/components/InsightsPanel'
import { DeviceDialog } from '@/components/DeviceDialog'
import type { DeviceKind } from '@/types'

type FleetGroup = 'all' | 'servers' | 'personal' | 'network'

const groupOf = (k: DeviceKind): Exclude<FleetGroup, 'all'> =>
  k === 'server' ? 'servers' : k === 'router' ? 'network' : 'personal'

const GROUPS: Array<{ id: FleetGroup; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'servers', label: 'Servers' },
  { id: 'personal', label: 'Personal' },
  { id: 'network', label: 'Network' }
]

export function DevicesView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const refreshMetrics = useDevices((s) => s.refreshMetrics)
  const openCreate = useUI((s) => s.openCreate)
  const search = useUI((s) => s.search).trim().toLowerCase()
  const [refreshing, setRefreshing] = useState(false)
  const [group, setGroup] = useState<FleetGroup>('all')

  const inGroup = group === 'all' ? devices : devices.filter((d) => groupOf(d.kind) === group)
  const list = search
    ? inGroup.filter((d) =>
        `${d.name} ${d.provider} ${d.country} ${d.ip} ${d.os}`.toLowerCase().includes(search)
      )
    : inGroup
  const onlineCount = devices.filter((d) => d.status === 'online').length
  const countOf = (g: FleetGroup): number =>
    g === 'all' ? devices.length : devices.filter((d) => groupOf(d.kind) === g).length

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshMetrics()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex h-full">
      <section className="flex-1 overflow-y-auto px-8 py-7">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">Fleet</h1>
            <p className="mt-1 text-sm text-slate-500">
              {devices.length} устройств · {onlineCount} online
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded-lg p-2 text-slate-400 ring-1 ring-border transition-colors hover:bg-white/5 hover:text-slate-200 disabled:opacity-60"
              aria-label="Refresh live metrics over SSH"
              title="Refresh live CPU/RAM over SSH (devices with stored credentials)"
            >
              <RefreshCw className={cn('h-[18px] w-[18px]', refreshing && 'animate-spin')} />
            </button>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-1.5">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroup(g.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                group === g.id
                  ? 'bg-accent/15 text-accent ring-1 ring-accent/30'
                  : 'text-slate-400 ring-1 ring-border hover:bg-white/5 hover:text-slate-200'
              )}
            >
              {g.label}
              <span className="tabular-nums opacity-70">{countOf(g.id)}</span>
            </button>
          ))}
        </div>

        {devices.length === 0 ? (
          <button
            onClick={openCreate}
            className="w-full rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500 transition-colors hover:border-accent/40 hover:text-slate-300"
          >
            No devices yet — click to add your first server.
          </button>
        ) : list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500">
            No devices match “{search}”.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {list.map((d) => (
              <ServerCard key={d.id} s={d} />
            ))}
          </div>
        )}
      </section>

      <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-border bg-surface/40 px-6 py-7 xl:block">
        <InsightsPanel />
      </aside>

      <DeviceDialog />
    </div>
  )
}
