// Фабрика окон. ВСЕ окна приложения создаются только здесь — иначе hardened-настройки
// главного окна и дочерних неизбежно разъезжаются, и дочернее окно становится дырой.
// CSP вешается один раз на session.defaultSession (см. index.ts) и накрывает все окна.
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { isSafeExternalUrl } from './navigation'

/** Единственный набор настроек безопасности рендерера. Менять только здесь. */
const HARDENED = {
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
    webPreferences: {
      ...HARDENED,
      // Разные окна — разные полномочия. Screen получает только claim/window/clipboard.
      preload: join(__dirname, `../preload/${o.page === 'screen' ? 'screen' : 'index'}.js`)
    }
  })

  win.on('ready-to-show', () => win.show())

  // Внешние ссылки — в браузер ОС, никогда внутрь приложения.
  win.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // SPA не должна уходить со своей локальной страницы. Без этого внешний документ загружался
  // в тот же WebContents и наследовал preload-мост к main-процессу.
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())

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

/**
 * Окно входа в банк.
 *
 * Принципиально отличается от окон приложения, и разница здесь — вопрос безопасности, а не стиля.
 *
 * 1. **Никакого preload.** Внутри загружается ЧУЖАЯ страница — сайт банка. Дать ей мост к
 *    main-процессу значит отдать приложение целиком. Поэтому preload не подключается вовсе.
 * 2. **Свой раздел сессии.** `persist:<банк>` — куки живут отдельно и от главного окна, и от
 *    других банков, и переживают перезапуск: ради этого всё и затевалось.
 * 3. **Навигация РАЗРЕШЕНА.** Окнам приложения она запрещена (SPA не должна уходить со своей
 *    страницы), а банку без неё не войти: там переходы, редиректы и СМС-подтверждение.
 * 4. **CSP приложения сюда не достаёт** — она висит на `session.defaultSession`, а это другая
 *    сессия. И правильно: наша политика сломала бы сайт банка.
 */
export function createBankWindow(partition: string, url: string, title: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon: ICON,
    webPreferences: {
      ...HARDENED,
      partition
    }
  })

  win.on('ready-to-show', () => win.show())
  // Всплывающие окна банка (подтверждения, помощь) открываются в браузере ОС, а не внутри:
  // новое окно унаследовало бы этот же раздел, и уследить за ним было бы нельзя.
  win.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  void win.loadURL(url)
  return win
}
