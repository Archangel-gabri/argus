import { app, BrowserWindow, session } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { createAppWindow } from './windows'
import { lock as lockVault } from './vault'
import { closeAll as closeSsh } from './ssh'
import { sftpCloseAll } from './sftp'
import { closeAllForwards } from './forward'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.argus.app')

  // Strict CSP in production only (dev stays relaxed so Vite HMR works).
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' https: ws://127.0.0.1:* wss://127.0.0.1:*; script-src 'self'"
          ]
        }
      })
    })
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Vault + devices IPC (validated handlers live in ./ipc).
  registerIpc()

  createAppWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close SSH sessions + the encrypted DB connection on exit.
app.on('will-quit', () => {
  closeSsh()
  sftpCloseAll()
  closeAllForwards()
  lockVault()
})
