// Сессии банков внутри самого Argus.
//
// Раньше остаток Т-Банка читался из кук чужого браузера. Это работало, но означало, что
// приложение не самостоятельно: без установленного и залогиненного Brave финансы пусты. Владелец
// сформулировал требование прямо — «пользователь не должен ничего скачивать, даже браузер».
//
// Отдельная сборка Chromium для этого не нужна и не помогла бы: Electron — это уже Chromium.
// Нужно ровно одно — ПОСТОЯННЫЙ раздел сессии (`persist:...`), в котором куки переживают
// перезапуск приложения. Вход выполняется один раз в окне внутри Argus, дальше запросы уходят из
// той же сессии, и внешний браузер не участвует вообще.
//
// Чего это НЕ чинит, и врать об этом нельзя: срок жизни сессии задаёт сервер банка. У Т-Банка это
// 15–25 минут простоя, и после смерти сессия молча не восстанавливается — проверено. Поэтому
// задача кода не «держать сессию вечно», а честно различать три разных состояния:
//   • входа никогда не было      → предложить войти;
//   • вход был, сессия истекла   → показать прошлую цифру с её возрастом и предложить войти;
//   • сети нет                   → не трогать ничего, это не про сессию.
// Раньше все три выглядели одинаково — как отсутствие данных.

import { net, session, type BrowserWindow } from 'electron'
import { createBankWindow } from '../windows'
import type { BankId } from '../../shared/banks'

export type { BankId }

export interface BankSite {
  /** Домен, чьи куки означают «вход выполнен». */
  domain: string
  /** Страница входа. */
  loginUrl: string
  title: string
  /** Кука, по наличию которой судим о сессии. */
  sessionCookie: string
}

export const BANKS: Record<BankId, BankSite> = {
  tbank: {
    domain: 'tbank.ru',
    loginUrl: 'https://www.tbank.ru/mybank/',
    title: 'Т-Банк — вход',
    sessionCookie: 'psid'
  },
  sber: {
    domain: 'sberbank.ru',
    loginUrl: 'https://online.sberbank.ru/',
    title: 'Сбербанк — вход',
    sessionCookie: 'SESSION'
  }
}

/** Раздел сессии банка. Отдельный у каждого: общий означал бы, что банки видят куки друг друга. */
export function partitionFor(bank: BankId): string {
  return `persist:bank-${bank}`
}

const windows = new Map<BankId, BrowserWindow>()

/** Кого позвать, когда вход состоялся. Ставится один раз при запуске (`ipc.ts`). */
let onLoggedIn: ((bank: BankId) => void) | null = null

export function setLoginListener(fn: (bank: BankId) => void): void {
  onLoggedIn = fn
}

/**
 * Открыть окно входа.
 *
 * Повторный вызов поднимает уже открытое окно, а не плодит новые: два окна одного банка — верный
 * способ войти в одном и обновлять из другого, недоумевая, почему не работает.
 */
export function openBankLogin(bank: BankId): void {
  const existing = windows.get(bank)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const site = BANKS[bank]
  const win = createBankWindow(partitionFor(bank), site.loginUrl, site.title, site.domain)
  windows.set(bank, win)
  win.on('closed', () => windows.delete(bank))

  // Вход считается состоявшимся, когда в разделе появилась кука сессии. Ждать этого от человека
  // («войдите, потом нажмите обновить») — значит переложить на него работу, которую видно из
  // кода: страница уже сменилась, кука уже есть.
  //
  // Слушаем смену адреса, а не одно событие загрузки: вход у банка — это цепочка переходов
  // (логин → СМС → кабинет), и кука появляется не на первом из них.
  let announced = false
  const check = (): void => {
    if (announced || win.isDestroyed()) return
    void hasBankSession(bank).then((logged) => {
      if (!logged || announced) return
      announced = true
      onLoggedIn?.(bank)
    })
  }
  win.webContents.on('did-navigate', check)
  win.webContents.on('did-navigate-in-page', check)
  win.webContents.on('did-finish-load', check)
}

/** Куки банка из СВОЕГО раздела. Наружу не отдаются — только в запрос того же банка. */
export async function bankCookies(bank: BankId): Promise<Record<string, string>> {
  const ses = session.fromPartition(partitionFor(bank))
  const list = await ses.cookies.get({ domain: BANKS[bank].domain })
  const out: Record<string, string> = {}
  for (const c of list) if (c.value && !out[c.name]) out[c.name] = c.value
  return out
}

/** Был ли вход в этом разделе. Не то же самое, что «сессия жива»: она могла истечь. */
export async function hasBankSession(bank: BankId): Promise<boolean> {
  const jar = await bankCookies(bank)
  return Boolean(jar[BANKS[bank].sessionCookie])
}

export interface BankResponse {
  ok: boolean
  status: number
  body: string
  /** Сеть не ответила — это НЕ отказ банка и не мёртвая сессия. */
  offline?: boolean
}

/**
 * Запрос из сессии банка.
 *
 * `net.request` с явной сессией сам подставляет её куки — руками их собирать не надо, и это
 * важно: собранный вручную заголовок неизбежно отстанет от того, что браузер реально хранит.
 */
export function bankRequest(bank: BankId, url: string, referer?: string): Promise<BankResponse> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url,
      session: session.fromPartition(partitionFor(bank)),
      useSessionCookies: true
    })
    req.setHeader('accept', 'application/json')
    if (referer) req.setHeader('referer', referer)

    const timer = setTimeout(() => {
      req.abort()
      resolve({ ok: false, status: 0, body: '', offline: true })
    }, 20_000)

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    req.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, status: 0, body: '', offline: true })
    })
    req.end()
  })
}
