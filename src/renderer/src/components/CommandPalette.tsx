import { useEffect, useRef, type ReactNode } from 'react'
import { Command } from 'cmdk'
import {
  Search,
  Server,
  Landmark,
  Repeat,
  Bot,
  Settings,
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
import { isSshCapable } from '@/components/ServerCard'
import { useVault } from '@/store/vault'
import { useSubs } from '@/store/subs'
import { useAi } from '@/store/ai'
import { useWallets } from '@/store/wallets'
import { useOverlayA11y } from '@/lib/overlay'

const VIEWS: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: 'devices', label: 'Парк', icon: Server },
  { id: 'banks', label: 'Финансы', icon: Landmark },
  { id: 'subscriptions', label: 'Подписки', icon: Repeat },
  { id: 'ai', label: 'ИИ', icon: Bot },
  { id: 'settings', label: 'Настройки', icon: Settings }
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
  const openDetail = useUI((s) => s.openDetail)
  const devices = useDevices((s) => s.devices)
  const refreshMetrics = useDevices((s) => s.refreshMetrics)
  const setSshImport = useUI((s) => s.setSshImport)
  const setBroadcast = useUI((s) => s.setBroadcast)
  const lock = useVault((s) => s.lock)
  const subs = useSubs((s) => s.subs)
  const aiAccounts = useAi((s) => s.access)
  const wallets = useWallets((s) => s.wallets)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useOverlayA11y({
    open,
    onEscape: () => setPalette(false),
    containerRef: rootRef,
    initialFocusRef: inputRef
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!open)
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
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Палитра команд"
        label="Палитра команд"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <Command.Input
            ref={inputRef}
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

          <Command.Group heading="Устройства" className={GROUP}>
            {devices.map((d) => {
              const ssh = isSshCapable(d.kind)
              return (
                <Item
                  key={d.id}
                  icon={TerminalSquare}
                  value={`device ${d.name} ${d.ip} ${d.provider} ${d.country}`}
                  right={d.ip}
                  onSelect={() =>
                    run(() => {
                      setView('devices')
                      if (ssh) openTerminal(d)
                      else openDetail(d)
                    })
                  }
                >
                  {d.name}{' '}
                  <span className="text-slate-500">— {ssh ? 'подключиться' : 'открыть'}</span>
                </Item>
              )
            })}
          </Command.Group>

          {subs.length > 0 && (
            <Command.Group heading="Подписки" className={GROUP}>
              {subs.map((s) => (
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
          )}

          {aiAccounts.length > 0 && (
            <Command.Group heading="ИИ-доступы" className={GROUP}>
              {aiAccounts.map((a) => (
                <Item key={a.id} icon={Bot} value={`ai ${a.provider} ${a.label}`} onSelect={() => run(() => setView('ai'))}>
                  {a.label}
                </Item>
              ))}
            </Command.Group>
          )}

          {wallets.length > 0 && (
            <Command.Group heading="Кошельки" className={GROUP}>
              {wallets.map((w) => (
                <Item
                  key={w.id}
                  icon={Landmark}
                  value={`wallet ${w.label} ${w.chain}`}
                  right={w.chain}
                  onSelect={() => run(() => setView('banks'))}
                >
                  {w.label}
                </Item>
              ))}
            </Command.Group>
          )}

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
              Выполнить на многих
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
