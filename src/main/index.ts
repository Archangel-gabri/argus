import { app, BrowserWindow, session } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { createAppWindow } from './windows'
import { certPinMatches } from './agent'
import { startWatchdog, stopWatchdog } from './watchdog'
import { lockApplication } from './lockdown'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.argus.app')

  // Strict CSP in production only (dev stays relaxed so Vite HMR works).
  //
  // ARGUS_FORCE_CSP=1 включает её и в незапакованном запуске. Нужно для E2E: `is.dev` — это
  // `!app.isPackaged`, поэтому запуск из исходников политику не ставит, и проверить её иначе
  // можно было бы только на собранном AppImage. Флаг умеет лишь УЖЕСТОЧИТЬ, ослабить им нельзя.
  if (!is.dev || process.env.ARGUS_FORCE_CSP === '1') {
    const BASE =
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self' data:; script-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:*"
    // Окно экрана ходит к агенту НА АДРЕС УСТРОЙСТВА (wss://100.x…), а не на loopback, поэтому
    // ему нужен более широкий connect-src. Расширяем ТОЛЬКО эту страницу: у основного окна
    // политика остаётся прежней. Подмену сертификата это не открывает — его проверяет пиннинг.
    const SCREEN = `${BASE} wss:`
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      const forScreen = details.url.includes('screen.html')
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [forScreen ? SCREEN : BASE]
        }
      })
    })
  }

  // Сертификат агента самоподписанный, публичного центра сертификации у машины нет — поэтому
  // Chromium его отвергнет. Разрешаем РОВНО закреплённый сертификат конкретного хоста (TOFU,
  // как host-key у SSH) и ничего больше: всё остальное проходит обычную проверку Chromium.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (certPinMatches(request.hostname, request.certificate.data)) {
      callback(0) // доверяем: это тот самый сертификат, что мы прочитали по SSH при установке
      return
    }
    callback(-3) // -3 = решение остаётся за Chromium (штатная проверка цепочки)
  })

  // Renderer не должен сам получать камеры/микрофон/геолокацию и прочие Chromium-permissions.
  // Нужные возможности Argus реализует строго через валидируемый main IPC.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Vault + devices IPC (validated handlers live in ./ipc).
  registerIpc()

  createAppWindow()

  // Сторож: сообщает о падении машины, кончающемся диске и о продлении, которое надо
  // сделать руками, — не дожидаясь, пока приложение откроют и посмотрят.
  startWatchdog()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close SSH sessions + the encrypted DB connection on exit.
app.on('will-quit', () => {
  stopWatchdog()
  lockApplication()
})
