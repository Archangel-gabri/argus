import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { DevicesView } from './views/DevicesView'
import { BanksView } from './views/BanksView'
import { SubscriptionsView } from './views/SubscriptionsView'
import { AIAccountsView } from './views/AIAccountsView'
import { SettingsView } from './views/SettingsView'
import { LockScreen } from './components/LockScreen'
import { DeviceDrawer } from './components/DeviceDrawer'
import { CommandPalette } from './components/CommandPalette'
import { SshImportDialog } from './components/SshImportDialog'
import { BroadcastPanel } from './components/BroadcastPanel'
import { useUI, type ViewId } from './store/ui'
import { useVault } from './store/vault'
import { useDevices } from './store/devices'
import { useWallets } from './store/wallets'
import { useSubs } from './store/subs'
import { useAi } from './store/ai'
import { loadPrefs, savePrefs, PREFS_EVENT } from './lib/prefs'

function renderView(view: ViewId): React.JSX.Element {
  switch (view) {
    case 'banks':
      return <BanksView />
    case 'subscriptions':
      return <SubscriptionsView />
    case 'ai':
      return <AIAccountsView />
    case 'settings':
      return <SettingsView />
    default:
      return <DevicesView />
  }
}

export default function App(): React.JSX.Element {
  const status = useVault((s) => s.status)
  const refresh = useVault((s) => s.refresh)
  const view = useUI((s) => s.view)
  const loadDevices = useDevices((s) => s.load)
  const refreshMetrics = useDevices((s) => s.refreshMetrics)

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (status !== 'unlocked') return
    loadDevices()
    // Кросс-доменные сторы для Dashboard/палитры/бейджей.
    useWallets.getState().load()
    useSubs.getState().load()
    useAi.getState().load()
  }, [status, loadDevices])

  // UI-préfs (reduce-motion) применяются при старте.
  useEffect(() => {
    savePrefs(loadPrefs())
  }, [])

  // Авто-лок по бездействию (Settings → Security). 0 = выключен.
  // Значение кэшируется (не читаем localStorage на каждом mousemove); смена настройки
  // прилетает через PREFS_EVENT и пере-взводит таймер.
  useEffect(() => {
    if (status !== 'unlocked') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let min = loadPrefs().autolockMin
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      if (!min) return
      timer = setTimeout(() => useVault.getState().lock(), min * 60_000)
    }
    const onPrefs = (): void => {
      min = loadPrefs().autolockMin
      arm()
    }
    arm()
    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'wheel']
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }))
    window.addEventListener(PREFS_EVENT, onPrefs)
    return () => {
      if (timer) clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, arm))
      window.removeEventListener(PREFS_EVENT, onPrefs)
    }
  }, [status])

  // Poll agentless metrics while unlocked so history + sparklines accumulate.
  useEffect(() => {
    if (status !== 'unlocked') return
    refreshMetrics()
    const t = setInterval(() => refreshMetrics(), 90000)
    return () => clearInterval(t)
  }, [status, refreshMetrics])

  if (status !== 'unlocked') return <LockScreen />

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <main className="flex-1 overflow-hidden">{renderView(view)}</main>
      <DeviceDrawer />
      <CommandPalette />
      <SshImportDialog />
      <BroadcastPanel />
    </div>
  )
}
