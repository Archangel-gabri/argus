import { runLockdown } from './lockdown-policy'
import { closeAllScreens } from '../screen/screen'
import { closeAll as closeSsh } from '../remote/ssh'
import { sftpCloseAll } from '../remote/sftp'
import { closeAllForwards } from '../remote/forward'
import { clearPinnedHosts } from '../screen/agent'
import { clearAlerts } from '../watchdog'
import { lock as lockVault } from '../vault/vault'
import { revokePendingAccess } from '../vault/access-epoch'
import { clearInFlight } from '../support/single-flight'
import { clearReachMemory } from '../devices/reach-memory'

/** Единая граница блокировки: закрыть доступы и только затем зашифрованную БД. */
export function lockApplication(): void {
  runLockdown({
    revokePending: revokePendingAccess,
    closeScreens: closeAllScreens,
    closeSsh,
    closeSftp: sftpCloseAll,
    closeForwards: closeAllForwards,
    clearAgentPins: clearPinnedHosts,
    clearAlerts,
    clearInFlight,
    clearReachMemory,
    lockVault
  })
}
