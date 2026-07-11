import { useEffect, useMemo, useState } from 'react'
import { X, LayoutDashboard, TerminalSquare, FolderOpen, Network, Activity } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type DrawerTab } from '@/store/ui'
import { useDevices } from '@/store/devices'
import { isSshCapable } from '@/components/ServerCard'
import { OverviewPane } from '@/components/panes/OverviewPane'
import { TerminalPane } from '@/components/panes/TerminalPane'
import { FilesPane } from '@/components/panes/FilesPane'
import { ForwardsPane } from '@/components/panes/ForwardsPane'
import { MetricsPane } from '@/components/panes/MetricsPane'

const TABS: Array<{ id: DrawerTab; label: string; icon: typeof TerminalSquare }> = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'files', label: 'Файлы', icon: FolderOpen },
  { id: 'forwards', label: 'Порты', icon: Network },
  { id: 'metrics', label: 'Метрики', icon: Activity }
]

export function DeviceDrawer(): React.JSX.Element | null {
  const detail = useUI((s) => s.detail)
  const close = useUI((s) => s.closeDetail)
  const setTab = useUI((s) => s.setDetailTab)
  const devices = useDevices((s) => s.devices)
  const [visited, setVisited] = useState<DrawerTab[]>([])

  const deviceId = detail?.device.id
  const tab = detail?.tab

  // Живое устройство из стора (метрики обновляются поллингом), фолбэк — снапшот.
  const live = useMemo(
    () => (deviceId ? (devices.find((d) => d.id === deviceId) ?? detail?.device ?? null) : null),
    [devices, deviceId, detail?.device]
  )

  // Паспорт-устройства не имеют SSH-граней: любой не-overview таб откатываем на overview,
  // чтобы никакой вызов (например, openTerminal из палитры) не смонтировал SSH-панель.
  const sshCapable = live ? isSshCapable(live.kind) : true
  useEffect(() => {
    if (detail && tab && tab !== 'overview' && !sshCapable) setTab('overview')
  }, [detail, tab, sshCapable, setTab])

  // Сброс посещённых табов при смене устройства; накопление — при переключении.
  useEffect(() => {
    if (deviceId && tab) setVisited([tab])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])
  useEffect(() => {
    if (tab) setVisited((v) => (v.includes(tab) ? v : [...v, tab]))
  }, [tab])

  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, close])

  if (!detail || !live) return null

  const tabs = sshCapable ? TABS : TABS.filter((t) => t.id === 'overview')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={close}>
      <div
        className="flex h-full w-full max-w-[760px] flex-col border-l border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-white">{live.name}</div>
            <div className="truncate font-mono text-xs text-slate-500">
              {isSshCapable(live.kind) ? `${live.user}@${live.ip || '—'}:${live.port}` : live.os || live.provider}
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-card text-accent' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            )
          })}
        </div>

        <div className="relative min-h-0 flex-1">
          {visited.includes('overview') && (
            <div className={cn('absolute inset-4', tab !== 'overview' && 'hidden')}>
              <OverviewPane device={live} />
            </div>
          )}
          {visited.includes('terminal') && (
            <div className={cn('absolute inset-4', tab !== 'terminal' && 'hidden')}>
              <TerminalPane device={live} />
            </div>
          )}
          {visited.includes('files') && (
            <div className={cn('absolute inset-4', tab !== 'files' && 'hidden')}>
              <FilesPane device={live} />
            </div>
          )}
          {visited.includes('forwards') && (
            <div className={cn('absolute inset-4', tab !== 'forwards' && 'hidden')}>
              <ForwardsPane device={live} />
            </div>
          )}
          {visited.includes('metrics') && (
            <div className={cn('absolute inset-4', tab !== 'metrics' && 'hidden')}>
              <MetricsPane device={live} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
