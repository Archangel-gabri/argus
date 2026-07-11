import {
  Search,
  LayoutDashboard,
  Server,
  Landmark,
  Repeat,
  Bot,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type ViewId } from '@/store/ui'
import { useDevices } from '@/store/devices'
import { useAi } from '@/store/ai'
import eyeMark from '@/assets/brand/argus-eye.png'

interface NavItem {
  id: ViewId
  label: string
  icon: LucideIcon
}

const GENERAL: NavItem[] = [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }]

const INFRA: NavItem[] = [
  { id: 'devices', label: 'Fleet', icon: Server },
  { id: 'banks', label: 'Finance', icon: Landmark },
  { id: 'subscriptions', label: 'Subscriptions', icon: Repeat },
  { id: 'ai', label: 'AI', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings }
]

function NavRow({ item, badge }: { item: NavItem; badge?: number }): React.JSX.Element {
  const view = useUI((s) => s.view)
  const setView = useUI((s) => s.setView)
  const active = view === item.id
  const Icon = item.icon
  return (
    <button
      onClick={() => setView(item.id)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        active ? 'bg-card text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      <Icon
        className={cn(
          'h-[18px] w-[18px] shrink-0',
          active ? 'text-accent' : 'text-slate-400 group-hover:text-slate-200'
        )}
      />
      <span className="flex-1 text-left font-medium">{item.label}</span>
      {badge != null && badge > 0 && (
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
            active ? 'bg-accent/15 text-accent' : 'bg-white/5 text-slate-400'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

export function Sidebar(): React.JSX.Element {
  const search = useUI((s) => s.search)
  const setSearch = useUI((s) => s.setSearch)
  const setView = useUI((s) => s.setView)
  const deviceCount = useDevices((s) => s.devices.length)
  const aiCount = useAi((s) => s.accounts.length)
  const badges: Partial<Record<ViewId, number>> = { devices: deviceCount, ai: aiCount }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl ring-1 ring-accent/30">
          <img src={eyeMark} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold text-white">Argus</div>
          <div className="text-[11px] text-slate-500">command center</div>
        </div>
      </div>

      <div className="px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Quick search…"
            className="w-full rounded-lg border border-border bg-bg/60 py-2 pl-9 pr-3 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          />
        </div>
      </div>

      <nav className="mt-1 flex-1 overflow-y-auto pb-4">
        <div className="px-3">
          <div className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            General
          </div>
          <div className="space-y-0.5">
            {GENERAL.map((i) => (
              <NavRow key={i.id} item={i} badge={badges[i.id]} />
            ))}
          </div>
        </div>
        <div className="px-3">
          <div className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Infrastructure
          </div>
          <div className="space-y-0.5">
            {INFRA.map((i) => (
              <NavRow key={i.id} item={i} badge={badges[i.id]} />
            ))}
          </div>
        </div>
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-accent/30 to-indigo-500/30 text-sm font-semibold text-white ring-1 ring-white/10">
            DK
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-white">Danya Kubrak</div>
            <div className="truncate text-[11px] text-slate-500">owner · HubVPN</div>
          </div>
          <button
            onClick={() => setView('settings')}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"
            aria-label="Settings"
          >
            <Settings className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
    </aside>
  )
}
