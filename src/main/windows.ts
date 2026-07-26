// Фабрика окон. ВСЕ окна приложения создаются только здесь — иначе hardened-настройки
// главного окна и дочерних неизбежно разъезжаются, и дочернее окно становится дырой.
// CSP вешается один раз на session.defaultSession (см. index.ts) и накрывает все окна.
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/** Единственный набор настроек безопасности рендерера. Менять только здесь. */
const HARDENED = {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true
} as const

const ICON = join(__dirname, '../../resources/icon.png')

interface WindowOptions {
  page: 'index' | 'screen'
  hash?: string
  title?: string
  width: number
  height: number
  minWidth: number
  minHeight: number
}

function createWindow(o: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: o.width,
    height: o.height,
    minWidth: o.minWidth,
    minHeight: o.minHeight,
    title: o.title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121110',
    icon: ICON,
    webPreferences: { ...HARDENED }
  })

  win.on('ready-to-show', () => win.show())

  // Внешние ссылки — в браузер ОС, никогда внутрь приложения.
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = `${process.env['ELECTRON_RENDERER_URL']}/${o.page}.html`
    void win.loadURL(o.hash ? `${base}#${o.hash}` : base)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${o.page}.html`), o.hash ? { hash: o.hash } : undefined)
  }
  return win
}

/** Главное окно Argus. */
export function createAppWindow(): BrowserWindow {
  return createWindow({
    page: 'index',
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720
  })
}

/** Отдельное окно «экран ПК». Родной фрейм ОС — свернуть/закрыть/полный экран бесплатно. */
export function createScreenWindow(handle: string, title: string, size: { width: number; height: number }): BrowserWindow {
  return createWindow({
    page: 'screen',
    hash: handle,
    title,
    width: size.width,
    height: size.height,
    minWidth: 640,
    minHeight: 400
  })
}
