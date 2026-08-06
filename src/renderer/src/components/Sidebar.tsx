import { Search, Server, Landmark, Repeat, Bot, Settings, Lock, ShieldCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type ViewId } from '@/store/ui'
import { useDevices } from '@/store/devices'
import { useAi } from '@/store/ai'
import { useVault } from '@/store/vault'
import eyeMark from '@/assets/brand/argus-eye.png'

interface NavItem {
  id: ViewId
  label: string
  icon: LucideIcon
}

const INFRA: NavItem[] = [
  { id: 'devices', label: 'Парк', icon: Server },
  { id: 'banks', label: 'Финансы', icon: Landmark },
  { id: 'subscriptions', label: 'Подписки', icon: Repeat },
  { id: 'ai', label: 'ИИ', icon: Bot },
  { id: 'settings', label: 'Настройки', icon: Settings }
]

function NavRow({ item, badge }: { item: NavItem; badge?: number }): React.JSX.Element {
  const view = useUI((s) => s.view)
  const setView = useUI((s) => s.setView)
  const active = view === item.id
  const Icon = item.icon
  return (
    <button
      onClick={() => setView(item.id)}
      aria-current={active ? 'page' : undefined}
      // Без явного имени бейдж слипается с названием, и кнопка называется «Парк8»: и программе
      // чтения с экрана, и тесту. Счётчик проговариваем словами — он часть смысла пункта.
      aria-label={badge != null && badge > 0 ? `${item.label}, ${badge}` : item.label}
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
  const deviceCount = useDevices((s) => s.devices.length)
  // Та же формула, что на самом экране ИИ: неоформленные там не считаются доступами. Пока
  // меню считало все записи, оно писало «ИИ 14» при десяти доступах на открытом экране.
  const aiCount = useAi((s) => s.access.filter((a) => a.status !== 'planned').length)
  const badges: Partial<Record<ViewId, number>> = { devices: deviceCount, ai: aiCount }
  const locked = useVault((s) => s.status) !== 'unlocked'
  const lock = useVault((s) => s.lock)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl ring-1 ring-accent/30">
          <img src={eyeMark} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold text-white">Argus</div>
          <div className="text-[11px] text-slate-400">командный центр</div>
        </div>
      </div>

      <div className="px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            aria-label="Поиск по парку"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск…"
            className="w-full rounded-lg border border-border bg-bg/60 py-2 pl-9 pr-3 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          />
        </div>
      </div>

      <nav className="mt-1 flex-1 overflow-y-auto pb-4">
        <div className="px-3 pt-3">
          <div className="space-y-0.5">
            {INFRA.map((i) => (
              <NavRow key={i.id} item={i} badge={badges[i.id]} />
            ))}
          </div>
        </div>
      </nav>

      <div className="border-t border-border p-3">
        {/* Здесь была карточка «Danya Kubrak · owner · HubVPN» — выдуманная личность, вшитая
            строкой в разметку: приложение однопользовательское, и рассказывать владельцу, как
            его зовут, ему незачем. Тем более что имя было чужое (Danya — имя учётной записи в
            системе). Вместо этого место занято тем, что действительно меняется и о чём полезно
            знать: открыто ли хранилище с секретами. */}
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full ring-1',
              locked ? 'bg-slate-800 text-slate-400 ring-white/10' : 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/20'
            )}
          >
            {locked ? <Lock className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-white">
              {locked ? 'Закрыто' : 'Открыто'}
            </div>
            <div className="truncate text-[11px] text-slate-400">
              {locked ? 'секреты недоступны' : 'секреты доступны'}
            </div>
          </div>
          {/* Шестерёнки здесь больше нет: «Настройки» — обычный пункт списка выше, и вторая
              дорога к ним отнимала ширину у подписи. Осталось действие, которого больше нигде
              нет, — закрыть хранилище, не выходя из приложения. */}
          {!locked && (
            <button
              onClick={() => void lock()}
              className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              aria-label="Закрыть хранилище"
              title="Закрыть хранилище — секреты станут недоступны до следующего ввода пароля"
            >
              <Lock className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
