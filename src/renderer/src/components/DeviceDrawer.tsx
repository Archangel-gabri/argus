import { useEffect, useMemo, useState } from 'react'
import { X, LayoutDashboard, TerminalSquare, FolderOpen, Network, Activity, MonitorPlay } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type DrawerTab } from '@/store/ui'
import { useDevices } from '@/store/devices'
import { isSshCapable } from '@/components/ServerCard'
import { OverviewPane } from '@/components/panes/OverviewPane'
import { TerminalPane } from '@/components/panes/TerminalPane'
import { FilesPane } from '@/components/panes/FilesPane'
import { ForwardsPane } from '@/components/panes/ForwardsPane'
import { MetricsPane } from '@/components/panes/MetricsPane'
import { ScreenPane } from '@/components/panes/ScreenPane'
import type { DeviceDTO } from '@/types'

const TABS: Array<{ id: DrawerTab; label: string; icon: typeof TerminalSquare }> = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'files', label: 'Файлы', icon: FolderOpen },
  { id: 'forwards', label: 'Порты', icon: Network },
  { id: 'metrics', label: 'Метрики', icon: Activity },
  { id: 'screen', label: 'Экран', icon: MonitorPlay }
]

function paneFor(tab: DrawerTab, device: DeviceDTO): React.JSX.Element {
  switch (tab) {
    case 'terminal':
      return <TerminalPane device={device} />
    case 'files':
      return <FilesPane device={device} />
    case 'forwards':
      return <ForwardsPane device={device} />
    case 'metrics':
      return <MetricsPane device={device} />
    case 'screen':
      return <ScreenPane device={device} />
    default:
      return <OverviewPane device={device} />
  }
}

/** Панели монтируются ЛЕНИВО при первом заходе и остаются смонтированными (скрыты `hidden`),
 *  пока drawer открыт. Иначе переключение на «Файлы» размонтировало терминал, и его cleanup
 *  убивал живую SSH-сессию (htop/tail -f/деплой обрывались). Сессии НЕ открываются для
 *  непосещённых вкладок — нет утечки. Смена устройства (key={device.id} на месте вызова)
 *  ремонтирует тело → cleanup всех панелей закрывает их сессии. */
/** Адрес ЗАПУЩЕННОЙ ОС, а не основной записи. У двухзагрузочного ПК под Windows шапка показывала
 *  адрес Linux-половины — то есть данные из карточки относились к одной ОС, а адрес к другой. */
function endpointLabel(d: DeviceDTO): string {
  const alt = d.runningOs ? d.altOs.find((a) => a.os === d.runningOs) : undefined
  const user = alt?.user || d.user
  const ip = alt?.ip || d.ip
  return `${user}@${ip || '—'}:${d.port}`
}

function DrawerBody({ activeTab, device }: { activeTab: DrawerTab; device: DeviceDTO }): React.JSX.Element {
  const [visited, setVisited] = useState<DrawerTab[]>([activeTab])
  useEffect(() => {
    setVisited((v) => (v.includes(activeTab) ? v : [...v, activeTab]))
  }, [activeTab])
  return (
    <>
      {visited.map((tab) => (
        <div key={tab} className={cn('h-full', tab === activeTab ? 'block' : 'hidden')}>
          {paneFor(tab, device)}
        </div>
      ))}
    </>
  )
}

export function DeviceDrawer(): React.JSX.Element | null {
  const detail = useUI((s) => s.detail)
  const close = useUI((s) => s.closeDetail)
  const setTab = useUI((s) => s.setDetailTab)
  const devices = useDevices((s) => s.devices)

  const deviceId = detail?.device.id

  // Живое устройство из стора (метрики обновляются поллингом), фолбэк — снапшот.
  const live = useMemo(
    () => (deviceId ? (devices.find((d) => d.id === deviceId) ?? detail?.device ?? null) : null),
    [devices, deviceId, detail?.device]
  )

  // Устройство удалили, пока карточка открыта — карточку надо закрыть.
  //
  // Запасной вариант ниже (снимок на момент открытия) существует для первой отрисовки, пока
  // список ещё грузится. Но для УДАЛЁННОГО устройства он превращался в призрак: карточка
  // оставалась на экране, терминал и файлы продолжали ходить к записи, которой в хранилище
  // больше нет, и отвечали невнятными ошибками. Поэтому закрываем — но только когда список
  // точно загружен, иначе закрывали бы карточку на каждом старте.
  const loaded = useDevices((s) => s.loaded)
  useEffect(() => {
    if (!detail || !loaded || !deviceId) return
    if (!devices.some((d) => d.id === deviceId)) close()
  }, [loaded, devices, deviceId, detail, close])

  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, close])

  if (!detail || !live) return null

  const sshCapable = isSshCapable(live.kind)
  // Вкладка «Экран» — только для ПК (у серверов обычно нет графической сессии).
  const tabs = sshCapable ? TABS.filter((t) => t.id !== 'screen' || live.kind === 'pc') : TABS.filter((t) => t.id === 'overview')
  // Синхронно: не-SSH устройство никогда не отрисовывает SSH-грань, даже если стор просит
  // (например openTerminal попал на паспорт). Никакой панели-гонки — чистое выражение.
  const activeTab: DrawerTab = sshCapable ? (detail.tab ?? 'overview') : 'overview'

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
              {sshCapable ? endpointLabel(live) : live.os || live.provider}
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
            const active = activeTab === t.id
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

        <div className="min-h-0 flex-1 p-4">
          <DrawerBody key={live.id} activeTab={activeTab} device={live} />
        </div>
      </div>
    </div>
  )
}
