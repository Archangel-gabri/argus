// Проверки, которые видны только на живом приложении.
//
// Всё это невозможно проверить ни модульно, ни компонентно: заголовок CSP выдаёт настоящая
// сессия Electron, состав моста существует только в контексте окна, а запрет навигации живёт
// в обработчиках webContents. `electronApp.evaluate()` выполняется в main-процессе, поэтому
// сюда же попадают инварианты, до которых через интерфейс не добраться.
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let userData = ''

test.beforeAll(async () => {
  // Свой каталог данных: настоящее хранилище владельца тест не трогает ни при каких условиях.
  userData = mkdtempSync(join(tmpdir(), 'argus-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: join(__dirname, '..'),
    // Политика безопасности контента ставится только в запакованном приложении (`is.dev` —
    // это `!app.isPackaged`). Флаг включает её и здесь, чтобы проверять настоящую, а не
    // догадываться по коду.
    env: { ...process.env, NODE_ENV: 'production', ARGUS_FORCE_CSP: '1' }
  })
})

test.afterAll(async () => {
  await app?.close()
  if (userData) rmSync(userData, { recursive: true, force: true })
})

test('приложение стартует и открывает ровно одно окно', async () => {
  const page = await app.firstWindow()
  expect(await page.title()).toBeTruthy()
  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  expect(count).toBe(1)
})

test('окно закалено: изоляция контекста включена, Node в renderer нет', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const prefs = (
      w.webContents as unknown as { getWebPreferences?: () => Record<string, boolean> }
    ).getWebPreferences?.()
    return {
      // getWebPreferences существует в рантайме, но отсутствует в публичных типах Electron.
      contextIsolation: prefs?.contextIsolation,
      nodeIntegration: prefs?.nodeIntegration,
      sandbox: prefs?.sandbox
    }
  })
  expect(prefs.contextIsolation).not.toBe(false)
  expect(prefs.nodeIntegration).not.toBe(true)
})

test('renderer не достаёт ни Node, ни ipcRenderer мимо моста', async () => {
  const page = await app.firstWindow()
  const reach = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    ipcRenderer: typeof (globalThis as Record<string, unknown>).ipcRenderer,
    api: typeof (globalThis as Record<string, unknown>).api
  }))
  // Мост есть — иначе приложение не работало бы; всё остальное быть не должно.
  expect(reach.api).toBe('object')
  expect(reach.require).toBe('undefined')
  expect(reach.ipcRenderer).toBe('undefined')
})

test('мост не отдаёт наружу ни одного секрета до разблокировки', async () => {
  const page = await app.firstWindow()
  // Хранилище ещё не создано: любой ответ о парке обязан быть пустым, а не «на всякий случай».
  const devices = await page.evaluate(() => (globalThis as never as { api: { devices: { list: () => Promise<unknown> } } }).api.devices.list())
  expect(devices).toEqual([])
})

test('навигация со страницы наружу заблокирована', async () => {
  const page = await app.firstWindow()
  const before = page.url()
  // Навигацию инициирует САМА СТРАНИЦА — только так срабатывает will-navigate. Программный
  // loadURL из main его не вызывает вовсе, и проверять им запрет бессмысленно.
  await page.evaluate(() => {
    window.location.href = 'https://example.com'
  })
  await new Promise((r) => setTimeout(r, 800))
  // Уход на внешний адрес означал бы, что чужая страница получает наш preload.
  expect(page.url()).toBe(before)
  expect(page.url()).not.toContain('example.com')
})

test('window.open наружу не создаёт окно', async () => {
  const page = await app.firstWindow()
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  await page.evaluate(() => {
    window.open('https://example.com', '_blank')
  })
  await new Promise((r) => setTimeout(r, 800))
  const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  // Внешние ссылки уходят в системный браузер, а не в окно с нашим мостом.
  expect(after).toBe(before)
})

test('запросы разрешений браузера отклоняются', async () => {
  const page = await app.firstWindow()
  const granted = await page.evaluate(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      return true
    } catch {
      return false
    }
  })
  // Камеру и микрофон Argus получает только через проверяемый IPC, не через Chromium.
  expect(granted).toBe(false)
})

test('строгая CSP реально применена: инлайновый скрипт не выполняется', async () => {
  const page = await app.firstWindow()
  // Проверяем ФАКТ применения политики, а не наличие заголовка: заголовок можно поставить
  // и неверный, а вот выполнившийся инлайновый скрипт — это уже доказанная дыра.
  const inlineRan = await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'globalThis.__argusInlineRan = true'
    document.head.appendChild(s)
    return Boolean((globalThis as Record<string, unknown>).__argusInlineRan)
  })
  expect(inlineRan).toBe(false)
})

test('CSP отдаётся заголовком и разрешает только свой источник', async () => {
  const page = await app.firstWindow()
  const csp = await page.evaluate(async () => {
    const r = await fetch(window.location.href)
    return r.headers.get('content-security-policy')
  })
  expect(csp).toBeTruthy()
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("script-src 'self'")
  // Главное окно НЕ должно получать послабление, сделанное для окна трансляции.
  expect(csp).not.toMatch(/connect-src[^;]*\swss:(\s|;|$)/)
})
