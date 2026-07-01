import { useEffect, type ReactNode } from 'react'
import { Command } from 'cmdk'
import {
  Search,
  Server,
  LayoutDashboard,
  Landmark,
  Repeat,
  MonitorPlay,
  Bot,
  TerminalSquare,
  Plus,
  RefreshCw,
  Lock,
  FileDown,
  Radio,
  Radar,
  type LucideIcon
} from 'lucide-react'
import { useUI, type ViewId } from '@/store/ui'
import { useDevices } from '@/store/devices'
import { useVault } from '@/store/vault'
import { MOCK_SUBSCRIPTIONS } from '@/data/subscriptions'
import { MOCK_AI } from '@/data/ai'
import { MOCK_HOLDINGS } from '@/data/finance'

const VIEWS: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'devices', label: 'Devices', icon: Server },
  { id: 'banks', label: 'Banks', icon: Landmark },
  { id: 'subscriptions', label: 'Subscriptions', icon: Repeat },
  { id: 'streaming', label: 'Streaming', icon: MonitorPlay },
  { id: 'ai', label: 'AI Accounts', icon: Bot }
]

const GROUP =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-slate-500'

function Item({
  icon: Icon,
  children,
  onSelect,
  value,
  right
}: {
  icon?: LucideIcon
  children: ReactNode
  onSelect: () => void
  value?: string
  right?: string
}): React.JSX.Element {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 aria-selected:bg-white/5 aria-selected:text-white"
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-400" />}
      <span className="flex-1 truncate">{children}</span>
      {right && <span className="shrink-0 font-mono text-xs text-slate-500">{right}</span>}
    </Command.Item>
  )
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useUI((s) => s.palette)
  const setPalette = useUI((s) => s.setPalette)
  const setView = useUI((s) => s.setView)
  const openCreate = useUI((s) => s.openCreate)
  const openTerminal = useUI((s) => s.openTerminal)
  const devices = useDevices((s) => s.devices)
  const refreshMetrics = useDevices((s) => s.refreshMetrics)
  const setSshImport = useUI((s) => s.setSshImport)
  const setBroadcast = useUI((s) => s.setBroadcast)
  const lock = useVault((s) => s.lock)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!open)
      } else if (e.key === 'Escape' && open) {
        setPalette(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setPalette])

  const run = (fn: () => void): void => {
    setPalette(false)
    fn()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onMouseDown={() => setPalette(false)}
    >
      <Command
        label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <Command.Input
            autoFocus
            placeholder="Найти сервер, вкладку, команду…"
            className="w-full bg-transparent py-3 text-sm text-slate-200 outline-none placeholder:text-slate-500"
          />
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-slate-500">
            Ничего не найдено.
          </Command.Empty>

          <Command.Group heading="Перейти" className={GROUP}>
            {VIEWS.map((v) => (
              <Item key={v.id} icon={v.icon} value={`go ${v.label}`} onSelect={() => run(() => setView(v.id))}>
                {v.label}
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="Серверы" className={GROUP}>
            {devices.map((d) => (
              <Item
                key={d.id}
                icon={TerminalSquare}
                value={`server ${d.name} ${d.ip} ${d.provider} ${d.country}`}
                right={d.ip}
                onSelect={() =>
                  run(() => {
                    setView('devices')
                    openTerminal(d)
                  })
                }
              >
                {d.name} <span className="text-slate-500">— подключиться</span>
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="Подписки" className={GROUP}>
            {MOCK_SUBSCRIPTIONS.map((s) => (
              <Item
                key={s.id}
                icon={Repeat}
                value={`sub ${s.name} ${s.category}`}
                onSelect={() => run(() => setView('subscriptions'))}
              >
                {s.name}
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="ИИ-аккаунты" className={GROUP}>
            {MOCK_AI.map((a) => (
              <Item key={a.id} icon={Bot} value={`ai ${a.provider} ${a.plan}`} onSelect={() => run(() => setView('ai'))}>
                {a.provider}
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="Активы" className={GROUP}>
            {MOCK_HOLDINGS.map((h) => (
              <Item key={h.id} icon={Landmark} value={`holding ${h.name}`} onSelect={() => run(() => setView('banks'))}>
                {h.name}
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="Команды" className={GROUP}>
            <Item
              icon={Plus}
              value="add device new server"
              onSelect={() =>
                run(() => {
                  setView('devices')
                  openCreate()
                })
              }
            >
              Добавить устройство
            </Item>
            <Item icon={RefreshCw} value="refresh metrics" onSelect={() => run(() => refreshMetrics())}>
              Обновить метрики
            </Item>
            <Item
              icon={FileDown}
              value="import ssh config"
              onSelect={() =>
                run(() => {
                  setView('devices')
                  setSshImport('ssh')
                })
              }
            >
              Импорт ~/.ssh/config
            </Item>
            <Item
              icon={Radar}
              value="discover tailscale tailnet peers"
              onSelect={() =>
                run(() => {
                  setView('devices')
                  setSshImport('tailscale')
                })
              }
            >
              Обнаружить Tailscale
            </Item>
            <Item
              icon={Radio}
              value="broadcast multi exec run on many hosts"
              onSelect={() =>
                run(() => {
                  setView('devices')
                  setBroadcast(true)
                })
              }
            >
              Broadcast (много хостов)
            </Item>
            <Item icon={Lock} value="lock vault" onSelect={() => run(() => lock())}>
              Заблокировать vault
            </Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  )
}
