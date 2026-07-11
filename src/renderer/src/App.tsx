import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { DashboardView } from './views/DashboardView'
import { DevicesView } from './views/DevicesView'
import { BanksView } from './views/BanksView'
import { SubscriptionsView } from './views/SubscriptionsView'
import { StreamingView } from './views/StreamingView'
import { AIAccountsView } from './views/AIAccountsView'
import { LockScreen } from './components/LockScreen'
import { DeviceDrawer } from './components/DeviceDrawer'
import { CommandPalette } from './components/CommandPalette'
import { SshImportDialog } from './components/SshImportDialog'
import { BroadcastPanel } from './components/BroadcastPanel'
import { useUI, type ViewId } from './store/ui'
import { useVault } from './store/vault'
import { useDevices } from './store/devices'

function renderView(view: ViewId): React.JSX.Element {
  switch (view) {
    case 'devices':
      return <DevicesView />
    case 'banks':
      return <BanksView />
    case 'subscriptions':
      return <SubscriptionsView />
    case 'streaming':
      return <StreamingView />
    case 'ai':
      return <AIAccountsView />
    default:
      return <DashboardView />
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
    if (status === 'unlocked') loadDevices()
  }, [status, loadDevices])

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
