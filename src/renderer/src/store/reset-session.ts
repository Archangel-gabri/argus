import { invalidateSession } from './session-lifetime'
import { resetAccounts } from './accounts'
import { resetSubs } from './subs'
import { resetDevices } from './devices'
import { resetWallets } from './wallets'
import { resetAi } from './ai'
import { useUI } from './ui'

/** No await and no IPC: concealment is local even if the main lock acknowledgement is lost. */
export function resetRendererSession(): void {
  // Invalidate first, so store subscribers cannot start replacement work during the clears.
  invalidateSession()
  resetAccounts()
  resetSubs()
  resetDevices()
  resetWallets()
  resetAi()
  useUI.setState({
    dialog: { mode: 'closed' }, detail: null, palette: false,
    sshImport: false, broadcast: false, search: ''
  })
}
