import { runLockdown } from './lockdown-policy'
import { closeAllScreens } from './screen'
import { closeAll as closeSsh } from './ssh'
import { sftpCloseAll } from './sftp'
import { closeAllForwards } from './forward'
import { clearPinnedHosts } from './agent'
import { clearAlerts } from './watchdog'
import { lock as lockVault } from './vault'
import { revokePendingAccess } from './access-epoch'

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
    lockVault
  })
}
