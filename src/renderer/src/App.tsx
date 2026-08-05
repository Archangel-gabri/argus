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
import { Toasts } from './components/Toasts'
import { SshImportDialog } from './components/SshImportDialog'
import { BroadcastPanel } from './components/BroadcastPanel'
import { useUI, type ViewId } from './store/ui'
import { useVault } from './store/vault'
import { useDevices } from './store/devices'
import { useWallets } from './store/wallets'
import { useSubs } from './store/subs'
import { useAi } from './store/ai'
import { useAccounts } from './store/accounts'
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
  const refreshLiveness = useDevices((s) => s.refreshLiveness)

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (status !== 'unlocked') {
      // Lock — не только другая картинка. Убираем чувствительные DTO и незавершённые UI-состояния
      // из памяти renderer, чтобы после повторного входа ничего не «воскресало» из старой сессии.
      useDevices.setState({ devices: [], loaded: false })
      useWallets.setState({
        wallets: [],
        balances: {},
        balanceLoading: {},
        balanceErrors: {},
        loaded: false,
        loading: false,
        error: null
      })
      useSubs.setState({ subs: [], loaded: false, loading: false, error: null })
      // Счета — это остатки, учреждения и признак «ключи заведены». Их забыли здесь одними, и
      // после блокировки экран «Финансы» рисовал деньги ПРОШЛОЙ сессии до первого ответа main.
      useAccounts.setState({ accounts: [], loaded: false, loading: false, error: null })
      useAi.setState({
        access: [],
        checks: {},
        lastOk: {},
        quotas: {},
        prices: [],
        models: {},
        usage: [],
        blocks: [],
        usageCollectedAt: null,
        unpriced: [],
        loaded: false,
        loading: false,
        error: null,
        checking: {}
      })
      useUI.setState({
        dialog: { mode: 'closed' },
        detail: null,
        palette: false,
        sshImport: false,
        broadcast: false,
        search: ''
      })
      return
    }
    loadDevices()
    // Кросс-доменные сторы для Dashboard/палитры/бейджей.
    useWallets.getState().load()
    useSubs.getState().load()
    useAi.getState().load()
    useAccounts.getState().load()
  }, [status, loadDevices])

  // Фоновый сбор — расход из логов, квоты провайдеров, пароли, модели, остатки бирж — идёт
  // секундами позже разблокировки и до сих пор оставался невидимым: main рассылал событие, а в
  // renderer его никто не слушал. Экран показывал прежние данные до перезапуска приложения.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (status !== 'unlocked' || !api?.ai?.onUpdated) return
    return api.ai.onUpdated(({ reason }) => {
      // Перечитывает тот, кого касается: лишний поход в базу дешевле, но экран от него мигает.
      if (reason === 'accounts-balance') void useAccounts.getState().load()
      else void useAi.getState().load(true)
    })
  }, [status])

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
    // Два контура вместо одного: живость дешёвая (TCP, мс) — гоняем часто; полные метрики
    // дорогие (SSH, секунды) — реже. Раньше был один контур раз в 90с, поэтому после входа
    // сетка стояла пустой около минуты.
    void refreshLiveness()
    void refreshMetrics()
    const fast = setInterval(() => void refreshLiveness(), 10000)
    const t = setInterval(() => refreshMetrics(), 30000)
    return () => {
      clearInterval(fast)
      clearInterval(t)
    }
  }, [status, refreshMetrics, refreshLiveness])

  if (status !== 'unlocked')
    return (
      <>
        <LockScreen />
        <Toasts />
      </>
    )

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <main className="flex-1 overflow-hidden">{renderView(view)}</main>
      <DeviceDrawer />
      <CommandPalette />
      <SshImportDialog />
      <BroadcastPanel />
      {/* Поверх всего и вне любого диалога: сообщение об отказе должно пережить закрытие
          окна, в котором отказ произошёл, — иначе его нечем прочитать. */}
      <Toasts />
    </div>
  )
}
